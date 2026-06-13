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
        eprintln!("[aios control] no free port in {BASE_PORT}..{} — disabled", BASE_PORT + PORT_SCAN);
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
        let _ = write_response(&mut stream, 200, "{\"ok\":true,\"service\":\"aios-control\"}");
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
            let _ = write_response(&mut stream, 400, &format!("{{\"error\":\"bad json: {e}\"}}"));
            return;
        }
    };
    let cmd = payload.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
    match cmd {
        "run-agent" | "open-pane" => {
            // DO NOT touch panes from Rust — emit so the frontend (where panes +
            // chat sessions live) handles it. This is the whole point of the hook.
            if let Err(e) = app.emit("control-command", payload) {
                let _ = write_response(&mut stream, 500, &format!("{{\"error\":\"emit failed: {e}\"}}"));
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
                l.split_once(':').and_then(|(_, v)| v.trim().parse::<usize>().ok())
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
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.chars().take(48).collect())
    }
}
