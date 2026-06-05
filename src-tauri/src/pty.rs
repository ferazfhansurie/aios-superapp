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

/// Shared registry of all live sessions, keyed by an incrementing id. The map
/// is behind an `Arc` so a session's reader thread can hold a handle and remove
/// itself when the child exits (B4) without borrowing `&self`.
pub struct PtyState {
    sessions: Arc<Mutex<HashMap<u32, Arc<Session>>>>,
    next_id: AtomicU32,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU32::new(1),
        }
    }

    /// A cloned handle to the shared session map — for the reader thread to
    /// evict its own entry on child exit.
    fn sessions_handle(&self) -> Arc<Mutex<HashMap<u32, Arc<Session>>>> {
        Arc::clone(&self.sessions)
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

    // The reader thread needs to drop the session from the registry when the
    // child exits (B4) — otherwise dead PTYs leak AND `pty_write` keeps finding
    // the corpse and write_all's into a dead master (error swallowed by the
    // frontend's `.catch(()=>{})`), so the user types into nothing with zero
    // feedback. Clone the sessions Arc-map into the thread so it can self-remove.
    let sessions = state.sessions_handle();

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
        // Child exited / reader EOF: evict the session BEFORE announcing the
        // exit, so any pty_write racing the exit notification can't land on a
        // dead master. Dropping the Arc<Session> here also frees the PTY master.
        sessions.lock().remove(&id);
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

/// Resolves the shell to launch on Windows. Honors `$SHELL` if the user set one,
/// otherwise prefers PowerShell 7 (`pwsh.exe`) and falls back to the built-in
/// Windows PowerShell — always an ABSOLUTE path so the PTY layer never depends on
/// PATH resolution (a common cause of a terminal that opens but can't be typed
/// into because the shell never actually spawned).
#[allow(dead_code)]
fn windows_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() {
            return s;
        }
    }
    let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    let pwsh = format!(r"{program_files}\PowerShell\7\pwsh.exe");
    if std::path::Path::new(&pwsh).exists() {
        return pwsh;
    }
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    format!(r"{system_root}\System32\WindowsPowerShell\v1.0\powershell.exe")
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
    let mut cmd = if cfg!(windows) {
        // On Windows there's no SHELL/login-shell convention; launch PowerShell by
        // absolute path and skip the `-l` login flag.
        CommandBuilder::new(windows_shell())
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut c = CommandBuilder::new(shell);
        c.arg("-l");
        c
    };
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    match cwd {
        Some(dir) if !dir.is_empty() => cmd.cwd(dir),
        _ => {
            if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
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
    #[cfg(windows)]
    {
        let _ = (app, state, on_data, identity, cols, rows);
        return Err("oracle tmux attach is not supported on windows yet".into());
    }
    #[cfg(not(windows))]
    {
        let tmux = tmux_bin();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        // enable mouse so the wheel scrolls inside tmux (it owns the alt-screen, so
        // xterm's own scrollback is bypassed), then attach.
        cmd.arg(format!(
        "{tmux} -L adletic set -g mouse on 2>/dev/null; exec {tmux} -L adletic attach -t aios-{identity}"
    ));
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        spawn_internal(app, &state, on_data, cmd, cols, rows)
    }
}

/// Attaches a pane to a PERSISTENT terminal tmux session (`aios-term-<name>` on
/// socket `adletic`), creating it on first use. Unlike `pty_spawn`'s ephemeral
/// login shell, this session lives on the tmux daemon — so closing the pane (or
/// quitting the whole app) only detaches the `tmux attach` client; the shell (or
/// whatever `cmd` ran, e.g. `claude`) keeps running and is reattachable later.
///
/// `cmd` is the session's startup command — passed to `new-session` so a "claude
/// code" pane boots claude inside the persistent session. `None` → a login shell.
///
/// tmux is Unix-only, so persistence (detach/reattach, survive-app-close) only
/// works on unix. On Windows we still expose the SAME command — it just spawns a
/// normal (non-persistent) PowerShell PTY, optionally running `cmd` (e.g. the
/// "claude code" pane boots `claude`). This keeps the command registered on every
/// platform so the frontend's `spawnTerminal` invoke never 404s.
#[cfg(windows)]
#[tauri::command]
pub fn pty_spawn_terminal(
    app: AppHandle,
    state: State<PtyState>,
    on_data: Channel<String>,
    name: String,
    cmd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let _ = name; // no tmux session name on Windows (no persistence)
    let shell = windows_shell();
    let mut cmdb = CommandBuilder::new(&shell);
    let startup = cmd.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    // Boot the startup command (e.g. `claude --dangerously-skip-permissions`) as
    // the shell's OWN launch argument rather than typing it into the PTY after
    // spawn. Injecting keystrokes races PowerShell's PSReadLine init — early
    // bytes get swallowed and `claude` never starts (the "claude code pane does
    // nothing" bug). `-NoExit` keeps the shell alive after claude exits so the
    // pane stays usable; on a bare PowerShell shell the binary resolves `claude`
    // (a `claude.cmd`/`claude.exe` shim) from PATH.
    if let Some(c) = &startup {
        let is_powershell = shell.to_lowercase().contains("powershell")
            || shell.to_lowercase().ends_with("pwsh.exe");
        if is_powershell {
            cmdb.arg("-NoExit");
            cmdb.arg("-Command");
            cmdb.arg(c);
        } else {
            // cmd.exe or another shell: /k keeps it open after the command.
            cmdb.arg("/k");
            cmdb.arg(c);
        }
    }
    cmdb.env("TERM", "xterm-256color");
    cmdb.env("COLORTERM", "truecolor");
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        cmdb.cwd(home);
    }
    spawn_internal(app, &state, on_data, cmdb, cols, rows)
}

