//! Local control hook — the inbound seam for the AIOS "persistent agents"
//! runtime.
//!
//! WHY THIS EXISTS: panes (and the chat sessions behind them) live in the
//! FRONTEND (React owns the grid, the ChatPane component owns a backend chat
//! session id). External triggers — a future cron timer, a CLI poke, another
//! oracle — need a way to say "run agent X now" or "open pane Y" WITHOUT a
//! webview. So this module stands up a tiny localhost-only HTTP listener that
//! accepts a couple of JSON commands and re-emits them into the frontend as a
//! Tauri `control-command` event. Rust never touches panes; it just relays.
//!
//! SECURITY: bound to `127.0.0.1` ONLY (never `0.0.0.0`), and every request
//! must carry `Authorization: Bearer <token>` where the token is read from
//! `~/.aios/state/node-secret` (auto-created with a process-derived value if
//! missing). Localhost + bearer is enough for a single-user daily-driver; this
//! is not a public API.
//!
//! CROSS-PLATFORM: the box is Linux (no launchd), the laptop is mac. Everything
//! here is std::net + tokio (already in the tree) + HOME-based fs paths, so it
//! runs identically on both. No mac-only APIs.
//!
//! The HTTP parse is hand-rolled (request line + headers + Content-Length body)
//! rather than pulling an HTTP server crate — the surface is two POST routes,
//! so a framework would be dead weight.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

/// First port we try; if taken we walk upward a few slots. Kept fixed-ish so a
/// cron/CLI caller can find us without service discovery (see `control_port`).
const BASE_PORT: u16 = 8787;
const PORT_SCAN: u16 = 16;

/// Path to the shared bearer token. Same `~/.aios/state` dir the rest of the
/// runtime uses. HOME (or USERPROFILE on Windows) based — cross-platform.
fn secret_path() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    Some(PathBuf::from(home).join(".aios/state/node-secret"))
}

/// Reads the bearer token, creating it with a process-derived pseudo-random
/// value if absent. NOTE: we intentionally avoid pulling the `rand` crate (not
/// in the tree) — a token seeded from pid + nanos-since-epoch is plenty for a
/// localhost single-user secret. If the file already exists we keep it (so the
/// token is stable across restarts and a cron caller can cache it).
fn load_or_create_secret() -> Option<String> {
    let path = secret_path()?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    // Generate: hex of (nanos ^ pid-mixed). Not cryptographic; sufficient for
    // a 127.0.0.1-only bearer on a single-user box.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let mixed = nanos
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(pid.wrapping_mul(0x1000_0000_01B3));
    let token = format!("aios-{:032x}", mixed);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, &token);
    Some(token)
}

/// Records the bound port so an external caller (or a frontend self-test) can
/// discover it. Written next to the secret as `~/.aios/state/control-port`.
fn write_port_file(port: u16) {
    if let Some(secret) = secret_path() {
        if let Some(dir) = secret.parent() {
            let _ = std::fs::write(dir.join("control-port"), port.to_string());
        }
    }
}

/// Binds the listener, scanning forward from BASE_PORT if the first slot is
/// taken. Returns the live listener + the port it landed on.
fn bind_listener() -> Option<(TcpListener, u16)> {
    for offset in 0..PORT_SCAN {
        let port = BASE_PORT + offset;
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return Some((listener, port));
        }
    }
    None
}

/// Spawns the control listener on a dedicated OS thread. Called once from
/// `lib.rs` `setup()`. Soft-fails (logs + returns) if it can't bind or read a
/// secret — the control hook is additive, it must never block app startup.
pub fn start(app: AppHandle) {
    let Some(secret) = load_or_create_secret() else {
        eprintln!("[aios control] no HOME — control hook disabled");
        return;
    };
    let Some((listener, port)) = bind_listener() else {
        eprintln!(
            "[aios control] no free port in {BASE_PORT}..{} — disabled",
            BASE_PORT + PORT_SCAN
        );
        return;
    };
    write_port_file(port);
    eprintln!("[aios control] listening on 127.0.0.1:{port}");

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let app = app.clone();
                    let secret = secret.clone();
                    // One short-lived thread per connection. Volume here is a
                    // trickle (cron/CLI pokes), so no pool needed.
                    std::thread::spawn(move || handle_conn(stream, &app, &secret));
                }
                Err(e) => {
                    eprintln!("[aios control] accept error: {e}");
                }
            }
        }
    });
}

