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
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    // Snapshot the launchd-loaded loop labels ONCE (one `launchctl list` for the
    // whole listing) rather than per-loop.
    let loaded = launchctl_loaded_labels();
    let mut out = Vec::new();
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
        let log_path = dir.join(format!("{name}.log"));
        let last_log = std::fs::read_to_string(&log_path)
            .ok()
            .and_then(|t| {
                t.lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .last()
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();
        // status: launchctl-loaded → running; the dogfood loop has a reversible
        // soft-pause via its STOP flag (loaded but idle) → paused; not loaded →
        // stopped (plist on disk, restartable).
        let loaded = loaded.contains(&format!("{LOOP_LABEL_PREFIX}-{name}"));
        let paused = name == "aios-dogfood" && dogfood_stop_present();
        let status = if paused {
            "paused"
        } else if loaded {
            "running"
        } else {
            "stopped"
        };
        out.push(serde_json::json!({
            "name": name,
            "cadence": cadence,
            "command": command,
            "status": status,
            "lastLog": last_log,
        }));
    }
    out.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    out
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

fn loop_plist_path(name: &str) -> Option<PathBuf> {
    Some(launch_agents_dir()?.join(format!("{LOOP_LABEL_PREFIX}-{name}.plist")))
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
                if label.starts_with(LOOP_LABEL_PREFIX) {
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
    let plist = loop_plist_path(&name).ok_or("no HOME")?;
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
    let plist = loop_plist_path(&name).ok_or("no HOME")?;
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
    for part in command.split_whitespace() {
        cmd.arg(part);
    }
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
    for (i, part) in parts.iter().enumerate() {
        // launchd plists need absolute program paths (no shell PATH) — expand a
        // bare leading `aios-agent` to ~/.aios/state/bin/aios-agent.
        if i == 0 && part == "aios-agent" {
            cmd.arg(state.join("bin/aios-agent"));
        } else {
            cmd.arg(part);
        }
    }
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
            let (mut source, mut priority, mut status, mut created) =
                (String::new(), String::new(), String::new(), String::new());
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
