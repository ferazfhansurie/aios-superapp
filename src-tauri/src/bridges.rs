//! CHANNELS dispatch surface — every messaging channel AIOS speaks through, and
//! for the live ones, are they connected/ALIVE and what's flowing through them.
//!
//! AIOS is a superapp hub: one place to dispatch, monitor, and reply across ALL
//! channels — WhatsApp, Instagram, Threads, Google Chat, X/Twitter, Telegram,
//! Gmail, iMessage, and more. Each channel is a `ChannelProbe` descriptor;
//! `channel_probes()` returns the roster. Adding a channel = pushing one more.
//!
//! WhatsApp is the proof — fully detected. For it (and any future fully-wired
//! channel) we probe THREE read-only macOS sources, each independently
//! best-effort — any source failing yields an empty field, never an error for
//! the whole call:
//!
//!   1. process liveness — `/bin/ps -axo pid,etime,command`, matched against a
//!      set of command substrings (e.g. `inbox-worker`, `push.js`,
//!      `meta-webhook`, `aios-bridge`/`aios/bridge`). First match gives pid +
//!      elapsed time (uptime).
//!   2. launchd — `/bin/launchctl list` lines whose label matches `*bridge*`
//!      → loaded + running (has a live pid).
//!   3. activity log — the first existing `outbound-log.jsonl` from a probe
//!      list. From it: total line count (≈ messages sent), the timestamp of the
//!      LAST entry (parsed from a `ts`/`timestamp`/`time` field), "X ago", and
//!      today's entry count.
//!
//! Every channel carries a `status`:
//!   - `connected`    — wired + reachable (a live proc / running launchd / log).
//!   - `disconnected` — known connector, but nothing alive right now.
//!   - `soon`         — connector not built yet (the honest default).
//!
//! Channels marked `soon` (or with no detectable footprint) return null stats —
//! we don't fabricate liveness for connectors that don't exist yet.
//!
//! Mirrors the clean, commented style of `oracles.rs` / `automations.rs`. No new
//! deps: `chrono` for timestamp math, `serde_json` for the output shape.

use serde_json::{json, Value};

/// `$HOME`, or `/` as a last resort.
fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// The bridge's personal-WA pairing script (wwebjs, 8-digit pairing code).
const CONNECT_PERSONAL_CANDIDATES: &[&str] = &[
    "Repo/firaz/aios/bridge/scripts/connect-personal-code.js",
    "Repo/firaz/aios-bridge/scripts/connect-personal-code.js",
];

/// Pairs firaz's PERSONAL WhatsApp (the wwebjs session used by `send-as-personal`
/// / the "personal" channel). Spawns `connect-personal-code.js`, waits for the
/// linking screen to render + the 8-digit pairing code, and returns it. The
/// node process is LEFT RUNNING so pairing completes once firaz enters the code
/// (WhatsApp → Linked Devices → Link with phone number). On timeout the child is
/// killed so we don't leak a wwebjs client.
#[tauri::command]
pub fn pair_personal_wa() -> Value {
    let Some(script) = resolve_log(CONNECT_PERSONAL_CANDIDATES) else {
        return json!({ "ok": false, "error": "connect-personal-code.js not found under ~/Repo/firaz/aios/bridge (or aios-bridge)." });
    };

    let mut child = match std::process::Command::new("node")
        .arg(&script)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": format!("couldn't spawn node: {e} (is node on PATH?)") }),
    };

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return json!({ "ok": false, "error": "couldn't capture pairing script output" });
    };

    // Read stdout on a thread; the main path waits with a timeout so a hung
    // wwebjs boot can't block the UI thread forever.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(idx) = line.find("pairing code:") {
                let code = line[idx + "pairing code:".len()..].trim().to_string();
                let _ = tx.send(code);
                return;
            }
        }
    });

    // wwebjs boots a headless chromium before it can cut a code — give it room.
    match rx.recv_timeout(std::time::Duration::from_secs(90)) {
        Ok(code) => json!({ "ok": true, "code": code }),
        Err(_) => {
            let _ = child.kill();
            json!({
                "ok": false,
                "error": "timed out waiting for a pairing code. check the bridge .env (OWNER_PHONE set to your personal number) and try again.",
            })
        }
    }
}