/// Parses one request, validates the bearer, emits the command, replies.
fn handle_conn(mut stream: TcpStream, app: &AppHandle, secret: &str) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let raw = match read_request(&mut stream) {
        Ok(raw) => raw,
        Err(e) => {
            let _ = write_response(&mut stream, 400, &format!("{{\"error\":\"{e}\"}}"));
            return;
        }
    };

    // Split headers / body on the blank line.
    let (head, body) = match raw.split_once("\r\n\r\n") {
        Some(parts) => parts,
        None => {
            let _ = write_response(&mut stream, 400, "{\"error\":\"malformed request\"}");
            return;
        }
    };

    // Request line: `POST /control HTTP/1.1`. We accept any path; the command
    // discriminator lives in the JSON `cmd` field.
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("");
    let is_post = request_line.starts_with("POST");

    // GET /health → liveness probe (no auth — reveals nothing sensitive).
    if request_line.starts_with("GET") && request_line.contains("/health") {
        let _ = write_response(
            &mut stream,
            200,
            "{\"ok\":true,\"service\":\"aios-control\"}",
        );
        return;
    }

    if !is_post {
        let _ = write_response(&mut stream, 405, "{\"error\":\"use POST\"}");
        return;
    }

    // Bearer check.
    let authorized = lines.any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("authorization:")
            && line
                .split_once(':')
                .map(|(_, v)| v.trim() == format!("Bearer {secret}"))
                .unwrap_or(false)
    });
    if !authorized {
        let _ = write_response(&mut stream, 401, "{\"error\":\"unauthorized\"}");
        return;
    }

    // Parse the JSON body and forward as-is to the frontend. We validate the
    // `cmd` is one we know so a typo gets a clear 400 rather than a silent
    // no-op in the webview.
    let payload: serde_json::Value = match serde_json::from_str(body.trim()) {
        Ok(v) => v,
        Err(e) => {
            let _ = write_response(
                &mut stream,
                400,
                &format!("{{\"error\":\"bad json: {e}\"}}"),
            );
            return;
        }
    };
    let cmd = payload.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
    match cmd {
        "run-agent" | "open-pane" => {
            // DO NOT touch panes from Rust — emit so the frontend (where panes +
            // chat sessions live) handles it. This is the whole point of the hook.
            if let Err(e) = app.emit("control-command", payload) {
                let _ = write_response(
                    &mut stream,
                    500,
                    &format!("{{\"error\":\"emit failed: {e}\"}}"),
                );
                return;
            }
            let _ = write_response(&mut stream, 200, "{\"ok\":true}");
        }
        "" => {
            let _ = write_response(&mut stream, 400, "{\"error\":\"missing cmd\"}");
        }
        other => {
            let _ = write_response(
                &mut stream,
                400,
                &format!("{{\"error\":\"unknown cmd: {other}\"}}"),
            );
        }
    }
}

/// Reads request headers, then exactly Content-Length body bytes. Caps the body
/// at 256 KiB so a bad client can't make us allocate unbounded.
fn read_request(stream: &mut TcpStream) -> Result<String, String> {
    const MAX_BODY: usize = 256 * 1024;
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];

    // Read until we have the header terminator.
    loop {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > MAX_BODY {
            return Err("request too large".into());
        }
    }

    let text = String::from_utf8_lossy(&buf).to_string();
    let header_end = text.find("\r\n\r\n").ok_or("no header terminator")?;
    let headers = &text[..header_end];

    // Content-Length → how much body to keep reading.
    let content_len = headers
        .lines()
        .find_map(|l| {
            let lower = l.to_ascii_lowercase();
            if lower.starts_with("content-length:") {
                l.split_once(':')
                    .and_then(|(_, v)| v.trim().parse::<usize>().ok())
            } else {
                None
            }
        })
        .unwrap_or(0)
        .min(MAX_BODY);

    let body_have = buf.len() - (header_end + 4);
    let mut remaining = content_len.saturating_sub(body_have);
    while remaining > 0 {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        remaining = remaining.saturating_sub(n);
    }

    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// Writes a minimal HTTP/1.1 JSON response and closes the connection.
fn write_response(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

// ── agent config persistence (fs mirror of the localStorage `aios.agents`) ───
// The frontend is the source of truth (localStorage), but we also mirror each
// agent's config to `~/.aios/state/chat-agents/<id>/config.json` so a headless
// caller — the future cron runner on the box — can enumerate agents and decide
// what to fire WITHOUT a webview. These commands are the Rust half of
// `src/lib/agents.ts`.

/// Directory holding per-agent config (created on demand).
fn agents_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    Some(PathBuf::from(home).join(".aios/state/chat-agents"))
}

/// Persists one agent's config JSON to `<dir>/<id>/config.json`. The `config`
/// is passed through opaquely (the TS `AgentConfig` shape) so this stays in
/// lockstep with the frontend without a duplicated struct. `id` is validated to
/// a safe slug so it can't escape the agents dir.
#[tauri::command]
pub fn agent_save(id: String, config: serde_json::Value) -> Result<(), String> {
    let id = safe_id(&id).ok_or("invalid agent id")?;
    let dir = agents_dir().ok_or("no HOME")?.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("config.json"), pretty).map_err(|e| e.to_string())?;
    Ok(())
}

/// Lists every persisted agent config (each the opaque TS `AgentConfig`).
/// Skips dirs without a readable `config.json` (e.g. the legacy money-agent
/// `firaz` state dir that holds only status/queue files).
#[tauri::command]
pub fn agent_list() -> Vec<serde_json::Value> {
    let Some(dir) = agents_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let cfg = entry.path().join("config.json");
        if let Ok(text) = std::fs::read_to_string(&cfg) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                out.push(value);
            }
        }
    }
    out
}

/// State dir root: `~/.aios/state`. Shared by the goal/loop readers below.
fn aios_state_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    Some(PathBuf::from(home).join(".aios/state"))
}

fn loops_disabled_path() -> Option<PathBuf> {
    Some(aios_state_dir()?.join("loops/DISABLED"))
}

fn loops_disabled_since(path: &std::path::Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

fn loop_global_status_value() -> serde_json::Value {
    let path = loops_disabled_path();
    let disabled = path.as_ref().map(|p| p.exists()).unwrap_or(false);
    serde_json::json!({
        "disabled": disabled,
        "disabledPath": path.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "disabledSince": path.as_ref().and_then(|p| if disabled { loops_disabled_since(p) } else { None }),
    })
}

#[tauri::command]
pub fn loop_global_status() -> serde_json::Value {
    loop_global_status_value()
}

#[tauri::command]
pub fn loop_set_global_disabled(disabled: bool) -> Result<serde_json::Value, String> {
    let path = loops_disabled_path().ok_or("no HOME")?;
    if disabled {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        std::fs::write(&path, format!("disabled {now}\n")).map_err(|e| e.to_string())?;
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(loop_global_status_value())
}

/// Lists every active goal driver — the source-of-truth `state.json` under
/// `~/.aios/state/goals/active/<id>/state.json` (written by aios-goal-tick).
/// Each value is the opaque goal JSON (goal, priority, window, kind, status,
/// nextStep, blocker, progress). The MissionBoard renders these as a Goals
/// section so firaz sees every driver, not just the static WRMS seed lane.
#[tauri::command]
pub fn goal_list() -> Vec<serde_json::Value> {
    let Some(dir) = aios_state_dir().map(|d| d.join("goals/active")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let cfg = entry.path().join("state.json");
        if let Ok(text) = std::fs::read_to_string(&cfg) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                out.push(value);
            }
        }
    }
    out
}

