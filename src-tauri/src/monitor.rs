//! PANE MONITOR — watch a tmux session (an oracle's work surface) and push
//! WhatsApp updates to firaz when it finishes a task or hits notable output.
//!
//! One cockpit click → `monitor_start(socket, session)` spawns a background
//! watcher thread that polls `tmux capture-pane` every ~15s. It tracks the
//! visible pane text and detects two kinds of events:
//!
//!   * task done / went idle — output had been changing, then stayed identical
//!     for ~2 consecutive checks (≈30s) → "✅ <session> looks done …".
//!   * error signal — fresh output contains error/panic/failed/Traceback that
//!     wasn't in the prior snapshot → "⚠️ <session> hit an error …".
//!
//! Each event fires a WhatsApp message through the AIOS bridge `push.js`
//! (fire-and-forget, prefixed `[cockpit monitor]`), with anti-spam guards:
//! at most one "done" per idle period (re-armed only when activity resumes) and
//! a 60s minimum gap between messages per session.
//!
//! MASTER AWARENESS — so the master oracle / bridge always knows what the
//! cockpit is watching:
//!   * `~/.aios/state/cockpit-monitors.json` — the live array of monitored
//!     sessions, rewritten on every start/stop.
//!   * `~/.aios/state/cockpit-monitor-events.jsonl` — one line per WA
//!     notification, an append-only audit log.
//!
//! State lives in a module-level `OnceLock<Mutex<HashMap<…>>>` (no managed Tauri
//! state, so `lib.rs` stays untouched). The map value is a shared `keep-running`
//! flag the watcher checks each loop — `monitor_stop` flips it false so the
//! thread exits cleanly on its next tick.
//!
//! Fully defensive: tmux/file/exec failures never panic a thread — it just
//! continues (or exits when the flag clears). Mirrors the style of
//! `oracles.rs` / `bridges.rs`. No new deps (std + serde_json + chrono).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::json;

/// Poll cadence for the watcher loop.
const POLL_INTERVAL: Duration = Duration::from_secs(15);

/// How many consecutive identical polls (after a change) count as "went idle".
/// 2 polls ≈ 30s of no movement.
const IDLE_POLLS: u32 = 2;

/// Minimum gap between WhatsApp messages per session (anti-spam).
const MIN_NOTIFY_GAP: Duration = Duration::from_secs(60);

/// Lowercase substrings that flag an error in fresh pane output.
const ERROR_NEEDLES: &[&str] = &["error", "panic", "failed", "traceback"];

/// The registry of live watchers: session name → its keep-running flag.
/// Setting the flag to `false` tells that watcher thread to exit.
static MONITORS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn monitors() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    MONITORS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `$HOME`, or `/` as a last resort.
fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// Resolves a usable `tmux` binary — GUI apps inherit a minimal PATH, so prefer
/// known locations before falling back to bare `tmux`.
fn tmux_bin() -> String {
    #[cfg(unix)]
    {
        for candidate in ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"] {
            if std::path::Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
    }
    "tmux".to_string()
}

/// Resolves the AIOS bridge `push.js`, probing known locations in order. Returns
/// the first that exists, or `None` if neither is present.
fn push_script() -> Option<String> {
    let home = home();
    let candidates = [
        format!("{home}/Repo/firaz/aios/bridge/scripts/push.js"),
        format!("{home}/Repo/firaz/aios-bridge/scripts/push.js"),
    ];
    candidates.into_iter().find(|p| std::path::Path::new(p).exists())
}

// ════════════════════════════════════════════════════════════════════════
// WhatsApp delivery + event log (both best-effort, never panic)
// ════════════════════════════════════════════════════════════════════════

