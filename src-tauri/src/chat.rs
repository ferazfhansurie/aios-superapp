//! Codex-style chat sessions backed by the local `claude` binary in headless
//! streaming-JSON mode.
//!
//! Unlike the PTY panes (`pty.rs`), a chat session is NOT a terminal — there is
//! no TUI to scrape. Instead we spawn:
//!
//!   claude -p \
//!     --output-format stream-json \
//!     --input-format stream-json \
//!     --include-partial-messages \
//!     --verbose \
//!     [--model <id>] [--permission-mode <mode>]
//!
//! which:
//!   (a) reads newline-delimited JSON *user* lines on stdin, each shaped:
//!       {"type":"user","message":{"role":"user",
//!         "content":[{"type":"text","text":"..."}]}}
//!   (b) emits newline-delimited JSON *events* on stdout — `system` (init/hooks),
//!       `assistant` (with content[] of thinking/text/tool_use), `stream_event`
//!       (content_block_delta → text_delta for token streaming), `result`
//!       (final text + usage), `rate_limit_event`, etc.
//!   (c) STAYS ALIVE between turns: the process blocks on stdin after each
//!       result, so one process serves the whole conversation. We just write
//!       another user line per turn — no `--resume` plumbing needed.
//!
//! This was verified live against claude 2.1.156 (see the chat.ts header for the
//! captured exchange). Mode used: **interactive stream-json stdin** (the primary
//! path the prompt asked for — the one-shot `--resume` fallback was NOT needed).
//!
//! Each session streams its raw stdout JSON lines, untouched, to the frontend
//! over a per-session Tauri `Channel<String>` — exactly the pattern in `pty.rs`.
//! The component (`ChatPane.tsx`) parses the JSON; Rust stays a dumb pipe so the
//! event schema can evolve without touching this file. Reads are split on valid
//! UTF-8 boundaries and re-joined into whole lines so multibyte sequences and
//! split JSON lines never corrupt a frame.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

/// One live chat session: the spawned `claude` child plus a handle to its
/// stdin so we can push subsequent user turns. Both are behind a `Mutex` so the
/// whole `ChatSession` is `Sync` and lives happily in shared state.
struct ChatSession {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
}

/// Module-level registry of every live chat session, keyed by an incrementing
/// id. Mirrors `PtyState` but as a `static` (the prompt asked for a module-level
/// `static` Mutex<HashMap>) so no Tauri `State` wiring is required in `lib.rs`.
static SESSIONS: Mutex<Option<HashMap<u32, Arc<ChatSession>>>> = Mutex::new(None);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
/// Monotonic counter for control_request `request_id`s (interrupts, decisions).
static NEXT_REQ: AtomicU64 = AtomicU64::new(1);