/// Lists active loops — one per `*.meta` under `~/.aios/state/loops/`. Each meta
/// is a single tab-separated line `name<TAB>cadence<TAB>tick-path`; we also read
/// the last non-empty line of the sibling `<name>.log` so firaz can see what each
/// loop just did. Returns `{name, cadence, lastLog}` so the frontend never has to
/// parse tab-delimited files itself.
#[tauri::command]
pub fn loop_list() -> Vec<serde_json::Value> {
    let Some(dir) = aios_state_dir().map(|d| d.join("loops")) else {
        return Vec::new();
    };
    // Snapshot the launchd-loaded loop labels ONCE (one `launchctl list` for the
    // whole listing) rather than per-loop.
    let loaded = launchctl_loaded_labels();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("meta") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let line = text.lines().next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let mut parts = line.split('\t');
            let name = parts.next().unwrap_or("").trim().to_string();
            let cadence = parts.next().unwrap_or("").trim().to_string();
            // 3rd meta field = the command the loop fires (needed to re-create it on a
            // cadence edit). Joined back if it itself contained tabs (it won't).
            let command = parts.collect::<Vec<_>>().join("\t").trim().to_string();
            if name.is_empty() {
                continue;
            }
            let label = format!("{LOOP_LABEL_PREFIX}-{name}");
            let log_path = dir.join(format!("{name}.log"));
            let last_log = last_non_empty_line(&log_path).unwrap_or_default();
            // status: launchctl-loaded → running; the dogfood loop has a reversible
            // soft-pause via its STOP flag (loaded but idle) → paused; not loaded →
            // stopped (plist on disk, restartable).
            let is_loaded = loaded.contains(&label);
            let paused = name == "aios-dogfood" && dogfood_stop_present();
            let status = if paused {
                "paused"
            } else if is_loaded {
                "running"
            } else {
                "stopped"
            };
            seen.insert(name.clone());
            out.push(serde_json::json!({
                "name": name,
                "cadence": cadence,
                "command": command,
                "label": label,
                "source": "managed",
                "editable": true,
                "controllable": true,
                "logPath": log_path.to_string_lossy().to_string(),
                "status": status,
                "lastLog": last_log,
            }));
        }
    }

    for row in launchagent_loop_rows(&loaded, &seen) {
        if let Some(name) = row.get("name").and_then(serde_json::Value::as_str) {
            seen.insert(name.to_string());
        }
        out.push(row);
    }

    out.sort_by(|a, b| {
        let source_rank = |v: &serde_json::Value| match v["source"].as_str().unwrap_or("") {
            "managed" => 0,
            _ => 1,
        };
        source_rank(a).cmp(&source_rank(b)).then_with(|| {
            a["name"]
                .as_str()
                .unwrap_or("")
                .cmp(b["name"].as_str().unwrap_or(""))
        })
    });
    out
}

/// The overnight loop activity ledger — one parsed row per JSON object in
/// `~/.aios/state/loops/changes.jsonl` (each loop appends a line as it lands
/// work). Returned newest-first by `ts`, capped at `limit` (default 100).
/// Malformed lines are skipped so one bad append can't blank the whole ledger.
/// This is the source of truth for "what did the loops actually do?".
#[tauri::command]
pub fn loop_changes(limit: Option<usize>) -> Vec<serde_json::Value> {
    let Some(path) = aios_state_dir().map(|d| d.join("loops/changes.jsonl")) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut rows: Vec<serde_json::Value> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(serde_json::Value::is_object)
        .collect();
    // newest first by `ts` (a row missing/invalid `ts` sorts oldest).
    rows.sort_by(|a, b| {
        let ta = a.get("ts").and_then(serde_json::Value::as_i64).unwrap_or(0);
        let tb = b.get("ts").and_then(serde_json::Value::as_i64).unwrap_or(0);
        tb.cmp(&ta)
    });
    rows.truncate(limit.unwrap_or(100));
    rows
}

/// Tail of a single loop's run log — the last `lines` non-empty lines of
/// `~/.aios/state/loops/<name>.log` (default 20). `name` is slug-guarded with the
/// same rule as the loop-control commands so it can't path-traverse out of the
/// loops dir. Returns an empty vec if the log is missing/unreadable.
#[tauri::command]
pub fn loop_log(name: String, lines: Option<usize>) -> Vec<String> {
    let Some(name) = safe_loop_name(&name) else {
        return Vec::new();
    };
    let state_path = aios_state_dir().map(|d| d.join(format!("loops/{name}.log")));
    let path = state_path
        .filter(|p| p.exists())
        .or_else(|| launchagent_log_path(&name));
    let Some(path) = path else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let all: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let start = all.len().saturating_sub(lines.unwrap_or(20));
    all[start..].to_vec()
}

// ── loop control (the MissionBoard Loops section's control panel) ────────────
// Mirrors the launchd/plist conventions of `~/.aios/state/bin/aios-loop` so the
// pane and the CLI stay in lockstep: each loop is a launchd agent labelled
// `com.firaz.aios-loop-<name>`, its plist at `~/Library/LaunchAgents/<label>.plist`,
// its `<name>.meta` (name<TAB>cadence<TAB>command) under `~/.aios/state/loops`.

