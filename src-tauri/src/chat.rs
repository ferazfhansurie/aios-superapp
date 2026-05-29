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
use std::sync::atomic::{AtomicU32, Ordering};
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
) -> Result<u32, String> {
    let mut cmd = Command::new(claude_bin());
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose");

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
    let session = with_sessions(|m| m.get(&session_id).cloned());
    let session = match session {
        Some(s) => s,
        None => return Err(format!("chat session {session_id} not found")),
    };
    let line = user_line(&text);
    let mut stdin = session.stdin.lock();
    stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("failed to write to claude stdin: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("failed to flush claude stdin: {e}"))?;
    Ok(())
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