#[cfg(unix)]
#[tauri::command]
pub fn pty_spawn_terminal(
    app: AppHandle,
    state: State<PtyState>,
    on_data: Channel<String>,
    name: String,
    cmd: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    // Guard against shell-injection via the pane-derived session name.
    let safe = |s: &str| {
        s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    };
    if name.is_empty() || !safe(&name) {
        return Err("invalid terminal name".into());
    }
    let tmux = tmux_bin();
    let session = format!("aios-term-{name}");
    // Single-quote for the outer `sh -c` so spaces/args survive.
    let sq = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    // Optional start directory — `new-session -c <dir>`. Drives "run project"
    // (the command MUST execute in the project root, else `npm run`/`flutter run`
    // fail in $HOME and the pane exits). Only applied when the dir exists.
    let cdir = cwd
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty() && std::path::Path::new(c).is_dir())
        .map(|c| format!(" -c {}", sq(c)))
        .unwrap_or_default();
    // Build the optional startup command for `new-session`. tmux runs it via its
    // own default-shell, so a bare string like `claude` is fine; empty → login shell.
    let startup = cmd
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .unwrap_or_default();
    // `new-session -A -d` is atomic create-or-noop: it creates the session
    // detached if absent and is a harmless no-op (NOT a re-launch of `cmd`) if it
    // already exists. This replaces the old `has-session || new-session` pair,
    // whose gap before `attach` was a TOCTOU race — if the session wasn't present
    // at attach time tmux printed `can't find session: aios-term-<name>`. With
    // `-A` the session is GUARANTEED to exist before we attach, so that error
    // class is gone.
    let create = if startup.is_empty() {
        let login_shell = "exec ${SHELL:-/bin/zsh} -l";
        format!(
            "{tmux} -L adletic new-session -A -d -s {session}{cdir} {}",
            sq(login_shell)
        )
    } else {
        // Run the command, then drop to an interactive shell so the pane STAYS
        // ALIVE after the command finishes or errors (a VS Code-style run
        // terminal: logs remain, you can re-run) instead of the tmux session
        // dying the instant the command exits.
        let keepalive = format!(
            "exec ${{SHELL:-/bin/zsh}} -lc {}",
            sq(&format!("{startup}; exec ${{SHELL:-/bin/zsh}} -l"))
        );
        format!(
            "{tmux} -L adletic new-session -A -d -s {session}{cdir} {}",
            sq(&keepalive)
        )
    };
    let mut cmdb = CommandBuilder::new("/bin/sh");
    cmdb.arg("-c");
    // Ensure the session exists (atomic), enable mouse so the wheel scrolls inside
    // tmux (it owns the alt-screen, bypassing xterm's scrollback), then attach.
    // `exec` replaces the shell so closing the pane detaches the client — see
    // pty_kill. mouse is also set globally in ~/.config/adletic/tmux.conf; this
    // inline set is a belt-and-braces fallback for a server started without it.
    cmdb.arg(format!(
        "{create} 2>/dev/null; \
         {tmux} -L adletic set -g mouse on 2>/dev/null; \
         exec {tmux} -L adletic attach -t {session}"
    ));
    cmdb.env("TERM", "xterm-256color");
    cmdb.env("COLORTERM", "truecolor");
    spawn_internal(app, &state, on_data, cmdb, cols, rows)
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
    #[cfg(windows)]
    {
        let _ = (app, state, on_data, socket, session, cols, rows);
        return Err("tmux attach is not supported on windows yet".into());
    }
    #[cfg(not(windows))]
    {
        // Guard against shell-injection via socket/session names.
        let safe = |s: &str| {
            s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        };
        if !safe(&socket) || !safe(&session) {
            return Err("invalid socket or session name".into());
        }
        let tmux = tmux_bin();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg(format!(
        "{tmux} -L {socket} set -g mouse on 2>/dev/null; exec {tmux} -L {socket} attach -t {session}"
    ));
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        spawn_internal(app, &state, on_data, cmd, cols, rows)
    }
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
///
/// For any tmux-backed pane (oracle, all-tmux, OR a persistent terminal spawned
/// via `pty_spawn_terminal`) the child PTY runs the `tmux attach` process, not
/// the tmux session itself — so killing it merely DETACHES the client. Closing
/// the pane = detach; the `aios-term-*` (or `aios-*`) session keeps running on
/// the tmux daemon and is reattachable later. The session only dies when its own
/// process exits or someone explicitly `kill-session`s it.
#[tauri::command]
pub fn pty_kill(state: State<PtyState>, id: u32) -> Result<(), String> {
    let removed = state.sessions.lock().remove(&id);
    if let Some(s) = removed {
        let _ = s.child.lock().kill();
    }
    Ok(())
}