const LOOP_LABEL_PREFIX: &str = "com.firaz.aios-loop";

/// `~/Library/LaunchAgents` (macOS launchd user-agent dir).
fn launch_agents_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join("Library/LaunchAgents"))
}

fn last_non_empty_line(path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(path).ok().and_then(|text| {
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .last()
            .map(str::to_string)
    })
}

fn plist_unescape(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn plist_value_after_key(text: &str, key: &str, tag: &str) -> Option<String> {
    let key_tag = format!("<key>{key}</key>");
    let start_tag = format!("<{tag}>");
    let end_tag = format!("</{tag}>");
    let after_key = text.get(text.find(&key_tag)? + key_tag.len()..)?;
    let value_start = after_key.find(&start_tag)? + start_tag.len();
    let after_start = after_key.get(value_start..)?;
    let value_end = after_start.find(&end_tag)?;
    Some(plist_unescape(after_start.get(..value_end)?.trim()))
}

fn plist_string_after_key(text: &str, key: &str) -> Option<String> {
    plist_value_after_key(text, key, "string")
}

fn plist_integer_after_key(text: &str, key: &str) -> Option<u64> {
    plist_value_after_key(text, key, "integer")?.parse().ok()
}

fn plist_bool_after_key(text: &str, key: &str) -> Option<bool> {
    let key_tag = format!("<key>{key}</key>");
    let after_key = text.get(text.find(&key_tag)? + key_tag.len()..)?;
    let trimmed = after_key.trim_start();
    if trimmed.starts_with("<true/>") {
        Some(true)
    } else if trimmed.starts_with("<false/>") {
        Some(false)
    } else {
        None
    }
}

fn plist_array_strings_after_key(text: &str, key: &str) -> Vec<String> {
    let key_tag = format!("<key>{key}</key>");
    let Some(after_key) = text
        .find(&key_tag)
        .and_then(|i| text.get(i + key_tag.len()..))
    else {
        return Vec::new();
    };
    let Some(array_start) = after_key.find("<array>") else {
        return Vec::new();
    };
    let Some(after_array) = after_key.get(array_start + "<array>".len()..) else {
        return Vec::new();
    };
    let Some(array_end) = after_array.find("</array>") else {
        return Vec::new();
    };
    let Some(array) = after_array.get(..array_end) else {
        return Vec::new();
    };
    let mut values = Vec::new();
    let mut rest = array;
    while let Some(start) = rest.find("<string>") {
        let after = &rest[start + "<string>".len()..];
        let Some(end) = after.find("</string>") else {
            break;
        };
        values.push(plist_unescape(after[..end].trim()));
        rest = &after[end + "</string>".len()..];
    }
    values
}

fn launchagent_name_from_label(label: &str) -> Option<String> {
    let loop_prefix = format!("{LOOP_LABEL_PREFIX}-");
    let name = label
        .strip_prefix(&loop_prefix)
        .or_else(|| label.strip_prefix("com.firaz.aios-"))
        .or_else(|| label.strip_prefix("com.aios."))?;
    safe_loop_name(name)
}

fn format_interval(seconds: u64) -> String {
    if seconds >= 3600 && seconds % 3600 == 0 {
        format!("{}h", seconds / 3600)
    } else if seconds >= 60 && seconds % 60 == 0 {
        format!("{}m", seconds / 60)
    } else {
        format!("{seconds}s")
    }
}

fn plist_cadence(text: &str) -> String {
    if let Some(seconds) = plist_integer_after_key(text, "StartInterval") {
        return format_interval(seconds);
    }
    if let Some(after_key) = text
        .find("<key>StartCalendarInterval</key>")
        .and_then(|i| text.get(i + "<key>StartCalendarInterval</key>".len()..))
    {
        if let (Some(hour), Some(minute)) = (
            plist_integer_after_key(after_key, "Hour"),
            plist_integer_after_key(after_key, "Minute"),
        ) {
            return format!("daily {hour:02}:{minute:02}");
        }
    }
    if plist_bool_after_key(text, "RunAtLoad").unwrap_or(false) {
        "at load".to_string()
    } else {
        "manual".to_string()
    }
}

fn launchagent_loop_rows(
    loaded: &std::collections::HashSet<String>,
    seen: &std::collections::HashSet<String>,
) -> Vec<serde_json::Value> {
    let Some(dir) = launch_agents_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("plist") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let label = plist_string_after_key(&text, "Label").or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_string)
        });
        let Some(label) = label else {
            continue;
        };
        if !(label.starts_with("com.firaz.aios-") || label.starts_with("com.aios.")) {
            continue;
        }
        let Some(name) = launchagent_name_from_label(&label) else {
            continue;
        };
        if seen.contains(&name) {
            continue;
        }
        let log_path = plist_string_after_key(&text, "StandardOutPath")
            .or_else(|| plist_string_after_key(&text, "StandardErrorPath"))
            .unwrap_or_default();
        let last_log = if log_path.is_empty() {
            String::new()
        } else {
            last_non_empty_line(&PathBuf::from(&log_path)).unwrap_or_default()
        };
        let command = plist_array_strings_after_key(&text, "ProgramArguments").join(" ");
        let status = if loaded.contains(&label) {
            "running"
        } else {
            "stopped"
        };
        out.push(serde_json::json!({
            "name": name,
            "cadence": plist_cadence(&text),
            "command": command,
            "label": label,
            "source": "launchagent",
            "editable": false,
            "controllable": true,
            "logPath": log_path,
            "status": status,
            "lastLog": last_log,
        }));
    }
    out
}