/// How hard a channel's connector is wired, which drives how we detect it.
#[derive(Clone, Copy, PartialEq)]
enum Wiring {
    /// Fully built connector — run the full 3-source probe (proc + launchd +
    /// log). Resolves to `connected` (alive) / `disconnected` (a footprint but
    /// nothing live) — but never `soon`. WhatsApp today.
    Live,
    /// Connector not built. Still does a *light* best-effort footprint check
    /// (any matching launchd job, or any candidate log present) so that if a
    /// connector quietly lands later it lights up on its own — otherwise the
    /// channel honestly reports `soon` with null stats.
    Soon,
}

/// Static descriptor for one channel. Add a channel = add one of these to
/// `channel_probes()` — everything downstream maps over the list uniformly.
struct ChannelProbe {
    /// Stable slug, e.g. `whatsapp`.
    id: &'static str,
    /// Human label shown on the card, e.g. `whatsapp`.
    name: &'static str,
    /// Channel type chip, e.g. `whatsapp`, `dm`, `email`, `chat`.
    kind: &'static str,
    /// How wired the connector is — drives detection + the floor status.
    wiring: Wiring,
    /// Command substrings that identify the channel's process(es) in `ps`
    /// output. First matching process wins (pid + uptime).
    proc_match: &'static [&'static str],
    /// Substring a `launchctl list` LABEL must contain to count as this
    /// channel's job (matched case-insensitively against `*bridge*`-style
    /// labels for the live ones; used as a loose footprint hint otherwise).
    launchd_match: &'static str,
    /// Candidate activity-log paths (relative to `$HOME` if not absolute),
    /// probed in order — first that exists is used.
    log_candidates: &'static [&'static str],
}

/// The roster of channels AIOS speaks through. WhatsApp is the live proof; the
/// rest are connectors on the way — push more / promote to `Wiring::Live` as
/// they get built.
fn channel_probes() -> Vec<ChannelProbe> {
    vec![
        // ── live, fully-detected proof ──────────────────────────────────────
        ChannelProbe {
            id: "whatsapp",
            name: "whatsapp",
            kind: "messaging",
            wiring: Wiring::Live,
            proc_match: &["inbox-worker", "push.js", "meta-webhook", "aios-bridge", "aios/bridge"],
            launchd_match: "bridge",
            log_candidates: &[
                "Repo/firaz/aios/bridge/scripts/outbound-log.jsonl",
                "Repo/firaz/aios-bridge/scripts/outbound-log.jsonl",
                ".aios/state/outbound-log.jsonl",
            ],
        },
        // ── connectors on the way (light footprint check, else `soon`) ──────
        ChannelProbe {
            id: "instagram",
            name: "instagram",
            kind: "dm",
            wiring: Wiring::Soon,
            proc_match: &[],
            launchd_match: "instagram",
            log_candidates: &[".aios/state/instagram-log.jsonl"],
        },
        ChannelProbe {
            id: "threads",
            name: "threads",
            kind: "social",
            wiring: Wiring::Soon,
            proc_match: &[],
            launchd_match: "threads",
            log_candidates: &[".aios/state/threads-log.jsonl"],
        },
        ChannelProbe {
            id: "gchat",
            name: "google chat",
            kind: "chat",
            wiring: Wiring::Soon,
            proc_match: &[],
            launchd_match: "gchat",
            log_candidates: &[".aios/state/gchat-log.jsonl"],
        },
        ChannelProbe {
            id: "x",
            name: "x / twitter",
            kind: "social",
            wiring: Wiring::Soon,
            proc_match: &[],
            launchd_match: "twitter",
            log_candidates: &[".aios/state/x-log.jsonl"],
        },
        ChannelProbe {
            id: "telegram",
            name: "telegram",
            kind: "messaging",
            wiring: Wiring::Soon,
            proc_match: &[],
            launchd_match: "telegram",
            log_candidates: &[".aios/state/telegram-log.jsonl"],
        },
        ChannelProbe {
            id: "gmail",
            name: "gmail",
            kind: "email",
            wiring: Wiring::Soon,
            proc_match: &[],
            launchd_match: "gmail",
            log_candidates: &[".aios/state/gmail-log.jsonl"],
        },
        ChannelProbe {
            id: "imessage",
            name: "imessage",
            kind: "messaging",
            wiring: Wiring::Soon,
            proc_match: &[],
            launchd_match: "imessage",
            log_candidates: &[".aios/state/imessage-log.jsonl"],
        },
    ]
}