/// Startup reaper (B2): kills orphaned `aios-term-*` tmux sessions on the oracle
/// socket that have NO corresponding restored pane. Without this, B1's old
/// new-key-every-launch behaviour (now fixed) plus normal pane churn leaves
/// zombie sessions — often a `claude` still burning context — accumulating
/// forever (`pty_kill` only detaches the attach client; nothing ever
/// kill-sessions them).
///
/// `keep` is the set of `aios-term-<name>` SESSION SUFFIXES that map to live
/// restored panes (the frontend passes each pane's `termSessionName`). We list
/// every `aios-term-*` session and `kill-session` only those NOT in `keep` —
/// conservative by design: an unknown session is reaped only when it provably
/// has no pane. Non-unix / no-tmux → no-op. Returns the names reaped.
#[tauri::command]
pub fn pty_reap_terminals(keep: Vec<String>) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let _ = keep;
        Ok(Vec::new())
    }
    #[cfg(not(windows))]
    {
        use std::collections::HashSet;
        let tmux = tmux_bin();
        // The full session names we must preserve, e.g. `aios-term-k3-abcd`.
        let keep: HashSet<String> = keep
            .into_iter()
            .map(|n| format!("aios-term-{n}"))
            .collect();
        let output = std::process::Command::new(&tmux)
            .args(["-L", "adletic", "list-sessions", "-F", "#{session_name}"])
            .output()
            .map_err(|e| format!("failed to run tmux: {e}"))?;
        // No server / no sessions → tmux exits non-zero; treat as "nothing to do".
        if !output.status.success() {
            return Ok(Vec::new());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut reaped = Vec::new();
        for line in stdout.lines() {
            let name = line.trim();
            if name.is_empty() || !name.starts_with("aios-term-") {
                continue;
            }
            if keep.contains(name) {
                continue; // has a live pane → leave it running
            }
            let killed = std::process::Command::new(&tmux)
                .args(["-L", "adletic", "kill-session", "-t", name])
                .output();
            if matches!(killed, Ok(o) if o.status.success()) {
                reaped.push(name.to_string());
            }
        }
        Ok(reaped)
    }
}