/// Slug guard for a loop name: alnum + dash/underscore only, so a crafted name
/// can't escape the plist dir. Returns None for anything else.
fn safe_loop_name(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() || t.len() > 64 {
        return None;
    }
    if t.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Some(t.to_string())
    } else {
        None
    }
}

fn launchagent_plist_path(name: &str) -> Option<PathBuf> {
    let dir = launch_agents_dir()?;
    let candidates = [
        format!("{LOOP_LABEL_PREFIX}-{name}.plist"),
        format!("com.firaz.aios-{name}.plist"),
        format!("com.aios.{name}.plist"),
    ];
    candidates
        .iter()
        .map(|file| dir.join(file))
        .find(|path| path.exists())
}

fn launchagent_log_path(name: &str) -> Option<PathBuf> {
    let plist = launchagent_plist_path(name)?;
    let text = std::fs::read_to_string(plist).ok()?;
    plist_string_after_key(&text, "StandardOutPath")
        .or_else(|| plist_string_after_key(&text, "StandardErrorPath"))
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
}

/// True when the dogfood loop's reversible soft-stop flag is present.
fn dogfood_stop_present() -> bool {
    aios_state_dir()
        .map(|d| d.join("dogfood/STOP").exists())
        .unwrap_or(false)
}

/// The set of currently launchd-loaded loop labels (one `launchctl list`).
fn launchctl_loaded_labels() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    if let Ok(out) = std::process::Command::new("launchctl").arg("list").output() {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            // `launchctl list` rows are `<pid>\t<status>\t<label>`.
            if let Some(label) = line.split('\t').nth(2) {
                let label = label.trim();
                if !label.is_empty() {
                    set.insert(label.to_string());
                }
            }
        }
    }
    set
}

/// Starts a loop. The dogfood loop uses its reversible STOP-flag soft-stop (rm
/// the flag); every other loop is `launchctl load`-ed from its plist.
#[tauri::command]
pub fn loop_start(name: String) -> Result<(), String> {
    let name = safe_loop_name(&name).ok_or("invalid loop name")?;
    if name == "aios-dogfood" {
        if let Some(stop) = aios_state_dir().map(|d| d.join("dogfood/STOP")) {
            let _ = std::fs::remove_file(stop); // absent = already running
        }
        return Ok(());
    }
    let plist = launchagent_plist_path(&name).ok_or("no HOME")?;
    if !plist.exists() {
        return Err(format!("no plist for loop '{name}'"));
    }
    run_launchctl("load", &plist)
}

/// Stops a loop. The dogfood loop gets a reversible soft-stop (touch its STOP
/// flag — keeps the launchd agent loaded but idle, so START just rm's it); every
/// other loop is `launchctl unload`-ed (restartable from its on-disk plist).
#[tauri::command]
pub fn loop_stop(name: String) -> Result<(), String> {
    let name = safe_loop_name(&name).ok_or("invalid loop name")?;
    if name == "aios-dogfood" {
        let stop = aios_state_dir()
            .map(|d| d.join("dogfood/STOP"))
            .ok_or("no HOME")?;
        if let Some(parent) = stop.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&stop, "paused from MissionBoard\n").map_err(|e| e.to_string())?;
        return Ok(());
    }
    let plist = launchagent_plist_path(&name).ok_or("no HOME")?;
    if !plist.exists() {
        return Err(format!("no plist for loop '{name}'"));
    }
    run_launchctl("unload", &plist)
}

