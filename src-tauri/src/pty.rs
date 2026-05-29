//! Multi-session PTY manager for the AIOS cockpit.
//!
//! Each terminal pane owns one real PTY (via portable-pty → openpty on unix,
//! ConPTY on Windows). Output is streamed to the frontend over a per-session
//! Tauri `Channel<String>` (NOT the global event bus) so many busy panes stay
//! cheap. A dedicated reader thread per PTY keeps blocking reads off the async
//! runtime; bytes are split on valid UTF-8 boundaries so multibyte sequences
//! never corrupt across reads.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::oracles::tmux_bin;

/// One live PTY-backed session. All fields are behind Mutex so the whole
/// `Session` is `Sync` and can live in shared app state.
struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

/// Shared registry of all live sessions, keyed by an incrementing id.
pub struct PtyState {
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

/// Splits a byte buffer at the last valid UTF-8 boundary, returning the decoded
/// prefix and any trailing incomplete bytes (to be prepended to the next read).
fn split_valid_utf8(buf: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(buf) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid = e.valid_up_to();
            // SAFETY: bytes up to `valid` are guaranteed valid UTF-8 by the check above.
            let s = unsafe { std::str::from_utf8_unchecked(&buf[..valid]) }.to_string();
            (s, buf[valid..].to_vec())
        }
    }
}

/// Core spawn: opens a PTY, runs `cmd`, wires a reader thread → `on_data`, and
/// registers the session. Returns the new session id.
fn spawn_internal(
    app: AppHandle,
    state: &PtyState,
    on_data: Channel<String>,
    cmd: CommandBuilder,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let portable_pty::PtyPair { master, slave } = pair;

    let child = slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Close the slave in the parent so the reader sees EOF when the child exits.
    drop(slave);

    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);

    // Reader thread: blocking reads → UTF-8-safe chunks → per-session Channel.
    thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let (text, rem) = split_valid_utf8(&pending);
                    pending = rem;
                    if !text.is_empty() {
                        if on_data.send(text).is_err() {
                            break; // frontend dropped the channel
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app.emit("pty-exit", id);
    });

    let session = Arc::new(Session {
        master: Mutex::new(master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });
    state.sessions.lock().insert(id, session);
    Ok(id)
}

/// Spawns the user's login shell in a new PTY pane.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    on_data: Channel<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    match cwd {
        Some(dir) if !dir.is_empty() => cmd.cwd(dir),
        _ => {
            if let Ok(home) = std::env::var("HOME") {
                cmd.cwd(home);
            }
        }
    }
    spawn_internal(app, &state, on_data, cmd, cols, rows)
}

/// Attaches a pane to a bridge-managed oracle tmux session (`aios-<identity>`
/// on socket `adletic`). `exec` replaces the shell so closing the pane detaches
/// the tmux client without killing the underlying oracle session.
#[tauri::command]
pub fn pty_spawn_oracle(
    app: AppHandle,
    state: State<PtyState>,
    on_data: Channel<String>,
    identity: String,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let tmux = tmux_bin();
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.arg("-c");
    cmd.arg(format!("exec {} -L adletic attach -t aios-{}", tmux, identity));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    spawn_internal(app, &state, on_data, cmd, cols, rows)
}

/// Attaches a pane to ANY tmux session on a given socket — the all-tmux attach
/// surface (oracles, the bridge, even the session you're typing in now). `exec`
/// replaces the shell so closing the pane detaches the client without killing
/// the underlying session.
#[tauri::command]
pub fn pty_spawn_tmux(
    app: AppHandle,
    state: State<PtyState>,
    on_data: Channel<String>,
    socket: String,
    session: String,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    // Guard against shell-injection via socket/session names.
    let safe = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !safe(&socket) || !safe(&session) {
        return Err("invalid socket or session name".into());
    }
    let tmux = tmux_bin();
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.arg("-c");
    cmd.arg(format!("exec {tmux} -L {socket} attach -t {session}"));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    spawn_internal(app, &state, on_data, cmd, cols, rows)
}

/// Writes raw input bytes to a session's PTY stdin.
#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let session = state.sessions.lock().get(&id).cloned();
    if let Some(s) = session {
        let mut w = s.writer.lock();
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Propagates a terminal resize to a session's PTY.
#[tauri::command]
pub fn pty_resize(state: State<PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let session = state.sessions.lock().get(&id).cloned();
    if let Some(s) = session {
        s.master
            .lock()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Kills a session: removes it from the registry and terminates the child.
/// For an oracle pane this kills only the `tmux attach` client (the oracle
/// session keeps running under the bridge).
#[tauri::command]
pub fn pty_kill(state: State<PtyState>, id: u32) -> Result<(), String> {
    let removed = state.sessions.lock().remove(&id);
    if let Some(s) = removed {
        let _ = s.child.lock().kill();
    }
    Ok(())
}