// ════════════════════════════════════════════════════════════════════════
// 1. process liveness
// ════════════════════════════════════════════════════════════════════════

/// One matched bridge process: pid + a humanized uptime.
struct ProcHit {
    pid: i64,
    uptime: String,
}

/// Runs `ps -axo pid,etime,command` and returns the first process whose command
/// contains any of `needles`. Best-effort → `None` on any failure / no match.
fn find_process(needles: &[&str]) -> Option<ProcHit> {
    if needles.is_empty() {
        return None;
    }
    #[cfg(unix)]
    {
        let out = std::process::Command::new("/bin/ps")
            .args(["-axo", "pid,etime,command"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines().skip(1) {
            // Columns: PID ELAPSED COMMAND… — split off the first two tokens,
            // the rest (which may contain spaces) is the command.
            let trimmed = line.trim_start();
            let mut it = trimmed.splitn(3, char::is_whitespace);
            let pid_raw = it.next().unwrap_or("");
            let etime_raw = it.next().unwrap_or("");
            let command = it.next().unwrap_or("");
            if command.is_empty() {
                continue;
            }
            // Don't match our own grep/probe or other false positives — require
            // the needle in the COMMAND portion only.
            if needles.iter().any(|n| command.contains(n)) {
                let Ok(pid) = pid_raw.parse::<i64>() else { continue };
                return Some(ProcHit { pid, uptime: humanize_etime(etime_raw) });
            }
        }
        None
    }

    #[cfg(not(unix))]
    {
        let _ = needles;
        None
    }
}

/// Converts a `ps` ETIME field (`[[dd-]hh:]mm:ss`) into "3h 12m" / "12m" /
/// "5d 3h" / "<1m". Unparseable → the raw string trimmed.
fn humanize_etime(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    // Split optional "dd-" day prefix.
    let (days, hms) = match raw.split_once('-') {
        Some((d, rest)) => (d.parse::<i64>().unwrap_or(0), rest),
        None => (0, raw),
    };
    // hms is one of mm:ss or hh:mm:ss.
    let parts: Vec<i64> = hms.split(':').map(|p| p.parse::<i64>().unwrap_or(0)).collect();
    let (hours, mins) = match parts.len() {
        3 => (parts[0], parts[1]),
        2 => (0, parts[0]),
        _ => return raw.to_string(),
    };
    let total_h = days * 24 + hours;
    if days > 0 {
        format!("{days}d {hours}h")
    } else if total_h > 0 {
        format!("{total_h}h {mins}m")
    } else if mins > 0 {
        format!("{mins}m")
    } else {
        "<1m".into()
    }
}

// ════════════════════════════════════════════════════════════════════════
// 2. launchd
// ════════════════════════════════════════════════════════════════════════

/// launchd state for a bridge: `(label, loaded, running)`.
struct LaunchdHit {
    label: String,
    running: bool,
}

/// Runs `launchctl list` and finds the first job whose label contains the
/// channel's `launchd_match` substring (case-insensitively). For WhatsApp the
/// needle is `bridge`, which still matches its `*aios-bridge*` labels; for other
/// channels it's the connector slug (e.g. `telegram`). `running` = it has a live
/// pid (not `-`). Best-effort → `None`.
fn find_launchd(needle: &str) -> Option<LaunchdHit> {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("/bin/launchctl").arg("list").output();
        let out = match output {
            Ok(o) if o.status.success() => o,
            _ => std::process::Command::new("launchctl").arg("list").output().ok()?,
        };
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let needle_l = needle.to_lowercase();
        if needle_l.is_empty() {
            return None;
        }
        // Columns: PID(or `-`)\tEXIT\tLABEL. Skip the header line.
        for line in text.lines().skip(1) {
            let mut cols = line.split('\t');
            let pid_raw = cols.next().unwrap_or("-").trim();
            let _exit = cols.next();
            let label = cols.next().unwrap_or("").trim();
            let label_l = label.to_lowercase();
            if label.is_empty() || !label_l.contains(&needle_l) {
                continue;
            }
            let running = pid_raw != "-" && pid_raw.parse::<i64>().is_ok();
            return Some(LaunchdHit { label: label.to_string(), running });
        }
        None
    }

    #[cfg(not(unix))]
    {
        let _ = needle;
        None
    }
}

// ════════════════════════════════════════════════════════════════════════
// 3. activity log
// ════════════════════════════════════════════════════════════════════════

/// Parsed activity from a bridge's outbound log.
struct LogStats {
    path: String,
    messages_total: i64,
    last_activity: Option<String>,
    last_activity_ago: Option<String>,
    today: Option<i64>,
}

/// Resolves the first existing candidate path (absolute, or relative to HOME).
fn resolve_log(candidates: &[&str]) -> Option<String> {
    let home = home();
    for cand in candidates {
        let path = if cand.starts_with('/') {
            cand.to_string()
        } else {
            format!("{home}/{cand}")
        };
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }
    None
}

/// Reads the outbound log: total lines (≈ messages), last entry's timestamp,
/// "X ago", and today's count. Best-effort — a missing/garbage log yields the
/// counts it can and `None` for the rest.
fn read_log(candidates: &[&str]) -> Option<LogStats> {
    let path = resolve_log(candidates)?;
    let Ok(text) = std::fs::read_to_string(&path) else {
        // Path existed but unreadable — still surface it with empty data.
        return Some(LogStats {
            path,
            messages_total: 0,
            last_activity: None,
            last_activity_ago: None,
            today: None,
        });
    };

    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let messages_total = lines.len() as i64;

    // Last entry's timestamp — parse the last JSON line, try a few key names.
    let mut last_activity = None;
    let mut last_activity_ago = None;
    if let Some(last) = lines.last() {
        if let Some(ts) = extract_timestamp(last) {
            last_activity = Some(format_local(&ts));
            last_activity_ago = humanize_ago(&ts);
        }
    }

    // Today's count — compare each entry's local date to today's local date.
    let today_str = chrono::Local::now().format("%Y-%m-%d").to_string();
    let today = lines
        .iter()
        .filter(|l| {
            extract_timestamp(l)
                .map(|ts| ts.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string() == today_str)
                .unwrap_or(false)
        })
        .count() as i64;

    Some(LogStats {
        path,
        messages_total,
        last_activity,
        last_activity_ago,
        today: Some(today),
    })
}

/// Pulls a timestamp out of a JSON log line, trying common key names
/// (`ts`/`timestamp`/`time`/`date`/`at`), and parses it as RFC3339. Falls back
/// to a Unix epoch (seconds or millis) if the value is numeric.
fn extract_timestamp(line: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = v.as_object()?;
    let raw = obj
        .get("ts")
        .or_else(|| obj.get("timestamp"))
        .or_else(|| obj.get("time"))
        .or_else(|| obj.get("date"))
        .or_else(|| obj.get("at"))?;

    // String → RFC3339 / ISO 8601.
    if let Some(s) = raw.as_str() {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
            return Some(dt.with_timezone(&chrono::Utc));
        }
    }
    // Number → epoch seconds or millis.
    if let Some(n) = raw.as_i64() {
        let (secs, nanos) = if n > 100_000_000_000 {
            (n / 1000, ((n % 1000) * 1_000_000) as u32)
        } else {
            (n, 0)
        };
        if let chrono::LocalResult::Single(dt) = chrono::TimeZone::timestamp_opt(&chrono::Utc, secs, nanos) {
            return Some(dt);
        }
    }
    None
}