/// Changes a loop's cadence by re-creating it through the SAME `aios-loop create`
/// the CLI uses (rewrites the plist schedule + meta + reloads), so the pane and
/// CLI never drift. Reuses the proven bash rather than re-emitting plist XML in
/// Rust. The command is read from the loop's `.meta` (3rd field) and preserved.
#[tauri::command]
pub fn loop_set_cadence(name: String, cadence: String) -> Result<(), String> {
    let name = safe_loop_name(&name).ok_or("invalid loop name")?;
    let cadence = cadence.trim().to_string();
    if cadence.is_empty() {
        return Err("empty cadence".into());
    }
    let state = aios_state_dir().ok_or("no HOME")?;
    let meta_path = state.join(format!("loops/{name}.meta"));
    let meta = std::fs::read_to_string(&meta_path).map_err(|e| format!("no meta: {e}"))?;
    let first = meta.lines().next().unwrap_or("");
    let command = first.split('\t').nth(2).unwrap_or("").trim().to_string();
    if command.is_empty() {
        return Err("loop has no recorded command — edit via CLI".into());
    }
    let aios_loop = state.join("bin/aios-loop");
    if !aios_loop.exists() {
        return Err("aios-loop CLI not found".into());
    }
    // command parts are whitespace-separated (aios-loop create takes them as
    // distinct ProgramArguments) — matches how the CLI was originally invoked.
    let mut cmd = std::process::Command::new(&aios_loop);
    cmd.arg("create").arg(&name).arg(&cadence);
    append_loop_command_args(
        &mut cmd,
        &state,
        command.split_whitespace().map(str::to_string),
    );
    // GUI launch hands children the bare PATH; the aios-loop CLI (and what it
    // spawns) needs the user's real PATH. Mirrors the chat.rs fix.
    #[cfg(not(windows))]
    cmd.env("PATH", crate::chat::enriched_path());
    let out = cmd
        .output()
        .map_err(|e| format!("aios-loop failed to run: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "aios-loop create failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Creates a NEW loop through the SAME `aios-loop create` the CLI uses (writes
/// the plist + meta + launchctl load), so the pane and CLI stay in lockstep.
/// `command` is an arg VECTOR (not a string) so a multi-word agent prompt stays
/// one ProgramArgument. A bare leading `aios-agent` is resolved to its absolute
/// path — launchd has no shell PATH, so the plist needs the full path. Refuses to
/// clobber an existing loop (edit its cadence instead). `cadence` may be a single
/// token (`30m`) or `daily HH:MM` (split on whitespace into args).
#[tauri::command]
pub fn loop_create(name: String, cadence: String, command: Vec<String>) -> Result<(), String> {
    let name = safe_loop_name(&name).ok_or("invalid loop name")?;
    let cadence = cadence.trim().to_string();
    if cadence.is_empty() {
        return Err("empty cadence".into());
    }
    let parts: Vec<String> = command
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        return Err("empty command".into());
    }
    let state = aios_state_dir().ok_or("no HOME")?;
    if state.join(format!("loops/{name}.meta")).exists() {
        return Err(format!("loop '{name}' already exists — edit it instead"));
    }
    let aios_loop = state.join("bin/aios-loop");
    if !aios_loop.exists() {
        return Err("aios-loop CLI not found".into());
    }
    let mut cmd = std::process::Command::new(&aios_loop);
    cmd.arg("create").arg(&name);
    for tok in cadence.split_whitespace() {
        cmd.arg(tok);
    }
    append_loop_command_args(&mut cmd, &state, parts);
    // GUI launch hands children the bare PATH; the aios-loop CLI (and what it
    // spawns) needs the user's real PATH. Mirrors the chat.rs fix.
    #[cfg(not(windows))]
    cmd.env("PATH", crate::chat::enriched_path());
    let out = cmd
        .output()
        .map_err(|e| format!("aios-loop failed to run: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "aios-loop create failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

fn append_loop_command_args<I>(cmd: &mut std::process::Command, state: &std::path::Path, parts: I)
where
    I: IntoIterator<Item = String>,
{
    let parts: Vec<String> = parts.into_iter().collect();
    if parts.is_empty() {
        return;
    }
    let agent_path = state.join("bin/aios-agent");
    let first = parts.first().map(String::as_str).unwrap_or("");
    let is_agent = first == "aios-agent"
        || std::path::Path::new(first)
            .file_name()
            .and_then(|s| s.to_str())
            == Some("aios-agent");
    if is_agent {
        // Agent loops are recurring/background work. `aios-agent` converts this
        // env flag into `background:true`, so the frontend defers mounting the
        // worker pane until Firaz explicitly opens it.
        cmd.arg("/usr/bin/env").arg("AIOS_AGENT_BACKGROUND=1");
        if first == "aios-agent" {
            cmd.arg(agent_path);
        } else {
            cmd.arg(first);
        }
        for part in parts.into_iter().skip(1) {
            cmd.arg(part);
        }
        return;
    }
    for part in parts {
        cmd.arg(part);
    }
}

/// Deletes a loop entirely: unload its launchd agent (so the job stops before
/// the plist vanishes), then remove the plist and — for managed loops — the
/// `.meta` (and any dogfood STOP flag). Irreversible; the pane double-confirms
/// and warns louder for high-blast-radius loops. Errors only if nothing was
/// found to delete (so a double-tap is harmlessly idempotent on the second go).
#[tauri::command]
pub fn loop_delete(name: String) -> Result<(), String> {
    let name = safe_loop_name(&name).ok_or("invalid loop name")?;
    let mut removed = false;
    if let Some(plist) = launchagent_plist_path(&name) {
        let _ = run_launchctl("unload", &plist); // best-effort stop first
        std::fs::remove_file(&plist).map_err(|e| format!("rm plist: {e}"))?;
        removed = true;
    }
    if let Some(state) = aios_state_dir() {
        let meta = state.join(format!("loops/{name}.meta"));
        if meta.exists() {
            let _ = std::fs::remove_file(&meta);
            removed = true;
        }
    }
    if removed {
        Ok(())
    } else {
        Err(format!("no loop '{name}' to delete"))
    }
}

/// Reads the projects registry (~/.aios/state/loops/projects.json) → the
/// `projects` array, so the pane can group loops by project and offer add-project.
/// Empty vec if the file is missing/malformed (pane falls back to functional groups).
#[tauri::command]
pub fn loop_projects() -> Vec<serde_json::Value> {
    let Some(state) = aios_state_dir() else {
        return vec![];
    };
    let path = state.join("loops/projects.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return vec![];
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else {
        return vec![];
    };
    val.get("projects")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default()
}

/// Appends a project to the registry so a new project gets its own grouping +
/// (when wired) loop coverage. Rejects a duplicate key. posture is normalized to
/// `prep-only` (employer-prod safety) or `branch-only`.
#[tauri::command]
pub fn loop_add_project(
    key: String,
    label: String,
    posture: String,
    repos: Vec<String>,
    loops: Vec<String>,
) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("empty project key".into());
    }
    let label = {
        let l = label.trim();
        if l.is_empty() {
            key.clone()
        } else {
            l.to_string()
        }
    };
    let posture = if posture.trim() == "prep-only" {
        "prep-only"
    } else {
        "branch-only"
    };
    let clean = |v: Vec<String>| -> Vec<String> {
        v.into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };
    let state = aios_state_dir().ok_or("no HOME")?;
    let path = state.join("loops/projects.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read registry: {e}"))?;
    let mut val: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse registry: {e}"))?;
    let arr = val
        .get_mut("projects")
        .and_then(|p| p.as_array_mut())
        .ok_or("registry has no projects array")?;
    if arr
        .iter()
        .any(|p| p.get("key").and_then(|k| k.as_str()) == Some(key.as_str()))
    {
        return Err(format!("project '{key}' already exists"));
    }
    arr.push(serde_json::json!({
        "key": key,
        "label": label,
        "posture": posture,
        "repos": clean(repos),
        "loops": clean(loops),
    }));
    let out = serde_json::to_string_pretty(&val).map_err(|e| e.to_string())?;
    std::fs::write(&path, out).map_err(|e| format!("write registry: {e}"))?;
    Ok(())
}

/// Runs `launchctl <action> <plist>`, mapping a non-zero exit to an Err string.
fn run_launchctl(action: &str, plist: &std::path::Path) -> Result<(), String> {
    let out = std::process::Command::new("launchctl")
        .arg(action)
        .arg(plist)
        .output()
        .map_err(|e| format!("launchctl {action} failed to run: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        if err.is_empty() {
            Ok(()) // launchctl load/unload is often silent + exits 0-ish; treat empty as ok
        } else {
            Err(format!("launchctl {action}: {err}"))
        }
    }
}

// ── dogfood ticket intake (the TicketPane's surface) ────────────────────────
// Tickets are markdown files under `~/.aios/state/dogfood/tickets/{open,done}/`
// with a `--- source/priority/status/created ---` frontmatter + a body. The
// dogfood loop picks firaz-authored open tickets first (oldest-first). These two
// commands let the TicketPane FILE a ticket (wrapping the proven `aios-ticket`
// CLI so the format never drifts) and LIST the queue.

/// Files a firaz ticket by wrapping `~/.aios/state/bin/aios-ticket`. `urgent`
/// adds the `--urgent` flag (priority that jumps the loop's queue).
#[tauri::command]
pub fn ticket_add(text: String, urgent: bool) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("empty ticket text".into());
    }
    let cli = aios_state_dir().ok_or("no HOME")?.join("bin/aios-ticket");
    if !cli.exists() {
        return Err("aios-ticket CLI not found".into());
    }
    let mut cmd = std::process::Command::new(&cli);
    if urgent {
        cmd.arg("--urgent");
    }
    cmd.arg(&text);
    // GUI launch hands children the bare PATH; the aios-ticket CLI (and what it
    // spawns) needs the user's real PATH. Mirrors the chat.rs fix.
    #[cfg(not(windows))]
    cmd.env("PATH", crate::chat::enriched_path());
    let out = cmd
        .output()
        .map_err(|e| format!("aios-ticket failed to run: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "aios-ticket failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Lists dogfood tickets from `open/` and `done/`. Each entry carries the parsed
/// frontmatter (source/priority/status/created) + a title (first non-empty body
/// line) so the TicketPane can render the queue without parsing markdown itself.
#[tauri::command]
pub fn ticket_list() -> Vec<serde_json::Value> {
    let Some(base) = aios_state_dir().map(|d| d.join("dogfood/tickets")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for queue in ["open", "done"] {
        let dir = base.join(queue);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let (
                mut source,
                mut priority,
                mut status,
                mut created,
                mut repo,
                mut owner,
                mut branch,
                mut result,
                mut blocker,
            ) = (
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
            );
            // Parse the leading `--- ... ---` frontmatter, then the first non-empty
            // body line as the title.
            let mut in_fm = false;
            let mut fm_done = false;
            let mut title = String::new();
            for line in text.lines() {
                let t = line.trim();
                if !fm_done {
                    if t == "---" {
                        if in_fm {
                            fm_done = true;
                        } else {
                            in_fm = true;
                        }
                        continue;
                    }
                    if in_fm {
                        if let Some((k, v)) = t.split_once(':') {
                            let v = v.trim().to_string();
                            match k.trim() {
                                "source" => source = v,
                                "priority" => priority = v,
                                "status" => status = v,
                                "created" => created = v,
                                "repo" => repo = v,
                                "owner" => owner = v,
                                "branch" => branch = v,
                                "result" => result = v,
                                "blocker" => blocker = v,
                                _ => {}
                            }
                        }
                        continue;
                    }
                    // No frontmatter — fall through to treat as body.
                    fm_done = true;
                }
                if title.is_empty() && !t.is_empty() {
                    title = t.chars().take(140).collect();
                }
            }
            out.push(serde_json::json!({
                "name": name,
                "title": if title.is_empty() { name.clone() } else { title },
                "queue": queue,
                "source": source,
                "priority": priority,
                "status": if status.is_empty() { queue.to_string() } else { status },
                "created": created,
                "repo": repo,
                "owner": owner,
                "branch": branch,
                "result": result,
                "blocker": blocker,
                "mergeStatus": ticket_branch_merge_status(&branch),
            }));
        }
    }
    // Sort: open before done; firaz before self-found; oldest-first within (the
    // loop's actual pickup order) so the pane mirrors what runs next.
    out.sort_by(|a, b| {
        let qa = a["queue"].as_str().unwrap_or("");
        let qb = b["queue"].as_str().unwrap_or("");
        qa.cmp(qb)
            .then_with(|| {
                let fa = a["source"].as_str().unwrap_or("") == "firaz";
                let fb = b["source"].as_str().unwrap_or("") == "firaz";
                fb.cmp(&fa) // firaz (true) first
            })
            .then_with(|| {
                a["created"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["created"].as_str().unwrap_or(""))
            })
    });
    out
}

fn ticket_branch_merge_status(branch: &str) -> &'static str {
    let branch = branch.trim();
    if branch.is_empty() {
        return "";
    }
    let repo = match std::env::current_dir() {
        Ok(path) => path,
        Err(_) => return "unknown",
    };
    let branch_exists = Command::new("git")
        .arg("rev-parse")
        .arg("--verify")
        .arg("--quiet")
        .arg(branch)
        .current_dir(&repo)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !branch_exists {
        return "unknown";
    }
    if Command::new("git")
        .args(["merge-base", "--is-ancestor", branch, "HEAD"])
        .current_dir(&repo)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        return "merged";
    }
    match Command::new("git")
        .args(["cherry", "HEAD", branch])
        .current_dir(&repo)
        .output()
    {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            if !text.trim().is_empty() && text.lines().all(|line| line.starts_with('-')) {
                "merged"
            } else {
                "not-merged"
            }
        }
        _ => "unknown",
    }
}

/// Reads one ticket's full markdown (frontmatter + body) for the detail view.
/// `queue` is "open" or "done". Slug-guarded so a crafted name can't escape the
/// tickets dir. Returns the raw file text.
#[tauri::command]
pub fn ticket_read(name: String, queue: String) -> Result<String, String> {
    // ticket slugs are alnum + dash/underscore, longer than a loop name (timestamp
    // + 40-char slug) — guard inline so a crafted name can't escape the dir.
    let name = name.trim().to_string();
    if name.is_empty()
        || name.len() > 128
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid ticket name".into());
    }
    let queue = if queue == "done" { "done" } else { "open" };
    let base = aios_state_dir()
        .map(|d| d.join(format!("dogfood/tickets/{queue}")))
        .ok_or("no HOME")?;
    let path = base.join(format!("{name}.md"));
    std::fs::read_to_string(&path).map_err(|e| format!("read ticket: {e}"))
}

/// Slug guard for a ticket name (alnum + dash/underscore, ≤128).
fn safe_ticket_name(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() || t.len() > 128 {
        return None;
    }
    if t.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Some(t.to_string())
    } else {
        None
    }
}