/// Fires a WhatsApp message through the bridge `push.js`, fire-and-forget. Every
/// message is prefixed `[cockpit monitor]`. Failures are swallowed (the script
/// missing, node absent, spawn error) — monitoring must never crash on a send.
fn send_whatsapp(message: &str) {
    let body = format!("[cockpit monitor] {message}");
    let Some(script) = push_script() else { return };
    // The scripts are +x; prefer invoking via `node` for robustness against a
    // bare PATH (GUI apps don't inherit the user's node), falling back to the
    // script directly if node isn't resolvable.
    let node = node_bin();
    let spawn = match node {
        Some(n) => std::process::Command::new(n).arg(&script).arg(&body).spawn(),
        None => std::process::Command::new(&script).arg(&body).spawn(),
    };
    // Detach: we never wait on the child — fire-and-forget.
    let _ = spawn;
}

/// Resolves a `node` binary. GUI PATH is minimal, so probe nvm/Homebrew/system
/// before giving up (in which case we exec the +x script directly).
pub(crate) fn node_bin() -> Option<String> {
    #[cfg(unix)]
    {
        // Common fixed locations first.
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if std::path::Path::new(candidate).exists() {
                return Some(candidate.to_string());
            }
        }
        // nvm: pick the newest version dir that has a node binary.
        let nvm = format!("{}/.nvm/versions/node", home());
        if let Ok(entries) = std::fs::read_dir(&nvm) {
            let mut versions: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path().join("bin/node"))
                .filter(|p| p.exists())
                .filter_map(|p| p.to_str().map(|s| s.to_string()))
                .collect();
            versions.sort();
            if let Some(latest) = versions.pop() {
                return Some(latest);
            }
        }
    }
    None
}

/// Appends one event line to `~/.aios/state/cockpit-monitor-events.jsonl`.
/// Best-effort — a missing dir / write failure is silently ignored.
fn log_event(session: &str, kind: &str, message: &str) {
    use std::io::Write;
    let path = format!("{}/.aios/state/cockpit-monitor-events.jsonl", home());
    let ts = chrono::Utc::now().to_rfc3339();
    let line = json!({
        "ts": ts,
        "session": session,
        "kind": kind,
        "message": message,
    });
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

/// Rewrites `~/.aios/state/cockpit-monitors.json` from the current registry, so
/// the master oracle / bridge can see what the cockpit is watching. We don't
/// track per-session socket/started_at in the flag map, so this function takes
/// the full descriptor list to serialize. Best-effort.
fn write_registry(entries: &[MonitorEntry]) {
    let path = format!("{}/.aios/state/cockpit-monitors.json", home());
    let arr: Vec<_> = entries
        .iter()
        .map(|e| {
            json!({
                "session": e.session,
                "socket": e.socket,
                "started_at": e.started_at,
            })
        })
        .collect();
    if let Ok(text) = serde_json::to_string_pretty(&json!(arr)) {
        let _ = std::fs::write(&path, text);
    }
}

/// A descriptor for one monitored session, used only to (re)write the registry
/// file. The in-memory source of truth is a separate static so a live read of
/// the registry never blocks the watcher's flag map.
#[derive(Clone)]
struct MonitorEntry {
    session: String,
    socket: String,
    started_at: String,
}

/// Side registry of descriptors, kept in lock-step with `MONITORS` so we can
/// rewrite `cockpit-monitors.json` with socket + start time on every change.
static ENTRIES: OnceLock<Mutex<Vec<MonitorEntry>>> = OnceLock::new();

fn entries() -> &'static Mutex<Vec<MonitorEntry>> {
    ENTRIES.get_or_init(|| Mutex::new(Vec::new()))
}

/// Rewrites the registry file from the current descriptor list under lock.
fn sync_registry_file() {
    let guard = entries().lock();
    write_registry(&guard);
}

// ════════════════════════════════════════════════════════════════════════
// the watcher thread
// ════════════════════════════════════════════════════════════════════════