/// Renders a UTC instant as local "YYYY-MM-DD HH:MM".
fn format_local(ts: &chrono::DateTime<chrono::Utc>) -> String {
    ts.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string()
}

/// "4m" / "3h" / "2d" since `ts`, or `None` if in the future / unparseable.
fn humanize_ago(ts: &chrono::DateTime<chrono::Utc>) -> Option<String> {
    let now = chrono::Utc::now();
    let delta = now.signed_duration_since(*ts);
    let secs = delta.num_seconds();
    if secs < 0 {
        return None;
    }
    Some(if secs < 60 {
        "<1m".into()
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    })
}

// ════════════════════════════════════════════════════════════════════════
// assembly
// ════════════════════════════════════════════════════════════════════════

/// Probes a single channel across all three sources and returns its descriptor.
/// For `Wiring::Live` channels (WhatsApp) we trust the full probe and resolve
/// `connected`/`disconnected`. For `Wiring::Soon` channels we do only a light
/// footprint check — if a connector quietly lands (a matching launchd job or a
/// candidate log shows up) we promote it, otherwise it honestly reports `soon`
/// with null stats.
fn probe_channel(p: &ChannelProbe) -> Value {
    let proc_hit = find_process(p.proc_match);
    let launchd_hit = find_launchd(p.launchd_match);
    let log = read_log(p.log_candidates);

    // ALIVE = a live process, OR launchd reports it running.
    let alive = proc_hit.is_some() || launchd_hit.as_ref().map(|l| l.running).unwrap_or(false);
    // Any footprint at all — a loaded job (even if not running) or a present log.
    let has_footprint = launchd_hit.is_some() || log.is_some();

    // status: the channel's headline state.
    //   Live  → connected when alive, else disconnected (footprint but no proc).
    //   Soon  → promote to connected/disconnected only if a footprint surfaced,
    //           otherwise the honest `soon`.
    let status = match p.wiring {
        Wiring::Live => {
            if alive {
                "connected"
            } else {
                "disconnected"
            }
        }
        Wiring::Soon => {
            if alive {
                "connected"
            } else if has_footprint {
                "disconnected"
            } else {
                "soon"
            }
        }
    };

    let pid = proc_hit.as_ref().map(|h| h.pid);
    let uptime = proc_hit
        .as_ref()
        .map(|h| h.uptime.clone())
        .filter(|u| !u.is_empty());

    let launchd = launchd_hit.as_ref().map(|l| l.label.clone());
    let loaded = launchd_hit.is_some();

    let (messages_total, last_activity, last_activity_ago, today, log_path) = match &log {
        Some(s) => (
            Some(s.messages_total),
            s.last_activity.clone(),
            s.last_activity_ago.clone(),
            s.today,
            Some(s.path.clone()),
        ),
        None => (None, None, None, None, None),
    };

    json!({
        "id": p.id,
        "name": p.name,
        "kind": p.kind,
        "status": status,
        "alive": alive,
        "pid": pid,
        "uptime": uptime,
        "launchd": launchd,
        "loaded": loaded,
        "messagesTotal": messages_total,
        "lastActivity": last_activity,
        "lastActivityAgo": last_activity_ago,
        "today": today,
        "logPath": log_path,
    })
}