/// Runs `f` against the (lazily-initialised) session map.
fn with_sessions<R>(f: impl FnOnce(&mut HashMap<u32, Arc<ChatSession>>) -> R) -> R {
    let mut guard = SESSIONS.lock();
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// Resolves the `claude` binary. It's normally on PATH; if a bare `claude`
/// can't be found at spawn time we fall back to common install locations
/// (homebrew, nvm-managed npm global, the official native installer). We return
/// a plain command string here and rely on `Command`'s PATH lookup first.
fn claude_bin() -> String {
    // Honour an explicit override if the cockpit ever sets one.
    if let Ok(p) = std::env::var("AIOS_CLAUDE_BIN") {
        if !p.is_empty() {
            return p;
        }
    }
    let candidates = [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ];
    for c in candidates {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }
    // Try the user's HOME-based installs (native installer / nvm current).
    if let Ok(home) = std::env::var("HOME") {
        let native = format!("{home}/.local/bin/claude");
        if std::path::Path::new(&native).exists() {
            return native;
        }
        let claude_local = format!("{home}/.claude/local/claude");
        if std::path::Path::new(&claude_local).exists() {
            return claude_local;
        }
    }
    // Default: let the OS resolve it from PATH.
    "claude".to_string()
}

/// JSON-escapes a string for embedding in the stream-json user line. We build
/// the line by hand (rather than pulling a serializer into the hot path) since
/// the shape is fixed and tiny; only the text field is untrusted.
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Builds one newline-delimited stream-json user line for `text`.
fn user_line(text: &str) -> String {
    format!(
        "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}\n",
        json_escape(text)
    )
}

/// Writes one already-formed line to a live session's stdin, flushing it. Shared
/// by every "push a line to claude" path (turns, interrupts, control replies).
/// `line` should already end in `\n`. No-op error text if the session is gone.
fn write_line(session_id: u32, line: &str) -> Result<(), String> {
    let session = with_sessions(|m| m.get(&session_id).cloned());
    let session = match session {
        Some(s) => s,
        None => return Err(format!("chat session {session_id} not found")),
    };
    let mut stdin = session.stdin.lock();
    stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("failed to write to claude stdin: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("failed to flush claude stdin: {e}"))?;
    Ok(())
}

/// Splits a byte buffer at the last valid UTF-8 boundary, returning the decoded
/// prefix and any trailing incomplete bytes. Identical strategy to `pty.rs`.
fn split_valid_utf8(buf: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(buf) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid = e.valid_up_to();
            // SAFETY: bytes up to `valid` are guaranteed valid UTF-8 above.
            let s = unsafe { std::str::from_utf8_unchecked(&buf[..valid]) }.to_string();
            (s, buf[valid..].to_vec())
        }
    }
}