/// Captures the current visible pane text of `session` on `socket`. Returns
/// `None` on any tmux failure (session gone, tmux missing, non-zero exit).
fn capture_pane(socket: &str, session: &str) -> Option<String> {
    let out = std::process::Command::new(tmux_bin())
        .args(["-L", socket, "capture-pane", "-p", "-t", session])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// The last ~`n` non-empty lines of a pane snapshot, joined with newlines.
fn last_nonempty_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().map(|l| l.trim_end()).filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Returns the lines present in `current` that look like errors AND weren't in
/// `prior` — i.e. freshly-appeared error output. Case-insensitive needle match.
fn fresh_error_lines(prior: &str, current: &str) -> Vec<String> {
    use std::collections::HashSet;
    let prior_set: HashSet<&str> = prior.lines().map(|l| l.trim()).collect();
    current
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !prior_set.contains(l))
        .filter(|l| {
            let low = l.to_lowercase();
            ERROR_NEEDLES.iter().any(|n| low.contains(n))
        })
        .map(|l| l.to_string())
        .collect()
}

/// The per-session watcher loop. Runs on its own std::thread until the shared
/// `keep` flag goes false (set by `monitor_stop`) or the session disappears for
/// too long. Every branch is defensive — no failure escapes as a panic.
fn watch_loop(socket: String, session: String, keep: Arc<AtomicBool>) {
    // Announce.
    send_whatsapp(&format!("now watching {session}"));
    log_event(&session, "start", &format!("now watching {session}"));

    // Snapshot tracking.
    let mut last_snapshot: Option<String> = None;
    // Consecutive identical polls AFTER a change was observed.
    let mut idle_polls: u32 = 0;
    // True once we've sent a "done" for the current idle period — re-armed when
    // activity resumes.
    let mut done_sent = false;
    // Whether we've seen the pane change at least once (so a never-moving idle
    // pane on startup doesn't immediately fire "done").
    let mut seen_change = false;
    // Throttle: when the last WA message went out.
    let mut last_notify: Option<Instant> = None;

    // How many consecutive captures returned nothing (session gone). After a
    // few, exit the thread — the session is dead.
    let mut missing_captures: u32 = 0;

    loop {
        if !keep.load(Ordering::Relaxed) {
            break;
        }

        match capture_pane(&socket, &session) {
            Some(current) => {
                missing_captures = 0;
                let changed = match &last_snapshot {
                    Some(prev) => prev != &current,
                    None => false, // first capture establishes the baseline
                };

                // Error detection — fresh error lines vs the prior snapshot.
                if let Some(prev) = &last_snapshot {
                    let errs = fresh_error_lines(prev, &current);
                    if !errs.is_empty() && may_notify(&last_notify) {
                        let body = format!(
                            "⚠️ {session} hit an error:\n{}",
                            last_few(&errs, 6)
                        );
                        send_whatsapp(&body);
                        log_event(&session, "error", &body);
                        last_notify = Some(Instant::now());
                    }
                }

                if changed {
                    // Activity resumed → reset idle tracking + re-arm "done".
                    seen_change = true;
                    idle_polls = 0;
                    done_sent = false;
                } else if last_snapshot.is_some() {
                    // No change this tick.
                    if seen_change {
                        idle_polls += 1;
                        if idle_polls >= IDLE_POLLS && !done_sent && may_notify(&last_notify) {
                            let tail = last_nonempty_lines(&current, 6);
                            let body = format!("✅ {session} looks done — last output:\n{tail}");
                            send_whatsapp(&body);
                            log_event(&session, "done", &body);
                            last_notify = Some(Instant::now());
                            done_sent = true;
                        }
                    }
                }

                last_snapshot = Some(current);
            }
            None => {
                missing_captures += 1;
                // Session has been uncapturable for ~45s — assume it's gone and
                // tear this watcher down so we don't leak a thread.
                if missing_captures >= 3 {
                    log_event(&session, "gone", &format!("{session} no longer capturable; stopping watcher"));
                    break;
                }
            }
        }

        // Sleep in short slices so a stop is honored within ~1s rather than the
        // full poll interval.
        let mut slept = Duration::ZERO;
        while slept < POLL_INTERVAL {
            if !keep.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
            slept += Duration::from_millis(500);
        }
    }

    // Self-cleanup: if the loop exited on its own (session gone), drop ourselves
    // from the registries so state stays accurate.
    cleanup_session(&session);
}