/// Lists every channel AIOS speaks through, with `status` + (for the live ones)
/// health + recent activity. The whole call is best-effort: each source
/// per-channel fails soft to an empty field, never an error.
///
/// Returns `{ "bridges": [ … ] }` — the key is kept as `bridges` for backward
/// compat (the command is still `list_bridges`, registered in `lib.rs`). The
/// frontend reads each entry's `status` to drive the channels view.
#[tauri::command]
pub fn list_bridges() -> Value {
    let channels: Vec<Value> = channel_probes().iter().map(probe_channel).collect();
    json!({ "bridges": channels })
}

// ════════════════════════════════════════════════════════════════════════
// 4. activity feed — the actual messages flowing through a bridge
// ════════════════════════════════════════════════════════════════════════

/// Candidate INBOUND/conversation logs to merge into the feed, probed in order.
/// These complement the outbound log so the feed can show both sides when a
/// matching inbound source exists. Best-effort — missing files are skipped.
fn inbound_candidates(id: &str) -> &'static [&'static str] {
    match id {
        "whatsapp" => &[".aios/state/personal-wa-events.jsonl"],
        _ => &[],
    }
}

/// Trims `s` to at most `max` chars (char-safe), appending `…` if truncated.
/// Also collapses interior runs of whitespace/newlines into single spaces so a
/// multi-line WA message renders as one tidy feed row.
fn trim_text(s: &str, max: usize) -> String {
    let collapsed: String = {
        let mut out = String::with_capacity(s.len());
        let mut prev_ws = false;
        for ch in s.trim().chars() {
            if ch.is_whitespace() {
                if !prev_ws {
                    out.push(' ');
                }
                prev_ws = true;
            } else {
                out.push(ch);
                prev_ws = false;
            }
        }
        out
    };
    if collapsed.chars().count() <= max {
        return collapsed;
    }
    let truncated: String = collapsed.chars().take(max).collect();
    format!("{}…", truncated.trim_end())
}