/// Spawns a fresh `claude` chat process in interactive stream-json mode, wires a
/// reader thread that forwards each complete stdout JSON *line* over `on_event`,
/// registers the session, and returns its id.
///
/// `cwd` sets the working directory (so tool calls operate in the right repo);
/// `model` is a model id or alias (e.g. `claude-opus-4-8` / `opus`);
/// `permission_mode` is one of claude's modes (`bypassPermissions`, `plan`,
/// `default`, `acceptEdits`, ...). All optional.
#[tauri::command]
pub fn chat_start(
    app: AppHandle,
    on_event: Channel<String>,
    cwd: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    effort: Option<String>,
    resume: Option<String>,
) -> Result<u32, String> {
    let mut cmd = Command::new(claude_bin());
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose");

    // resume a prior session id (continues that conversation's history)
    if let Some(r) = resume.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(r);
    }
    if let Some(m) = model.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("--model").arg(m);
    }
    if let Some(pm) = permission_mode.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("--permission-mode").arg(pm);
    }
    // reasoning effort: low | medium | high | xhigh | max
    if let Some(ef) = effort.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("--effort").arg(ef);
    }
    match cwd {
        Some(dir) if !dir.is_empty() => {
            cmd.current_dir(dir);
        }
        _ => {
            if let Ok(home) = std::env::var("HOME") {
                cmd.current_dir(home);
            }
        }
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Merge nothing from stderr into the event stream — surface it on its
        // own so a missing-binary / auth error doesn't masquerade as JSON.
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn claude: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to capture claude stdin".to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture claude stdout".to_string())?;
    let stderr = child.stderr.take();

    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);

    // stdout reader: blocking reads → UTF-8-safe → split into whole lines →
    // forward each complete JSON line over the per-session Channel. Partial
    // lines (no trailing '\n' yet) are buffered until the rest arrives.
    let stdout_chan = on_event.clone();
    let app_exit = app.clone();
    thread::spawn(move || {
        let mut pending_bytes: Vec<u8> = Vec::new();
        let mut line_buf = String::new();
        let mut buf = [0u8; 16384];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending_bytes.extend_from_slice(&buf[..n]);
                    let (text, rem) = split_valid_utf8(&pending_bytes);
                    pending_bytes = rem;
                    line_buf.push_str(&text);
                    // Emit every complete line; keep the trailing partial.
                    while let Some(nl) = line_buf.find('\n') {
                        let line: String = line_buf.drain(..=nl).collect();
                        let trimmed = line.trim_end_matches(['\n', '\r']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        if stdout_chan.send(trimmed.to_string()).is_err() {
                            return; // frontend dropped the channel
                        }
                    }
                }
                Err(_) => break,
            }
        }
        // Flush any final unterminated line.
        let tail = line_buf.trim_end_matches(['\n', '\r']);
        if !tail.is_empty() {
            let _ = stdout_chan.send(tail.to_string());
        }
        let _ = app_exit.emit("chat-exit", id);
    });

    // stderr reader: forward as synthetic error events so the UI can show why a
    // session died (missing binary, not logged in, bad flag) without crashing.
    if let Some(mut err) = stderr {
        let err_chan = on_event.clone();
        thread::spawn(move || {
            let mut pending_bytes: Vec<u8> = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                match err.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending_bytes.extend_from_slice(&buf[..n]);
                        let (text, rem) = split_valid_utf8(&pending_bytes);
                        pending_bytes = rem;
                        for raw in text.split('\n') {
                            let line = raw.trim();
                            if line.is_empty() {
                                continue;
                            }
                            let ev = format!(
                                "{{\"type\":\"aios_stderr\",\"text\":\"{}\"}}",
                                json_escape(line)
                            );
                            if err_chan.send(ev).is_err() {
                                return;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    let session = Arc::new(ChatSession {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
    });
    with_sessions(|m| m.insert(id, session));
    Ok(id)
}

/// Sends one user turn into a live chat session by writing a newline-delimited
/// stream-json user line to the child's stdin. The reply streams back over the
/// session's Channel (set at `chat_start`). No-op if the session is gone.
#[tauri::command]
pub fn chat_send(session_id: u32, text: String) -> Result<(), String> {
    write_line(session_id, &user_line(&text))
}

/// Interrupts the in-flight turn of a live chat session.
///
/// Uses claude's stream-json **control protocol** (verified live against claude
/// 2.1.156): we write a `control_request` with `subtype:"interrupt"` to stdin.
/// claude replies on stdout with
/// `{"type":"control_response","response":{"subtype":"success","request_id":..}}`
/// and ends the current turn with a `result` of subtype `error_during_execution`.
/// Crucially the **process stays alive** — the very next `chat_send` runs a new
/// turn normally — so this is a true interrupt, not a kill/respawn. The frontend
/// stops consuming deltas and re-enables the composer when it sees the result.
#[tauri::command]
pub fn chat_interrupt(session_id: u32) -> Result<(), String> {
    let rid = NEXT_REQ.fetch_add(1, Ordering::SeqCst);
    let line = format!(
        "{{\"type\":\"control_request\",\"request_id\":\"int-{rid}\",\"request\":{{\"subtype\":\"interrupt\"}}}}\n"
    );
    write_line(session_id, &line)
}

/// Writes a raw, already-formed JSON line to a session's stdin (must end in
/// `\n`). Used by the frontend to reply to claude's control protocol — e.g.
/// permission/approval decisions in `default` mode, which arrive as a
/// `control_request` with `subtype:"can_use_tool"` and expect a matching
/// `control_response`. Kept generic so the control schema can evolve in TS
/// without touching Rust (same philosophy as the dumb-pipe stdout reader).
#[tauri::command]
pub fn chat_send_raw(session_id: u32, line: String) -> Result<(), String> {
    let line = if line.ends_with('\n') {
        line
    } else {
        format!("{line}\n")
    };
    write_line(session_id, &line)
}

/// Kills a chat session and removes it from the registry. Defensive: ignores
/// errors from an already-dead child. Dropping the stored `ChildStdin` closes
/// the pipe, which lets the child exit cleanly if `kill` raced.
#[tauri::command]
pub fn chat_stop(session_id: u32) -> Result<(), String> {
    let removed = with_sessions(|m| m.remove(&session_id));
    if let Some(s) = removed {
        let _ = s.child.lock().kill();
        let _ = s.child.lock().wait();
    }
    Ok(())
}

/// One past chat session the user had IN the chat pane (not arbitrary terminal
/// claude sessions) — surfaced to the `/resume` picker.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ChatSessionInfo {
    /// The claude session id — passed to `--resume` to continue it.
    pub id: String,
    /// A human title (the first user message).
    pub title: String,
    /// The working dir the chat ran in.
    pub cwd: String,
    /// Last-used unix seconds, for recency sorting.
    pub mtime: u64,
}

/// One rendered turn loaded from a transcript, to repaint a resumed conversation.
#[derive(serde::Serialize)]
pub struct ChatTurn {
    pub role: String, // "user" | "assistant"
    pub text: String,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sessions_store() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(std::path::PathBuf::from(home).join(".aios/state/chat-sessions.json"))
}

fn load_store() -> Vec<ChatSessionInfo> {
    sessions_store()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<ChatSessionInfo>>(&s).ok())
        .unwrap_or_default()
}

/// Records (upserts) a chat-pane session so `/resume` can list ONLY the chats
/// started here. Called by the frontend when a session's `system init` arrives.
#[tauri::command]
pub fn record_chat_session(id: String, title: String, cwd: Option<String>) -> Result<(), String> {
    if id.trim().is_empty() {
        return Ok(());
    }
    let mut store = load_store();
    let trimmed = {
        let t = title.trim().replace('\n', " ");
        if t.chars().count() > 90 {
            format!("{}…", t.chars().take(90).collect::<String>())
        } else if t.is_empty() {
            "(untitled chat)".to_string()
        } else {
            t
        }
    };
    let now = now_secs();
    if let Some(existing) = store.iter_mut().find(|s| s.id == id) {
        existing.mtime = now;
        if !title.trim().is_empty() {
            existing.title = trimmed;
        }
    } else {
        store.push(ChatSessionInfo {
            id,
            title: trimmed,
            cwd: cwd.unwrap_or_default(),
            mtime: now,
        });
    }
    store.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    store.truncate(200);
    if let Some(path) = sessions_store() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        if let Ok(json) = serde_json::to_string(&store) {
            let _ = std::fs::write(&tmp, json);
            let _ = std::fs::rename(&tmp, &path);
        }
    }
    Ok(())
}

/// Lists chat-pane sessions (from the store), newest first.
#[tauri::command]
pub fn list_chat_sessions(limit: Option<u32>) -> Vec<ChatSessionInfo> {
    let mut store = load_store();
    store.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    store.truncate(limit.unwrap_or(40) as usize);
    store
}

/// Loads a past session's conversation (user + assistant text turns) so the pane
/// can repaint it before resuming. Finds `~/.claude/projects/*/<id>.jsonl`.
#[tauri::command]
pub fn read_chat_transcript(id: String) -> Vec<ChatTurn> {
    let Ok(home) = std::env::var("HOME") else {
        return Vec::new();
    };
    let projects = std::path::PathBuf::from(&home).join(".claude/projects");
    let Ok(dirs) = std::fs::read_dir(&projects) else {
        return Vec::new();
    };
    let mut file: Option<std::path::PathBuf> = None;
    for dir in dirs.flatten() {
        let cand = dir.path().join(format!("{id}.jsonl"));
        if cand.is_file() {
            file = Some(cand);
            break;
        }
    }
    let Some(fp) = file else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(&fp) else {
        return Vec::new();
    };
    let mut turns = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let role = match v.get("type").and_then(|t| t.as_str()) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let Some(msg) = v.get("message") else { continue };
        let mut text_acc = String::new();
        if let Some(s) = msg.get("content").and_then(|c| c.as_str()) {
            text_acc.push_str(s);
        } else if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
            for b in arr {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        text_acc.push_str(t);
                    }
                }
            }
        }
        let text_acc = text_acc.trim().to_string();
        if !text_acc.is_empty() {
            turns.push(ChatTurn { role: role.to_string(), text: text_acc });
        }
    }
    turns
}