/// True when enough time has elapsed since the last notification (anti-spam).
fn may_notify(last: &Option<Instant>) -> bool {
    match last {
        Some(t) => t.elapsed() >= MIN_NOTIFY_GAP,
        None => true,
    }
}

/// Joins the last `n` of `lines` with newlines (for compact WA bodies).
fn last_few(lines: &[String], n: usize) -> String {
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Removes a session from both registries + rewrites the state file. Safe to
/// call whether or not the session is present.
fn cleanup_session(session: &str) {
    {
        let mut map = monitors().lock();
        map.remove(session);
    }
    {
        let mut ents = entries().lock();
        ents.retain(|e| e.session != session);
    }
    sync_registry_file();
}

// ════════════════════════════════════════════════════════════════════════
// Tauri commands
// ════════════════════════════════════════════════════════════════════════

/// Starts a background watcher for `session` on tmux `socket`. No-op (Ok) if a
/// watcher for that session already exists. Spawns a detached std::thread that
/// polls the pane and pushes WhatsApp updates; registers a keep-running flag so
/// `monitor_stop` can tear it down.
#[tauri::command]
pub fn monitor_start(socket: String, session: String) -> Result<(), String> {
    let socket = socket.trim().to_string();
    let session = session.trim().to_string();
    if session.is_empty() {
        return Err("session must not be empty".into());
    }
    let socket = if socket.is_empty() { "adletic".to_string() } else { socket };

    // Already monitoring → no-op.
    {
        let map = monitors().lock();
        if map.contains_key(&session) {
            return Ok(());
        }
    }

    let keep = Arc::new(AtomicBool::new(true));
    {
        let mut map = monitors().lock();
        map.insert(session.clone(), keep.clone());
    }
    {
        let mut ents = entries().lock();
        ents.retain(|e| e.session != session);
        ents.push(MonitorEntry {
            session: session.clone(),
            socket: socket.clone(),
            started_at: chrono::Utc::now().to_rfc3339(),
        });
    }
    sync_registry_file();

    let t_socket = socket.clone();
    let t_session = session.clone();
    let spawned = std::thread::Builder::new()
        .name(format!("monitor-{session}"))
        .spawn(move || watch_loop(t_socket, t_session, keep));

    if spawned.is_err() {
        // Roll back registration if the thread couldn't start.
        cleanup_session(&session);
        return Err("failed to spawn watcher thread".into());
    }
    Ok(())
}

/// Stops the watcher for `session`: flips its keep-running flag false (the thread
/// exits on its next slice) and drops it from the registries + state file. No-op
/// (Ok) if it wasn't being monitored. Sends a closing WhatsApp note.
#[tauri::command]
pub fn monitor_stop(session: String) -> Result<(), String> {
    let session = session.trim().to_string();
    if session.is_empty() {
        return Err("session must not be empty".into());
    }

    let flag = {
        let mut map = monitors().lock();
        map.remove(&session)
    };

    match flag {
        Some(keep) => {
            keep.store(false, Ordering::Relaxed);
            {
                let mut ents = entries().lock();
                ents.retain(|e| e.session != session);
            }
            sync_registry_file();
            send_whatsapp(&format!("stopped watching {session}"));
            log_event(&session, "stop", &format!("stopped watching {session}"));
            Ok(())
        }
        None => Ok(()), // wasn't monitored — idempotent stop
    }
}

/// Returns the session names currently being monitored, so the UI can reflect
/// state (which panes have a live watcher).
#[tauri::command]
pub fn list_monitors() -> Vec<String> {
    let map = monitors().lock();
    let mut names: Vec<String> = map.keys().cloned().collect();
    names.sort();
    names
}