/// Pulls the first present string value among `keys` from a JSON object.
fn first_str(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = obj.get(*k).and_then(|v| v.as_str()) {
            if !s.trim().is_empty() {
                return Some(s.trim().to_string());
            }
        }
    }
    None
}

/// Parses one JSON log line into a feed message. `default_dir` is the direction
/// assigned when the line carries no direction field (outbound log → "out").
/// Returns `None` on parse failure / no usable timestamp — tolerated per-line.
fn parse_feed_line(line: &str, default_dir: &str) -> Option<Value> {
    let ts = extract_timestamp(line)?;
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = v.as_object()?;

    // direction: explicit field wins (in/out/inbound/outbound/sent/received),
    // else fall back to the log's default.
    let direction = match first_str(obj, &["direction", "dir", "from", "type"]) {
        Some(d) => {
            let d = d.to_lowercase();
            if d.contains("in") || d == "received" || d == "recv" {
                "in"
            } else if d.contains("out") || d == "sent" {
                "out"
            } else {
                default_dir
            }
        }
        None => default_dir,
    };

    // peer: a name first, then a phone/id. Different shapes across logs.
    let peer = first_str(
        obj,
        &[
            "peer", "name", "chatName", "to", "recipient", "chat", "from", "target", "phone",
        ],
    )
    .unwrap_or_else(|| "unknown".to_string());

    // text: prefer real message bodies; fall back to a media tag.
    let text = first_str(obj, &["text", "body", "message", "content", "body_preview"])
        .or_else(|| {
            first_str(obj, &["media"]).map(|m| format!("[{m}]"))
        })
        .unwrap_or_default();

    Some(json!({
        "ts": format_local(&ts),
        "tsAgo": humanize_ago(&ts),
        "direction": direction,
        "peer": trim_text(&peer, 48),
        "text": trim_text(&text, 280),
        "_sort": ts.timestamp_millis(),
    }))
}

/// Reads the last `limit` lines of a log file and parses each into a feed
/// message with the given default direction. Best-effort: missing/garbage
/// files yield an empty vec, bad lines are skipped.
fn read_feed(candidates: &[&str], default_dir: &str, limit: usize) -> Vec<Value> {
    let Some(path) = resolve_log(candidates) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(limit);
    lines[start..]
        .iter()
        .filter_map(|l| parse_feed_line(l, default_dir))
        .collect()
}

/// Recent messages flowing through a channel, newest-first. Merges the outbound
/// log (everything `out`) with an inbound/conversation log when one exists, then
/// sorts by timestamp and caps at `limit`. For an unknown channel id with no log
/// (e.g. a `soon` channel), returns `{ "messages": [] }`. Never panics — every
/// source fails soft.
#[tauri::command]
pub fn bridge_activity(id: String, limit: u32) -> Value {
    let limit = (limit.max(1) as usize).min(500);

    // Find the matching probe to reuse its outbound log candidates.
    let probes = channel_probes();
    let probe = probes.iter().find(|p| p.id == id);

    let mut messages: Vec<Value> = Vec::new();

    if let Some(p) = probe {
        // Outbound log — every entry is a sent (out) message. Pull extra so the
        // merge+trim still leaves `limit` after interleaving with inbound.
        messages.extend(read_feed(p.log_candidates, "out", limit));
    }

    // Inbound/conversation log (if any) — these default to "in".
    let inbound = inbound_candidates(&id);
    if !inbound.is_empty() {
        messages.extend(read_feed(inbound, "in", limit));
    }

    // Newest-first across both sources.
    messages.sort_by(|a, b| {
        let bk = b.get("_sort").and_then(|v| v.as_i64()).unwrap_or(0);
        let ak = a.get("_sort").and_then(|v| v.as_i64()).unwrap_or(0);
        bk.cmp(&ak)
    });
    messages.truncate(limit);

    // Drop the internal sort key from the public shape.
    for m in messages.iter_mut() {
        if let Some(o) = m.as_object_mut() {
            o.remove("_sort");
        }
    }

    json!({ "messages": messages })
}