fn ticket_path(name: &str, queue: &str) -> Result<PathBuf, String> {
    let name = safe_ticket_name(name).ok_or("invalid ticket name")?;
    let queue = if queue == "done" { "done" } else { "open" };
    aios_state_dir()
        .map(|d| d.join(format!("dogfood/tickets/{queue}/{name}.md")))
        .ok_or("no HOME".into())
}

/// Appends a firaz comment to a ticket — the fixer reads these as STEERING
/// instructions (fix this way / ignore that / focus here). Timestamped.
#[tauri::command]
pub fn ticket_comment(name: String, queue: String, text: String) -> Result<(), String> {
    let body = text.trim();
    if body.is_empty() {
        return Err("empty comment".into());
    }
    let path = ticket_path(&name, &queue)?;
    let mut content = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    let stamp = std::process::Command::new("date")
        .arg("+%F %H:%M")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&format!("\n## comment — firaz ({stamp})\n{body}\n"));
    std::fs::write(&path, content).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

/// Sets a ticket's `status:` frontmatter (e.g. "ignored" so the fixer skips it,
/// or "open" to reopen). Adds the field if missing.
#[tauri::command]
pub fn ticket_set_status(name: String, queue: String, status: String) -> Result<(), String> {
    let status = status.trim();
    if status.is_empty()
        || status.len() > 32
        || !status
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("invalid status".into());
    }
    ticket_set_frontmatter_field(&name, &queue, "status", status)
}

/// Sets a ticket's `priority:` frontmatter (`urgent`, `high`, or `normal`).
#[tauri::command]
pub fn ticket_set_priority(name: String, queue: String, priority: String) -> Result<(), String> {
    let priority = priority.trim();
    if !matches!(priority, "urgent" | "high" | "normal") {
        return Err("invalid priority".into());
    }
    ticket_set_frontmatter_field(&name, &queue, "priority", priority)
}

fn ticket_set_frontmatter_field(
    name: &str,
    queue: &str,
    field: &str,
    value: &str,
) -> Result<(), String> {
    let path = ticket_path(&name, &queue)?;
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    let mut out = String::new();
    let mut replaced = false;
    let mut in_fm = false;
    let mut fm_seen = false;
    for line in content.lines() {
        if line.trim() == "---" {
            if !fm_seen {
                in_fm = true;
                fm_seen = true;
            } else if in_fm {
                // closing the frontmatter — inject field if it was never present.
                if !replaced {
                    out.push_str(&format!("{field}: {value}\n"));
                    replaced = true;
                }
                in_fm = false;
            }
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if in_fm && line.trim_start().starts_with(&format!("{field}:")) {
            out.push_str(&format!("{field}: {value}\n"));
            replaced = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    std::fs::write(&path, out).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

/// Deletes a ticket — moved to tickets/.trash (reversible), not hard-removed.
#[tauri::command]
pub fn ticket_delete(name: String, queue: String) -> Result<(), String> {
    let path = ticket_path(&name, &queue)?;
    let name = safe_ticket_name(&name).ok_or("invalid ticket name")?;
    let trash = aios_state_dir()
        .map(|d| d.join("dogfood/tickets/.trash"))
        .ok_or("no HOME")?;
    let _ = std::fs::create_dir_all(&trash);
    std::fs::rename(&path, trash.join(format!("{name}.md"))).map_err(|e| format!("delete: {e}"))?;
    Ok(())
}

/// Deletes an agent's config dir. Best-effort; a missing dir is not an error.
#[tauri::command]
pub fn agent_delete(id: String) -> Result<(), String> {
    let id = safe_id(&id).ok_or("invalid agent id")?;
    let dir = agents_dir().ok_or("no HOME")?.join(&id);
    if dir.exists() {
        // Only remove the config file, NOT sibling state (status/queue/logs the
        // money-agent path may share an id dir with) — surgical so we never nuke
        // unrelated runtime state.
        let _ = std::fs::remove_file(dir.join("config.json"));
    }
    Ok(())
}

/// Slug guard: lowercase alnum + dash/underscore, no path separators, ≤48 chars.
/// Mirrors `normalizeAgentId` on the TS side so ids round-trip identically.
fn safe_id(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.chars().take(48).collect())
    }
}
