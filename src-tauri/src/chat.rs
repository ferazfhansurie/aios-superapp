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

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

// Engine-agnostic wire format + the `Engine` tag now live in `aios-chat-core`
// so the headless `aios-noded` daemon shares them verbatim (cross-machine sync).
use aios_chat_core::adapt::{
    adapt_codex_line, adapt_opencode_line, codex_delta_is_answer, codex_effort, codex_input_items,
    codex_is_action_item, codex_item_id, codex_item_is_error, codex_tool_input, codex_tool_name,
    codex_tool_result_text, codex_usage_event, codex_usage_to_claude,
};
use aios_chat_core::session::{buffer_push, fan_out, fan_out_split, ChatSession};
use aios_chat_core::wire::{
    assistant_text_line, assistant_thinking_line, assistant_tool_use_line, json_escape,
    slim_user_image_line, text_delta_line, thinking_delta_line, user_line, user_line_with_images,
    user_tool_result_line,
};
use aios_chat_core::{Engine, OutputSink};

/// The Tauri-shell implementation of [`OutputSink`]: forwards each adapted line
/// over a per-session `tauri::ipc::Channel<String>`. This is the ONE place the
/// core's sink seam binds to Tauri on the laptop; `aios-noded` will provide a
/// WebSocket-backed sink instead. Sends are lossy on a dropped receiver (a closed
/// pane), exactly as before — the reader thread never wedges on a dead channel.
struct ChannelSink(Channel<String>);

impl OutputSink for ChannelSink {
    fn send(&self, line: &str) {
        let _ = self.0.send(line.to_string());
    }
}

fn detach_child_process(cmd: &mut Command) {
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
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
    #[cfg(windows)]
    {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            for rel in [r".local\bin\claude.exe", r".claude\local\claude.exe"] {
                let p = std::path::Path::new(&home).join(rel);
                if p.exists() {
                    return p.to_string_lossy().into_owned();
                }
            }
        }
        if let Some(p) = which_on_path("claude.exe").or_else(|| which_on_path("claude.cmd")) {
            return p;
        }
        return "claude.exe".to_string();
    }
    #[cfg(not(windows))]
    {
        let candidates = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
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
}

#[cfg(windows)]
fn which_on_path(exe: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Resolves a CLI binary that's normally on PATH but may live under an
/// nvm-managed node bin (GUI-launched apps don't inherit the user's shell PATH).
/// Checks an explicit env override, common global locations, then PATH.
fn resolve_bin(name: &str, env_override: &str, extra: &[&str]) -> String {
    if let Ok(p) = std::env::var(env_override) {
        if !p.is_empty() {
            return p;
        }
    }
    let mut candidates: Vec<String> = vec![
        format!("/opt/homebrew/bin/{name}"),
        format!("/usr/local/bin/{name}"),
    ];
    for e in extra {
        candidates.push(e.to_string());
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!("{home}/.local/bin/{name}"));
        // nvm: pick the newest versioned bin that has the binary.
        let nvm = format!("{home}/.nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm) {
            let mut versions: Vec<_> = entries.flatten().map(|e| e.path()).collect();
            versions.sort();
            versions.reverse();
            for v in versions {
                candidates.push(v.join(format!("bin/{name}")).to_string_lossy().to_string());
            }
        }
    }
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    name.to_string()
}

/// Resolves the `codex` binary (OpenAI Codex CLI — drives the ChatGPT sub).
/// Resolves the *native* Codex binary — a real executable, not the
/// `#!/usr/bin/env node` shebang launcher (`codex.js`) that the nvm global
/// install puts on PATH. GUI-launched apps (Finder/Dock) inherit no `node` on
/// PATH, so the launcher's shebang dies; the vendored native binary runs
/// standalone (and skips node startup, a small latency win). Returns `None` on
/// platforms / layouts we don't recognise, so the caller falls back to the
/// generic resolver (which still works in dev/terminal launches).
fn codex_native_bin() -> Option<String> {
    // npm platform sub-package + vendor target-triple for this host.
    let (pkg, triple) = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        ("codex-darwin-arm64", "aarch64-apple-darwin")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        ("codex-darwin-x64", "x86_64-apple-darwin")
    } else {
        return None;
    };
    let rel = format!(
        "lib/node_modules/@openai/codex/node_modules/@openai/{pkg}/vendor/{triple}/bin/codex"
    );
    let home = std::env::var("HOME").ok()?;
    // nvm global: newest version dir whose vendored native binary exists.
    let nvm = format!("{home}/.nvm/versions/node");
    let entries = std::fs::read_dir(&nvm).ok()?;
    let mut versions: Vec<std::path::PathBuf> = entries.flatten().map(|e| e.path()).collect();
    versions.sort();
    versions.reverse();
    for v in versions {
        let cand = v.join(&rel);
        if cand.exists() {
            return Some(cand.to_string_lossy().into_owned());
        }
    }
    None
}

/// Resolves the `codex` binary (OpenAI Codex CLI — drives the ChatGPT sub).
/// Prefers the native binary so it works in GUI-launched apps; the explicit
/// `AIOS_CODEX_BIN` override always wins, and we fall back to the generic
/// PATH/nvm resolver if no native binary is found.
fn codex_bin() -> String {
    if let Ok(p) = std::env::var("AIOS_CODEX_BIN") {
        if !p.is_empty() {
            return p;
        }
    }
    if let Some(native) = codex_native_bin() {
        return native;
    }
    resolve_bin("codex", "AIOS_CODEX_BIN", &[])
}

/// Resolves the `opencode` binary (its installer drops it under ~/.opencode/bin).
fn opencode_bin() -> String {
    let extra = std::env::var("HOME")
        .map(|h| format!("{h}/.opencode/bin/opencode"))
        .unwrap_or_default();
    resolve_bin("opencode", "AIOS_OPENCODE_BIN", &[extra.as_str()])
}

/// Optional fast-mode Codex home for the chat path. By default the chat pane
/// deliberately uses the user's real `~/.codex` so it has the same model,
/// reasoning, plugins, hooks, MCP servers, memory, browser/computer-use tools,
/// and AGENTS.md behavior as typing `codex` in a terminal.
///
/// Set `fast=true` (or `AIOS_CODEX_FAST_HOME=1`) to opt into the old low-latency
/// profile that mirrors config into `~/.codex-chat` while stripping MCP servers.
/// Fast mode is useful when startup latency matters more than terminal-grade
/// capability, but it should not be the product default.
fn codex_chat_home(fast_requested: bool) -> Option<String> {
    let fast_env = std::env::var("AIOS_CODEX_FAST_HOME")
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false);
    let fast = fast_requested || fast_env;
    if !fast {
        return None;
    }

    let home = std::env::var("HOME").ok()?;
    let real = std::env::var("CODEX_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{home}/.codex"));
    let chat = format!("{home}/.codex-chat");
    std::fs::create_dir_all(&chat).ok()?;
    // Managed config — always rewritten. Keep the real Codex personality/model
    // defaults/plugins/hooks, but strip only `[mcp_servers.*]` tables: those auth
    // probes are the slow part, and the CLI override merges instead of replacing.
    let real_cfg = format!("{real}/config.toml");
    let config = std::fs::read_to_string(&real_cfg)
        .ok()
        .map(|s| codex_config_without_mcp_servers(&s))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "trust_level = \"trusted\"\n".to_string());
    let _ = std::fs::write(
        format!("{chat}/config.toml"),
        format!(
            "# managed by AIOS shell fast mode — mirrors ~/.codex/config.toml with mcp_servers stripped.\n\
             # terminal-grade mode leaves CODEX_HOME unset and uses ~/.codex directly.\n{config}"
        ),
    );
    // Symlink auth.json → real home so the ChatGPT login stays shared.
    let link = format!("{chat}/auth.json");
    let target = format!("{real}/auth.json");
    let needs_link = match std::fs::read_link(&link) {
        Ok(p) => p.to_string_lossy() != target,
        Err(_) => true,
    };
    if needs_link {
        let _ = std::fs::remove_file(&link);
        link_or_copy_auth(&target, &link)?;
    }
    Some(chat)
}

fn link_or_copy_auth(target: &str, link: &str) -> Option<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).ok()
    }

    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(target, link)
            .or_else(|_| std::fs::copy(target, link).map(|_| ()))
            .ok()
    }

    #[cfg(not(any(unix, windows)))]
    {
        std::fs::copy(target, link).map(|_| ()).ok()
    }
}

fn codex_config_without_mcp_servers(src: &str) -> String {
    let mut out = String::new();
    let mut skip = false;
    let mut in_root = true;
    let mut saw_root_trust = false;

    for line in src.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_root = false;
            skip = trimmed == "[mcp_servers]" || trimmed.starts_with("[mcp_servers.");
        }
        if skip {
            continue;
        }
        if in_root && trimmed.starts_with("trust_level") {
            saw_root_trust = true;
        }
        out.push_str(line);
        out.push('\n');
    }

    if !saw_root_trust {
        out.push_str("\ntrust_level = \"trusted\"\n");
    }
    out
}

/// JSON-escapes a string for embedding in the stream-json user line. We build
/// the line by hand (rather than pulling a serializer into the hot path) since
/// the shape is fixed and tiny; only the text field is untrusted.
/// Writes one already-formed line to a live session's stdin, flushing it. Shared
/// by every "push a line to claude" path (turns, interrupts, control replies).
/// `line` should already end in `\n`. No-op error text if the session is gone.
fn write_line(session_id: u32, line: &str) -> Result<(), String> {
    let session = with_sessions(|m| m.get(&session_id).cloned());
    let session = match session {
        Some(s) => s,
        None => return Err(format!("chat session {session_id} not found")),
    };
    let mut guard = session.stdin.lock();
    let stdin = guard
        .as_mut()
        .ok_or_else(|| "chat session has no stdin (spawn-per-turn engine)".to_string())?;
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
    engine: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    effort: Option<String>,
    fast: Option<bool>,
    resume: Option<String>,
    headroom: Option<bool>,
) -> Result<u32, String> {
    let eng = Engine::parse(engine.as_deref());
    // codex (ChatGPT sub) → persistent codex app-server process (JSON-RPC).
    if matches!(eng, Engine::Codex) {
        return start_codex_appserver(
            app,
            on_event,
            cwd,
            model,
            permission_mode,
            effort,
            resume,
            fast.unwrap_or(false),
        );
    }
    // opencode (openrouter/everything) is spawn-per-turn — register the session
    // here, spawn nothing; chat_send runs each turn.
    if eng.per_turn() {
        return start_per_turn(eng, on_event, cwd, model, resume);
    }

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

    // Headroom compression: route this claude turn through the local proxy so
    // tool outputs / RAG get compressed before hitting the LLM. Gated on the
    // cockpit toggle (claude engine only). Subscription auth is preserved — the
    // proxy only rewrites the body, not the auth headers. Reversible: turn the
    // toggle off and turns spawn against api.anthropic.com directly again.
    if headroom.unwrap_or(false) {
        // Headroom proxy listens on 8899 — deliberately OUTSIDE the control
        // plane's port-scan window ([8787, 8787+16]) so the two can never race
        // for the same socket. If they shared 8787, whichever bound first won
        // and a headroom-on claude turn could silently POST to the control
        // listener instead of Anthropic. Keep the proxy plist's --port in sync.
        let url = std::env::var("HEADROOM_PROXY_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "http://127.0.0.1:8899".to_string());
        cmd.env("ANTHROPIC_BASE_URL", url);
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Merge nothing from stderr into the event stream — surface it on its
        // own so a missing-binary / auth error doesn't masquerade as JSON.
        .stderr(Stdio::piped());
    // Own process group on unix: a force-quit of the cockpit sends signals to
    // the app's group, NOT this child — so an in-flight turn finishes. Windows
    // needs a job-object based follow-up for equivalent behavior.
    detach_child_process(&mut cmd);

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

    // Build the session up-front so the reader thread can forward through its
    // swappable sink + buffer (rather than a fixed channel that dies on close).
    let session = Arc::new(ChatSession {
        id,
        engine: Engine::Claude,
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(Some(stdin)),
        thread_id: Mutex::new(None),
        cwd: Mutex::new(None),
        model: Mutex::new(None),
        effort: Mutex::new(None), // claude passes effort as a CLI flag, not per turn
        sink: Mutex::new(Some(Box::new(ChannelSink(on_event)))),
        buffer: Mutex::new(VecDeque::with_capacity(256)),
        buffer_bytes: AtomicUsize::new(0),
        claude_id: Mutex::new(None),
        title: Mutex::new(String::new()),
        busy: AtomicBool::new(false),
        detached: AtomicBool::new(false),
        notify_on_done: AtomicBool::new(false),
        rpc_id: AtomicU64::new(1),
        pending_turn: Mutex::new(None),
        active_turn: Mutex::new(None),
        answer_item: Mutex::new(None),
        answer_streamed: AtomicBool::new(false),
        pending_approvals: Mutex::new(HashMap::new()),
    });

    // stdout reader: blocking reads → UTF-8-safe → whole lines. Each line is
    // appended to the replay buffer AND forwarded to the current sink (if any).
    // A dropped sink no longer kills the thread — the process keeps running and
    // buffering while detached, so a reopened pane can replay + watch it finish.
    let sess = Arc::clone(&session);
    let app_rdr = app.clone();
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
                    while let Some(nl) = line_buf.find('\n') {
                        let line: String = line_buf.drain(..=nl).collect();
                        let trimmed = line.trim_end_matches(['\n', '\r']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        ingest_line(&sess, &app_rdr, trimmed);
                    }
                }
                // A transient EINTR is NOT end-of-stream: a signal interrupted the
                // blocking read mid-call. Retry instead of tearing down a live
                // session (which would synthesize a bogus error result). Only real
                // I/O errors / EOF (`Ok(0)`) end the loop.
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let tail = line_buf.trim_end_matches(['\n', '\r']);
        if !tail.is_empty() {
            ingest_line(&sess, &app_rdr, tail);
        }
        // Process died mid-turn (crash / EOF / kill) without emitting its own
        // `result` to close the turn. Synthesize an error result so the composer
        // frees and the streaming cursor clears — exactly like the codex/opencode
        // readers do (otherwise streaming=true forever, cursor never clears).
        // `busy` is still true ONLY if no real `result` line already cleared it.
        if sess.busy.swap(false, Ordering::SeqCst) {
            let cid = sess.claude_id.lock().clone().unwrap_or_default();
            let result = format!(
                "{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"text\":\"claude exited\",\"session_id\":\"{}\",\"total_cost_usd\":0}}",
                json_escape(&cid)
            );
            ingest_line(&sess, &app_rdr, &result);
        }
        let _ = app_rdr.emit("chat-exit", id);
    });

    // stderr reader: surface as synthetic error events through the same sink.
    if let Some(mut err) = stderr {
        let sess = Arc::clone(&session);
        let app_err = app.clone();
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
                            ingest_line(&sess, &app_err, &ev);
                        }
                    }
                    // EINTR on the stderr pipe is transient too — keep draining.
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
    }

    with_sessions(|m| m.insert(id, session));
    Ok(id)
}

/// Registers a spawn-per-turn (codex/opencode) session WITHOUT spawning a process.
/// Emits a bare synthetic `system/init` so the pane flips `claudeReady` and the
/// composer is usable immediately; the real resume id (codex thread / opencode
/// ses_) is captured + re-emitted on the first turn. `resume` seeds the thread so
/// a reopened chat keeps its history.
fn start_per_turn(
    engine: Engine,
    on_event: Channel<String>,
    cwd: Option<String>,
    model: Option<String>,
    resume: Option<String>,
) -> Result<u32, String> {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let session = Arc::new(ChatSession {
        id,
        engine,
        child: Mutex::new(None),
        stdin: Mutex::new(None),
        thread_id: Mutex::new(resume.filter(|s| !s.is_empty())),
        cwd: Mutex::new(cwd.filter(|s| !s.is_empty())),
        model: Mutex::new(model.filter(|s| !s.is_empty())),
        effort: Mutex::new(None), // opencode effort handled per-turn at send
        sink: Mutex::new(Some(Box::new(ChannelSink(on_event)))),
        buffer: Mutex::new(VecDeque::with_capacity(256)),
        buffer_bytes: AtomicUsize::new(0),
        claude_id: Mutex::new(None),
        title: Mutex::new(String::new()),
        busy: AtomicBool::new(false),
        detached: AtomicBool::new(false),
        notify_on_done: AtomicBool::new(false),
        rpc_id: AtomicU64::new(1),
        pending_turn: Mutex::new(None),
        active_turn: Mutex::new(None),
        answer_item: Mutex::new(None),
        answer_streamed: AtomicBool::new(false),
        pending_approvals: Mutex::new(HashMap::new()),
    });
    // Bare init (no session_id) just flips claudeReady — the real id arrives on
    // turn 1. ingest into the buffer too so a reattach replays it.
    ingest_line_arc(&session, "{\"type\":\"system\",\"subtype\":\"init\"}");
    with_sessions(|m| m.insert(id, session));
    Ok(id)
}

/// Buffers + forwards a line on a session that has no AppHandle context (startup).
fn ingest_line_arc(sess: &Arc<ChatSession>, line: &str) {
    buffer_push(sess, line);
    if let Some(ch) = sess.sink.lock().as_ref() {
        ch.send(line);
    }
}

/// Runs ONE turn for a spawn-per-turn engine: builds + spawns the per-turn
/// command, stores its child (so an interrupt can kill it), and wires a reader
/// thread that adapts the engine's JSONL into claude-shaped lines, ingests them,
/// and on EOF emits a fallback `result` if the engine didn't already close the
/// turn. Heavy stderr (codex skill/MCP warnings) is drained + dropped, not shown.
fn run_per_turn(sess: Arc<ChatSession>, app: AppHandle, text: String) -> Result<(), String> {
    let engine = sess.engine;
    let model = sess.model.lock().clone();
    let thread = sess.thread_id.lock().clone();
    let cwd = sess.cwd.lock().clone();

    let mut cmd = match engine {
        Engine::Codex => Command::new(codex_bin()),
        Engine::Opencode => Command::new(opencode_bin()),
        Engine::Claude => return Err("claude is not a per-turn engine".into()),
    };
    match engine {
        Engine::Codex => {
            cmd.arg("exec");
            match thread.as_deref().filter(|s| !s.is_empty()) {
                // resume rejects -s; the thread inherits turn-1's read-only policy.
                Some(t) => {
                    cmd.arg("resume").arg(t);
                }
                None => {
                    cmd.arg("-s").arg("read-only");
                }
            }
            cmd.arg("--json").arg("--skip-git-repo-check");
            // Chat is conversational — kill MCP entirely so each turn doesn't
            // re-attempt (and time out on) figma/vercel auth (~40s/turn). The
            // `-c mcp_servers={}` override is MERGED not replaced by codex 0.135,
            // so it doesn't actually stop them — the real fix is a dedicated
            // stripped CODEX_HOME with no servers defined (turns drop to ~2s).
            // Keep the override too as belt-and-suspenders for other codex builds.
            if let Some(ch) = codex_chat_home(false) {
                cmd.env("CODEX_HOME", ch);
            }
            cmd.arg("-c").arg("mcp_servers={}");
            if let Some(m) = model.as_deref().filter(|s| !s.is_empty()) {
                cmd.arg("-m").arg(m);
            }
            cmd.arg(&text);
        }
        Engine::Opencode => {
            cmd.arg("run").arg("--format").arg("json");
            if let Some(s) = thread.as_deref().filter(|s| !s.is_empty()) {
                cmd.arg("-s").arg(s);
            }
            if let Some(m) = model.as_deref().filter(|s| !s.is_empty()) {
                cmd.arg("-m").arg(m);
            }
            cmd.arg(&text);
        }
        Engine::Claude => unreachable!(),
    }
    match cwd.as_deref().filter(|s| !s.is_empty()) {
        Some(dir) => {
            cmd.current_dir(dir);
        }
        None => {
            if let Ok(home) = std::env::var("HOME") {
                cmd.current_dir(home);
            }
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    detach_child_process(&mut cmd); // survive a cockpit force-quit on unix

    let engine_name = match engine {
        Engine::Codex => "codex",
        _ => "opencode",
    };
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {engine_name}: {e}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("failed to capture {engine_name} stdout"))?;
    let stderr = child.stderr.take();
    *sess.child.lock() = Some(child);

    // Drain stderr so the pipe never blocks the child; it's pure noise here.
    if let Some(mut err) = stderr {
        thread::spawn(move || {
            let mut b = [0u8; 8192];
            while let Ok(n) = err.read(&mut b) {
                if n == 0 {
                    break;
                }
            }
        });
    }

    let rsess = Arc::clone(&sess);
    thread::spawn(move || {
        let mut pending_bytes: Vec<u8> = Vec::new();
        let mut line_buf = String::new();
        let mut buf = [0u8; 16384];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending_bytes.extend_from_slice(&buf[..n]);
                    let (t, rem) = split_valid_utf8(&pending_bytes);
                    pending_bytes = rem;
                    line_buf.push_str(&t);
                    while let Some(nl) = line_buf.find('\n') {
                        let line: String = line_buf.drain(..=nl).collect();
                        let trimmed = line.trim_end_matches(['\n', '\r']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        for out in adapt_line(&rsess, engine, trimmed) {
                            ingest_line(&rsess, &app, &out);
                        }
                    }
                }
                // Transient EINTR — retry rather than prematurely ending the turn.
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let tail = line_buf.trim_end_matches(['\n', '\r']);
        if !tail.is_empty() {
            for out in adapt_line(&rsess, engine, tail) {
                ingest_line(&rsess, &app, &out);
            }
        }
        // Reap the finished turn's child before nulling it — dropping the Child
        // alone never wait()s it, leaking a zombie until the next turn replaces it.
        if let Some(child) = rsess.child.lock().as_mut() {
            let _ = child.wait();
        }
        *rsess.child.lock() = None;
        // Fallback close: if the engine never emitted a turn-end (crash / kill /
        // an engine that just EOFs), synthesize a result so the composer frees.
        // `busy` is still true ONLY if no adapted `result` line cleared it.
        if rsess.busy.swap(false, Ordering::SeqCst) {
            let tid = rsess.thread_id.lock().clone().unwrap_or_default();
            let result = format!(
                "{{\"type\":\"result\",\"subtype\":\"success\",\"session_id\":\"{}\",\"total_cost_usd\":0}}",
                json_escape(&tid)
            );
            ingest_line(&rsess, &app, &result);
        }
    });
    Ok(())
}

// ───────────────────────── codex app-server (persistent) ─────────────────────
//
// Codex runs as one long-lived `<codex> app-server` process speaking
// newline-delimited JSON-RPC 2.0 (protocol verified live 2026-05-31). One process
// serves the whole conversation: handshake once (initialize → initialized →
// thread/start|resume), then `turn/start` per turn — no more per-turn `codex exec`
// cold-start. The server SELF-MANAGES chatgpt OAuth refresh, so there is NO
// client-side token answerer (it never sends `account/chatgptAuthTokens/refresh`);
// we reply `{}` to any stray server request purely so nothing can stall.
// Notifications are adapted into claude's wire shape so the frontend is untouched.
//
// SCOPE: survives PANE close (the existing detach/buffer machinery) but NOT app
// quit — the process is a child of the cockpit. True survive-app-quit needs the
// `codex app-server daemon` + `proxy` (detached process-group); deferred, the
// transport swap is localized to `codex_appserver_bin` + spawn. See
// PLAN-chatpane-daily-driver.md.

/// Resolves the codex binary that exposes a direct stdio `app-server`. The npm
/// `codex` CANNOT (0.135: raw `app-server` needs a subcommand; the daemon needs a
/// standalone install). The STANDALONE binary run as `<bin> app-server` IS a
/// newline-JSON-RPC stdio server. Prefer the standalone managed under the chat
/// CODEX_HOME, then the Codex.app desktop bundle, then the override / native.
fn codex_appserver_bin() -> String {
    if let Ok(p) = std::env::var("AIOS_CODEX_APPSERVER_BIN") {
        if !p.is_empty() {
            return p;
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let standalone = format!("{home}/.codex-chat/packages/standalone/current/codex");
        if std::path::Path::new(&standalone).exists() {
            return standalone;
        }
    }
    let desktop = "/Applications/Codex.app/Contents/Resources/codex";
    if std::path::Path::new(desktop).exists() {
        return desktop.to_string();
    }
    codex_bin()
}

/// Writes one JSON-RPC value (newline-terminated) to a codex app-server session's
/// stdin — handshake, turns, interrupts, and server-request replies all go here.
fn codex_rpc_write(sess: &Arc<ChatSession>, val: &serde_json::Value) {
    let mut line = val.to_string();
    line.push('\n');
    if let Some(stdin) = sess.stdin.lock().as_mut() {
        let _ = stdin.write_all(line.as_bytes());
        let _ = stdin.flush();
    }
}

/// Next JSON-RPC request id for this session.
fn codex_next_rpc(sess: &Arc<ChatSession>) -> u64 {
    sess.rpc_id.fetch_add(1, Ordering::SeqCst)
}

fn codex_error_result_line(sess: &Arc<ChatSession>, text: &str) -> String {
    let tid = sess.thread_id.lock().clone().unwrap_or_default();
    format!(
        "{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"text\":\"{}\",\"session_id\":\"{}\",\"total_cost_usd\":0}}",
        json_escape(text),
        json_escape(&tid)
    )
}

/// Sends `turn/start` for an (already-known) thread, with the session model +
/// reasoning effort. Effort is sent every turn (codex has no spawn-time flag like
/// claude's `--effort`); `TurnStartParams.effort` overrides it for this turn on.
fn codex_fire_turn(sess: &Arc<ChatSession>, thread_id: &str, text: &str, image_paths: &[String]) {
    let id = codex_next_rpc(sess);
    let mut params = json!({
        "threadId": thread_id,
        "input": codex_input_items(text, image_paths),
    });
    if let Some(m) = sess.model.lock().clone().filter(|s| !s.is_empty()) {
        params["model"] = json!(m);
    }
    if let Some(ef) = sess.effort.lock().as_deref().and_then(codex_effort) {
        params["effort"] = json!(ef);
    }
    codex_rpc_write(
        sess,
        &json!({ "jsonrpc": "2.0", "id": id, "method": "turn/start", "params": params }),
    );
}

/// Public turn entry for codex: fire `turn/start` if the thread is ready, else
/// queue the text until `thread/start` resolves (the first turn races handshake).
fn codex_send_turn(
    sess: &Arc<ChatSession>,
    text: String,
    image_paths: &[String],
) -> Result<(), String> {
    let tid = sess.thread_id.lock().clone();
    match tid {
        Some(t) if !t.is_empty() => codex_fire_turn(sess, &t, &text, image_paths),
        _ => *sess.pending_turn.lock() = Some((text, image_paths.to_vec())),
    }
    Ok(())
}

/// Steers the in-flight codex turn: injects `text` into the RUNNING turn without
/// interrupting it (`turn/steer`, verified live against codex 0.135 — needs both
/// `threadId` and `expectedTurnId`, the latter from the `turn/started` we cached
/// in `active_turn`). Returns Err if there's no live turn to steer, so the caller
/// can fall back to a normal/queued send.
fn codex_steer(sess: &Arc<ChatSession>, text: &str) -> Result<(), String> {
    let tid = sess.thread_id.lock().clone().unwrap_or_default();
    let turn = sess.active_turn.lock().clone().unwrap_or_default();
    if tid.is_empty() || turn.is_empty() {
        return Err("no active codex turn to steer".into());
    }
    let id = codex_next_rpc(sess);
    codex_rpc_write(
        sess,
        &json!({
            "jsonrpc": "2.0", "id": id, "method": "turn/steer",
            "params": {
                "threadId": tid,
                "expectedTurnId": turn,
                "input": [{ "type": "text", "text": text }],
            }
        }),
    );
    Ok(())
}

fn codex_finish_stopped_turn(sess: &Arc<ChatSession>) {
    *sess.active_turn.lock() = None;
    *sess.answer_item.lock() = None;
    sess.answer_streamed.store(false, Ordering::SeqCst);
    sess.pending_approvals.lock().clear();
    if sess.busy.swap(false, Ordering::SeqCst) {
        fan_out(sess, &codex_error_result_line(sess, "stopped by user"));
    }
}

/// Interrupts the in-flight codex turn via `turn/interrupt` (keeps process+thread).
fn codex_interrupt(sess: &Arc<ChatSession>) -> Result<(), String> {
    *sess.pending_turn.lock() = None;
    let tid = sess.thread_id.lock().clone().unwrap_or_default();
    let active_turn = sess.active_turn.lock().clone().unwrap_or_default();
    if tid.is_empty() {
        codex_finish_stopped_turn(sess);
        return Ok(());
    }
    let id = codex_next_rpc(sess);
    codex_rpc_write(
        sess,
        &json!({
            "jsonrpc": "2.0", "id": id, "method": "turn/interrupt",
            "params": { "threadId": tid }
        }),
    );
    if active_turn.is_empty() {
        codex_finish_stopped_turn(sess);
    }
    Ok(())
}

/// Starts a persistent codex app-server session: spawns `<bin> app-server`,
/// performs the JSON-RPC handshake (initialize → initialized → thread/start or
/// thread/resume), and wires a reader thread that adapts frames into claude-shaped
/// lines. Mirrors `chat_start`'s claude path but over the JSON-RPC transport.
fn start_codex_appserver(
    app: AppHandle,
    on_event: Channel<String>,
    cwd: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    effort: Option<String>,
    resume: Option<String>,
    fast: bool,
) -> Result<u32, String> {
    let mut cmd = Command::new(codex_appserver_bin());
    cmd.arg("app-server");
    if let Some(ch) = codex_chat_home(fast) {
        cmd.env("CODEX_HOME", ch);
    }
    let dir = cwd.filter(|s| !s.is_empty());
    match dir.as_deref() {
        Some(d) => {
            cmd.current_dir(d);
        }
        None => {
            if let Ok(home) = std::env::var("HOME") {
                cmd.current_dir(home);
            }
        }
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    detach_child_process(&mut cmd); // survive a cockpit force-quit on unix

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn codex app-server: {e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to capture codex app-server stdin".to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture codex app-server stdout".to_string())?;
    let stderr = child.stderr.take();

    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let session = Arc::new(ChatSession {
        id,
        engine: Engine::Codex,
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(Some(stdin)),
        thread_id: Mutex::new(None),
        cwd: Mutex::new(dir),
        model: Mutex::new(model.filter(|s| !s.is_empty())),
        effort: Mutex::new(effort.filter(|s| !s.is_empty())),
        sink: Mutex::new(Some(Box::new(ChannelSink(on_event)))),
        buffer: Mutex::new(VecDeque::with_capacity(256)),
        buffer_bytes: AtomicUsize::new(0),
        claude_id: Mutex::new(None),
        title: Mutex::new(String::new()),
        busy: AtomicBool::new(false),
        detached: AtomicBool::new(false),
        notify_on_done: AtomicBool::new(false),
        rpc_id: AtomicU64::new(1),
        pending_turn: Mutex::new(None),
        active_turn: Mutex::new(None),
        answer_item: Mutex::new(None),
        answer_streamed: AtomicBool::new(false),
        pending_approvals: Mutex::new(HashMap::new()),
    });

    // Bare init (no session_id) flips claudeReady now; the real session_id lands
    // with the threadId once thread/start resolves.
    ingest_line_arc(&session, "{\"type\":\"system\",\"subtype\":\"init\"}");

    // Handshake. `capabilities` is REQUIRED or the server closes the socket.
    codex_rpc_write(
        &session,
        &json!({
            "jsonrpc": "2.0", "id": codex_next_rpc(&session), "method": "initialize",
            "params": {
                "clientInfo": { "name": "aios-shell", "title": null, "version": "0.1.0" },
                "capabilities": { "experimentalApi": false, "requestAttestation": false }
            }
        }),
    );
    codex_rpc_write(
        &session,
        &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
    );
    // thread/start (or resume a prior thread). The composer's permission picker
    // maps to codex's sandbox + approval policy so codex can actually BUILD when
    // you give it write access (not just answer). `never` approval keeps the chat
    // promptless; the sandbox scopes what it may touch:
    //   full access  → danger-full-access, promptless (true bypass — write/run
    //                   anywhere, the codex equivalent of claude bypassPermissions)
    //   accept edits → workspace-write, promptless (scoped to the cwd/repo)
    //   ask each time→ workspace-write + on-request approvals
    //   plan only    → read-only (look, don't touch)
    let (sandbox, approval) = match permission_mode.as_deref() {
        Some("plan") => ("read-only", "never"),
        Some("default") => ("workspace-write", "on-request"),
        Some("acceptEdits") => ("workspace-write", "never"),
        _ => ("danger-full-access", "never"), // full access = full bypass
    };
    let resume_id = resume.filter(|s| !s.is_empty());
    let (method, mut params) = match &resume_id {
        Some(t) => ("thread/resume", json!({ "threadId": t })),
        None => ("thread/start", json!({})),
    };
    params["approvalPolicy"] = json!(approval);
    params["sandbox"] = json!(sandbox);
    if let Some(d) = session.cwd.lock().clone() {
        params["cwd"] = json!(d);
    }
    if let Some(m) = session.model.lock().clone() {
        params["model"] = json!(m);
    }
    codex_rpc_write(
        &session,
        &json!({ "jsonrpc": "2.0", "id": codex_next_rpc(&session), "method": method, "params": params }),
    );

    // stdout reader: newline JSON-RPC frames → adapt → ingest.
    let sess = Arc::clone(&session);
    let app_rdr = app.clone();
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
                    while let Some(nl) = line_buf.find('\n') {
                        let line: String = line_buf.drain(..=nl).collect();
                        let trimmed = line.trim_end_matches(['\n', '\r']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        for out in adapt_codex_appserver_frame(&sess, trimmed) {
                            ingest_line(&sess, &app_rdr, &out);
                        }
                    }
                }
                // Transient EINTR — retry rather than tearing down the session.
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        // Process died: free the composer if mid-turn, then signal exit.
        if sess.busy.swap(false, Ordering::SeqCst) {
            let tid = sess.thread_id.lock().clone().unwrap_or_default();
            let result = format!(
                "{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"session_id\":\"{}\",\"total_cost_usd\":0}}",
                json_escape(&tid)
            );
            ingest_line(&sess, &app_rdr, &result);
        }
        let _ = app_rdr.emit("chat-exit", id);
    });

    // stderr reader: codex app-server logs skill-parse warnings etc. — drain + drop
    // (never surface as events; they'd masquerade as JSON turns).
    if let Some(mut err) = stderr {
        thread::spawn(move || {
            let mut b = [0u8; 8192];
            while let Ok(n) = err.read(&mut b) {
                if n == 0 {
                    break;
                }
            }
        });
    }

    with_sessions(|m| m.insert(id, session));
    Ok(id)
}

/// Adapts one codex app-server JSON-RPC frame → claude-shaped event line(s).
/// Three frame kinds:
///   • server→client REQUEST (`method` AND `id`) — reply `{}` so nothing stalls.
///     With approvalPolicy=never these shouldn't fire; auth is self-managed so
///     `account/chatgptAuthTokens/refresh` never arrives.
///   • RESPONSE to our request (`id`, no `method`) — capture the threadId from a
///     `thread/start`|`thread/resume` result (→ system/init + fire a queued turn).
///   • NOTIFICATION (`method`, no `id`) — map item/turn events to claude lines.
fn adapt_codex_appserver_frame(sess: &Arc<ChatSession>, line: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    let method = v.get("method").and_then(|x| x.as_str());
    let has_id = v.get("id").is_some();
    let mut out = Vec::new();

    // server→client request. In `on-request` approval mode (the composer's "ask
    // each time"), codex asks BEFORE running a command / applying a patch via
    // `exec_command_approval` / `apply_patch_approval`. We must NOT blanket-ack
    // those with `{}` (that silently auto-approves and the user never sees a
    // card). Instead surface the SAME `can_use_tool` ApprovalCard claude uses and
    // hold the JSON-RPC id until the user decides (chat_send_raw replies it).
    // Every other server request (auth refresh etc.) keeps the `{}` ack so the
    // turn can't hang.
    if method.is_some() && has_id {
        let m = method.unwrap();
        let is_approval = matches!(
            m,
            "exec_command_approval"
                | "execCommandApproval"
                | "apply_patch_approval"
                | "applyPatchApproval"
                | "applyPatchApprovalRequest"
                | "execCommandApprovalRequest"
        );
        if is_approval {
            if let Some(idv) = v.get("id") {
                // synthetic request_id the frontend echoes back on its decision.
                let rid = format!("codex-approval-{}", NEXT_REQ.fetch_add(1, Ordering::SeqCst));
                sess.pending_approvals
                    .lock()
                    .insert(rid.clone(), idv.clone());
                let params = v.get("params");
                let tool_name = if m.contains("patch") || m.contains("Patch") {
                    "apply_patch"
                } else {
                    "exec_command"
                };
                // pass through the codex params as the tool input so the card can
                // render the command/patch the model wants to run.
                let input = params.cloned().unwrap_or_else(|| json!({}));
                out.push(
                    json!({
                        "type": "control_request",
                        "request_id": rid,
                        "request": {
                            "subtype": "can_use_tool",
                            "tool_name": tool_name,
                            "input": input,
                        }
                    })
                    .to_string(),
                );
            }
            return out;
        }
        // non-approval server request: ack so nothing stalls.
        if let Some(idv) = v.get("id") {
            codex_rpc_write(sess, &json!({ "jsonrpc": "2.0", "id": idv, "result": {} }));
        }
        return out;
    }

    // response to one of our requests — only thread/start|resume carries thread.id.
    if has_id {
        if let Some(error) = v.get("error") {
            let message = error
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("codex request failed");
            *sess.pending_turn.lock() = None;
            *sess.active_turn.lock() = None;
            *sess.answer_item.lock() = None;
            sess.answer_streamed.store(false, Ordering::SeqCst);
            sess.pending_approvals.lock().clear();
            out.push(codex_error_result_line(sess, message));
            return out;
        }
        if let Some(tid) = v
            .get("result")
            .and_then(|r| r.get("thread"))
            .and_then(|t| t.get("id"))
            .and_then(|x| x.as_str())
        {
            let fresh = {
                let mut g = sess.thread_id.lock();
                let fresh = g.as_deref() != Some(tid);
                *g = Some(tid.to_string());
                fresh
            };
            if fresh {
                out.push(format!(
                    "{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{}\"}}",
                    json_escape(tid)
                ));
            }
            // Fire any turn queued before the thread existed.
            if let Some((text, images)) = sess.pending_turn.lock().take() {
                codex_fire_turn(sess, tid, &text, &images);
            }
        }
        return out;
    }

    // notification.
    let Some(m) = method else { return out };
    let params = v.get("params");
    match m {
        // live token stream: codex emits `item/agentMessage/delta` (and reasoning
        // summary deltas) as the model writes. Map each to a claude stream_event so
        // the bubble types out live — the difference between codex feeling alive vs
        // dumping a wall of text at the end. Routed by name so reasoning vs answer
        // lands in the right block; field is `delta` (fallback `text`).
        _ if m.ends_with("/delta") => {
            let tok = params
                .and_then(|p| p.get("delta"))
                .and_then(|x| x.as_str())
                .or_else(|| params.and_then(|p| p.get("text")).and_then(|x| x.as_str()))
                .unwrap_or("");
            if !tok.is_empty() {
                // Only the final-answer item streams as the REPLY; reasoning and
                // preamble/status agentMessages stream into the thinking block so
                // they don't look identical to the answer.
                let is_answer = codex_delta_is_answer(sess, m, params);
                if is_answer {
                    // Record that THIS answer item streamed live → item/completed
                    // must suppress its duplicate full line (one source of truth).
                    sess.answer_streamed.store(true, Ordering::SeqCst);
                    out.push(text_delta_line(tok));
                } else {
                    out.push(thinking_delta_line(tok));
                }
            }
        }
        "item/started" => {
            // Record the final-answer item id so its deltas route to the reply
            // (everything else mid-turn is preamble → thinking).
            if let Some(item) = params.and_then(|p| p.get("item")) {
                let item_type = item.get("type").and_then(|x| x.as_str());
                let phase = item.get("phase").and_then(|x| x.as_str()).unwrap_or("");
                let is_final_answer = matches!(item_type, Some("agentMessage" | "agent_message"))
                    && !matches!(phase, "preamble" | "status" | "reasoning");
                if is_final_answer {
                    if let Some(id) = item.get("id").and_then(|x| x.as_str()) {
                        let streamed_before_id = sess.answer_item.lock().is_none()
                            && sess.answer_streamed.load(Ordering::SeqCst);
                        *sess.answer_item.lock() = Some(id.to_string());
                        // Fresh answer item → it hasn't streamed yet. If codex
                        // sent answer deltas before the id, keep the streamed
                        // flag so completed/full-text doesn't duplicate it.
                        if !streamed_before_id {
                            sess.answer_streamed.store(false, Ordering::SeqCst);
                        }
                    }
                }
                if codex_is_action_item(item) {
                    let id = codex_item_id(item);
                    out.push(assistant_tool_use_line(
                        &id,
                        &codex_tool_name(item),
                        codex_tool_input(item),
                    ));
                }
            }
        }
        "item/completed" => {
            if let Some(item) = params.and_then(|p| p.get("item")) {
                let itype = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
                match itype {
                    "agentMessage" | "agent_message" => {
                        // final_answer → the reply; any other phase (preamble /
                        // status) → thinking, so it doesn't mirror the answer.
                        let is_final = item
                            .get("phase")
                            .and_then(|x| x.as_str())
                            .map_or(true, |p| p == "final_answer");
                        // Did THIS completed item stream its answer live? If the
                        // completed item id matches the tracked answer item AND
                        // that item already streamed deltas, the bubble is
                        // already rendered — suppress the duplicate full line.
                        // The stream is the single source of truth. (If it never
                        // streamed — e.g. a short answer — fall through and emit
                        // the full line so the answer isn't dropped.)
                        let completed_id = item.get("id").and_then(|x| x.as_str());
                        let answer_item = sess.answer_item.lock().clone();
                        let already_streamed = is_final
                            && sess.answer_streamed.load(Ordering::SeqCst)
                            && match (completed_id, answer_item.as_deref()) {
                                (Some(done), Some(tracked)) => done == tracked,
                                (None, _) | (_, None) => true,
                            };
                        if !already_streamed {
                            if let Some(t) = item.get("text").and_then(|x| x.as_str()) {
                                if !t.is_empty() {
                                    if is_final {
                                        out.push(assistant_text_line(t));
                                    } else {
                                        out.push(assistant_thinking_line(t));
                                    }
                                }
                            }
                        }
                    }
                    "reasoning" => {
                        // reasoning item carries `content: Array<string>`.
                        let joined = item
                            .get("content")
                            .and_then(|c| c.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_str())
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default();
                        if !joined.is_empty() {
                            out.push(assistant_thinking_line(&joined));
                        }
                    }
                    _ if codex_is_action_item(item) => {
                        let id = codex_item_id(item);
                        out.push(user_tool_result_line(
                            &id,
                            &codex_tool_result_text(item),
                            codex_item_is_error(item),
                        ));
                    }
                    _ => {}
                }
            }
        }
        "turn/started" => {
            // new turn → reset the answer-item marker + streamed flag; capture
            // the turn id so a steer can target it via expectedTurnId.
            *sess.answer_item.lock() = None;
            sess.answer_streamed.store(false, Ordering::SeqCst);
            if let Some(id) = params
                .and_then(|p| p.get("turn"))
                .and_then(|t| t.get("id"))
                .and_then(|x| x.as_str())
            {
                *sess.active_turn.lock() = Some(id.to_string());
            }
        }
        "turn/completed" => {
            *sess.active_turn.lock() = None;
            *sess.answer_item.lock() = None;
            let tid = sess.thread_id.lock().clone().unwrap_or_default();
            // Map codex's usage envelope onto claude's field names so the ctx
            // pill + token footer populate identically to claude (see
            // codex_usage_to_claude).
            let usage = codex_usage_to_claude(params.and_then(|p| {
                p.get("turn")
                    .and_then(|t| t.get("usage"))
                    .or_else(|| p.get("usage"))
            }));
            out.push(format!(
                "{{\"type\":\"result\",\"subtype\":\"success\",\"session_id\":\"{}\",\"usage\":{usage},\"total_cost_usd\":0}}",
                json_escape(&tid)
            ));
        }
        "turn/failed" => {
            *sess.active_turn.lock() = None;
            *sess.answer_item.lock() = None;
            let tid = sess.thread_id.lock().clone().unwrap_or_default();
            out.push(format!(
                "{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"session_id\":\"{}\",\"total_cost_usd\":0}}",
                json_escape(&tid)
            ));
        }
        "account/rateLimits/updated" => {
            // Codex pushes this whenever the ChatGPT-sub windows move — the live
            // signal for the composer's usage bar. The rate-limits object may sit
            // under `rateLimits`/`rate_limits` or directly in params; try each.
            if let Some(rl) = params
                .and_then(|p| p.get("rateLimits").or_else(|| p.get("rate_limits")))
                .or(params)
            {
                if rl.get("primary").is_some() || rl.get("secondary").is_some() {
                    out.push(codex_usage_event(rl));
                }
            }
        }
        "error" => {
            // Transient errors retry (willRetry:true) — do NOT end the turn, or the
            // composer would free mid-stream. Only a non-retryable error is fatal.
            let will_retry = params
                .and_then(|p| p.get("willRetry"))
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            if !will_retry {
                let tid = sess.thread_id.lock().clone().unwrap_or_default();
                out.push(format!(
                    "{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"session_id\":\"{}\",\"total_cost_usd\":0}}",
                    json_escape(&tid)
                ));
            }
        }
        _ => {} // thread/started, item/started, deltas, mcp status — ignored in v1
    }
    out
}

/// Routes a raw engine line to the right adapter; claude lines pass through.
fn adapt_line(sess: &Arc<ChatSession>, engine: Engine, line: &str) -> Vec<String> {
    match engine {
        Engine::Codex => adapt_codex_line(sess, line),
        Engine::Opencode => adapt_opencode_line(sess, line),
        Engine::Claude => vec![line.to_string()],
    }
}

/// Handles one complete output line: append to the replay buffer, update session
/// state (claude id, busy, done-notification), and forward to the live sink.
fn ingest_line(sess: &Arc<ChatSession>, app: &AppHandle, line: &str) {
    // Parse the line ONCE — but only when a cheap substring pre-check says it
    // could matter (a `result` close, or a `session_id` we haven't learned yet).
    // This keeps the hot delta path (token streams) allocation-free: those lines
    // contain neither needle so we never touch serde_json. Parsing at the TOP
    // level (rather than raw `line.contains`) means model output that merely
    // ECHOES `"type":"result"` / `"session_id"` inside its own text can't falsely
    // close a turn or hijack the session id.
    let want_session_id = sess.claude_id.lock().is_none() && line.contains("session_id");
    let want_result = line.contains("result");
    // claude echoes the user turn back on stdout; an image-bearing echo embeds
    // base64 (`"type":"image"`). Detect it cheaply so we can slim the BUFFERED
    // copy (FIX 1) instead of pinning the megabytes for the whole session. Hot
    // delta/text lines never contain this needle, so the parse stays gated.
    let want_user_image =
        line.contains("\"type\":\"image\"") || line.contains("\"type\": \"image\"");
    let parsed: Option<Value> = if want_session_id || want_result || want_user_image {
        serde_json::from_str::<Value>(line).ok()
    } else {
        None
    };

    // Learn claude's session uuid once, from the init event (top-level field only).
    if want_session_id {
        if let Some(sid) = parsed
            .as_ref()
            .and_then(|v| v.get("session_id"))
            .and_then(|x| x.as_str())
        {
            *sess.claude_id.lock() = Some(sid.to_string());
        }
    }

    // A `result` event ends the current turn — match the TOP-LEVEL `type` only.
    let is_result = parsed
        .as_ref()
        .map(|v| v.get("type").and_then(|x| x.as_str()) == Some("result"))
        .unwrap_or(false);

    // Clear `busy` BEFORE forwarding a `result`: the frontend reacts to the
    // result line by immediately firing any queued follow-up via `chat_send`,
    // and chat_send's compare_exchange would bounce it if the flag were still
    // set. Clearing first makes "see result → send next" race-free.
    if is_result {
        sess.busy.store(false, Ordering::SeqCst);
    }

    // Forward the line itself first (buffer + live sink), so the pane sees the
    // turn close before the usage tick that follows it. For an image-bearing
    // user echo, send the REAL line live but buffer only a slimmed placeholder
    // (FIX 1) so base64 image bytes aren't retained / re-replayed for the session.
    let slimmed = if want_user_image {
        parsed.as_ref().and_then(slim_user_image_line)
    } else {
        None
    };
    match slimmed {
        Some(buffered) => fan_out_split(sess, line, &buffered),
        None => fan_out(sess, line),
    }

    if is_result {
        if sess.detached.load(Ordering::SeqCst) && sess.notify_on_done.swap(false, Ordering::SeqCst)
        {
            let title = sess.title.lock().clone();
            let label = if title.is_empty() {
                "chat".to_string()
            } else {
                title
            };
            notify_done(app, sess.id, &label);
        }
        // Live usage tick: right after each claude turn, read the same unified
        // Claude usage source as the sidebar (OAuth first, statusline fallback)
        // and push a synthetic `usage` event so the composer moves as you talk.
        // Codex pushes its own `account/rateLimits/updated`.
        //
        // The usage read does BLOCKING I/O (OAuth file read, possibly shelling out
        // to a node `ccusage` CLI). Running it inline here would stall THIS session's
        // stdout reader thread at every turn-end — stdout backs up while usage is
        // fetched. So offload to a short-lived detached thread: the reader continues
        // immediately, and the synthetic `usage` event fans out a few ms later
        // (timing slack is fine). Clone the AppHandle + session Arc in so the
        // closure is `Send + 'static`.
        if matches!(sess.engine, Engine::Claude) {
            let app_usage = app.clone();
            let sess_usage = Arc::clone(sess);
            thread::spawn(move || {
                if let Some(u) = claude_usage_event(&app_usage) {
                    fan_out(&sess_usage, &u);
                }
            });
        }
    }
}

/// Builds a claude-shaped `usage` event line (5h/7d windows), or `None` if no
/// usage source is available.
fn claude_usage_event(app: &AppHandle) -> Option<String> {
    let v = crate::usage::claude_usage_value(Some(app));
    if v.is_null() {
        return None;
    }
    let win = |k: &str| -> serde_json::Value {
        let w = &v[k];
        json!({
            "pct": w.get("pct").and_then(|x| x.as_f64()),
            "resets_at": w.get("resetsAt").and_then(|x| x.as_i64()),
        })
    };
    Some(
        json!({
            "type": "usage",
            "provider": "claude",
            "five_hour": win("fiveHour"),
            "seven_day": win("sevenDay"),
        })
        .to_string(),
    )
}

/// Payload for the in-app `aios-notify` event. The front-end turns this into a
/// clickable `AiosNotification` whose target reattaches the chat by session id.
#[derive(serde::Serialize, Clone)]
struct AiosNotifyPayload {
    kind: String,
    session_id: u32,
    title: String,
}

/// Fires a native OS notification AND an in-app `aios-notify` event that a
/// backgrounded chat finished. The in-app event is what makes the bell + toast
/// fire and carries the session id so the click can reattach the exact chat.
fn notify_done(app: &AppHandle, session_id: u32, title: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("✓ chat finished")
        .body(format!("{title} — done. click to reopen."))
        .show();
    let _ = app.emit(
        "aios-notify",
        AiosNotifyPayload {
            kind: "chat.done".to_string(),
            session_id,
            title: title.to_string(),
        },
    );
}

/// Sends one user turn. For claude: writes a stream-json user line to the live
/// process's stdin. For codex/opencode (spawn-per-turn): spawns a fresh subprocess
/// resuming the prior thread, whose output is adapted into claude-shaped events.
/// The reply streams back over the session's Channel. No-op if the session's gone.
#[tauri::command]
pub fn chat_send(
    app: AppHandle,
    session_id: u32,
    text: String,
    image_paths: Option<Vec<String>>,
) -> Result<(), String> {
    let Some(s) = with_sessions(|m| m.get(&session_id).cloned()) else {
        return Err(format!("chat session {session_id} not found"));
    };
    // FIX (busy race): claim the turn atomically. A plain `store(true)` let two
    // racing sends both proceed (double-fired turns, crossed results); the CAS
    // makes the second caller bounce with a clean error instead. Mid-turn
    // follow-ups should go through `chat_steer` (claude stdin inject / codex
    // turn/steer) or the frontend queue — never a second chat_send.
    if s.busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("session busy — a turn is already in flight (steer or queue instead)".into());
    }
    let images = image_paths.unwrap_or_default();
    if matches!(s.engine, Engine::Codex) {
        return codex_send_turn(&s, text, &images);
    }
    if s.engine.per_turn() {
        // spawn-per-turn engines have no multimodal channel; fall back to quoting
        // the paths inline so the model can at least Read them.
        let merged = if images.is_empty() {
            text
        } else {
            let paths = images
                .iter()
                .map(|p| format!("\"{p}\""))
                .collect::<Vec<_>>()
                .join(" ");
            if text.is_empty() {
                paths
            } else {
                format!("{paths} {text}")
            }
        };
        // FIX 3: `busy` was set true above. If the per-turn spawn fails BEFORE the
        // reader thread starts, no EOF-fallback `result` ever fires (there's no
        // thread), so the session would be wedged busy=true forever and the
        // composer never re-enables. On the spawn-error path, clear busy and emit
        // a synthetic error `result` (the same surfacing pattern the reader's EOF
        // fallback uses) so the composer frees and the failure is visible.
        if let Err(e) = run_per_turn(Arc::clone(&s), app.clone(), merged) {
            s.busy.store(false, Ordering::SeqCst);
            let tid = s.thread_id.lock().clone().unwrap_or_default();
            let result = format!(
                "{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"text\":\"{}\",\"session_id\":\"{}\",\"total_cost_usd\":0}}",
                json_escape(&e),
                json_escape(&tid)
            );
            ingest_line(&s, &app, &result);
            return Err(e);
        }
        return Ok(());
    }
    let line = if images.is_empty() {
        user_line(&text)
    } else {
        user_line_with_images(&text, &images)
    };
    let res = write_line(session_id, &line);
    if res.is_err() {
        // The turn never reached claude — release the claim or the session
        // wedges busy=true forever (no `result` will ever clear it).
        s.busy.store(false, Ordering::SeqCst);
    }
    res
}

/// Detaches a session from its pane WITHOUT killing it: clears the sink so
/// output only buffers, marks it backgrounded, and arms a done-notification if
/// requested. The `claude` child keeps running — reattach later to watch it
/// finish. Called when the user closes a still-working chat.
#[tauri::command]
pub fn chat_detach(session_id: u32, notify: bool) -> Result<(), String> {
    let s = with_sessions(|m| m.get(&session_id).cloned())
        .ok_or_else(|| format!("chat session {session_id} not found"))?;
    s.detached.store(true, Ordering::SeqCst);
    s.notify_on_done.store(notify, Ordering::SeqCst);
    *s.sink.lock() = None;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ChatReattachInfo {
    pub busy: bool,
    /// Which engine drives this session (`claude` | `codex` | `opencode`), so a
    /// reattached pane re-syncs its `model` state to the RIGHT engine instead of
    /// staying on the default claude (which would give the wrong stop-strategy,
    /// hide steer, and read the wrong usage provider). The linchpin parity fix.
    pub engine: String,
    /// Model id the session was started with, if known (so the pane can restore
    /// the exact composer entry, not just the engine).
    pub model: Option<String>,
    /// The engine's own session uuid (claude session_id / codex threadId).
    pub claude_id: Option<String>,
}

/// Reattaches a reopened pane to a live (possibly backgrounded) session: rebinds
/// the channel, replays the buffered lines so the pane reconstructs the whole
/// run and catches up to live, and clears the detached/notify flags.
#[tauri::command]
pub fn chat_reattach(
    session_id: u32,
    on_event: Channel<String>,
) -> Result<ChatReattachInfo, String> {
    let s = with_sessions(|m| m.get(&session_id).cloned())
        .ok_or_else(|| format!("chat session {session_id} not found"))?;
    // Replay buffer first, then go live — order matters so the pane sees history
    // before new deltas.
    for line in s.buffer.lock().iter() {
        let _ = on_event.send(line.clone());
    }
    *s.sink.lock() = Some(Box::new(ChannelSink(on_event)));
    s.detached.store(false, Ordering::SeqCst);
    s.notify_on_done.store(false, Ordering::SeqCst);
    let busy = s.busy.load(Ordering::SeqCst);
    let engine = match s.engine {
        Engine::Claude => "claude",
        Engine::Codex => "codex",
        Engine::Opencode => "opencode",
    }
    .to_string();
    let model = s.model.lock().clone().filter(|m| !m.is_empty());
    let claude_id = s.claude_id.lock().clone();
    Ok(ChatReattachInfo {
        busy,
        engine,
        model,
        claude_id,
    })
}

/// Sets the human label used by the tray + done-notification.
#[tauri::command]
pub fn chat_set_title(session_id: u32, title: String) -> Result<(), String> {
    if let Some(s) = with_sessions(|m| m.get(&session_id).cloned()) {
        *s.title.lock() = title;
    }
    Ok(())
}

/// A live (backgrounded) chat session, for the "running" tray.
#[derive(serde::Serialize)]
pub struct LiveChat {
    pub id: u32,
    pub claude_id: Option<String>,
    pub title: String,
    pub busy: bool,
    pub detached: bool,
}

/// Lists chat sessions that need user control: detached background runs and any
/// still-busy attached run. This powers the status pane's task center so a user
/// can stop a run without first sending another message in that chatpane.
#[tauri::command]
pub fn list_chat_live() -> Vec<LiveChat> {
    with_sessions(|m| {
        m.iter()
            .filter(|(_, s)| s.detached.load(Ordering::SeqCst) || s.busy.load(Ordering::SeqCst))
            .map(|(id, s)| LiveChat {
                id: *id,
                claude_id: s.claude_id.lock().clone(),
                title: s.title.lock().clone(),
                busy: s.busy.load(Ordering::SeqCst),
                detached: s.detached.load(Ordering::SeqCst),
            })
            .collect()
    })
}

/// True while any chat backend has an in-flight turn. Used by the app lifecycle
/// guard so app-level quit (cmd+q/menu quit) cannot silently kill generation.
pub fn has_busy_sessions() -> bool {
    with_sessions(|m| m.values().any(|s| s.busy.load(Ordering::SeqCst)))
}

/// App-exit reaper: kills + reaps EVERY live chat session's child. Called from
/// the lib.rs exit handler ONLY on the path where exit actually proceeds (no busy
/// session blocked it). Without this, `detach_child_process` reparents the spawned
/// `claude`/`codex`/`opencode` children out of the cockpit's process group, so on
/// a normal quit they'd keep running forever — burning tokens + memory. We kill
/// then wait() so nothing is left as a zombie either. Idempotent: an already-dead
/// child's kill/wait errors are ignored.
pub fn kill_all_sessions() {
    with_sessions(|m| {
        for s in m.values() {
            if let Some(c) = s.child.lock().as_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        m.clear();
    });
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
    if let Some(s) = with_sessions(|m| m.get(&session_id).cloned()) {
        // codex app-server: a real `turn/interrupt` (stop the turn, keep the
        // process + thread alive) — not a kill. The server ends the turn; our
        // adapter emits a `result` that frees the composer.
        if matches!(s.engine, Engine::Codex) {
            return codex_interrupt(&s);
        }
        // opencode has no control protocol — kill the in-flight turn's child.
        // Its stdout EOFs, the reader's EOF fallback emits a `result` that frees
        // the composer. The session stays registered for the next turn.
        if s.engine.per_turn() {
            if let Some(child) = s.child.lock().as_mut() {
                let _ = child.kill();
                // Reap immediately so the killed turn's process doesn't linger as
                // a zombie until the next turn (the reader thread's `child = None`
                // drops the handle without waiting, so wait() here).
                let _ = child.wait();
            }
            return Ok(());
        }
    }
    let rid = NEXT_REQ.fetch_add(1, Ordering::SeqCst);
    let line = format!(
        "{{\"type\":\"control_request\",\"request_id\":\"int-{rid}\",\"request\":{{\"subtype\":\"interrupt\"}}}}\n"
    );
    write_line(session_id, &line)
}

/// Steers the in-flight turn with a follow-up message WITHOUT interrupting it.
/// This is the unified mid-turn dispatcher — it picks the right mechanism per
/// engine, and returns Err when the message must wait in the frontend queue:
///
/// - **claude**: writes the user line straight to the persistent process's
///   stdin. Verified empirically against claude 2.1.170 (stream-json stdin
///   mode): a user line written mid-turn is picked up between agent steps and
///   folded into the SAME turn, codex-style — no interrupt, no second turn.
///   Because stdin injection is a full user line, it carries image content
///   blocks too (`user_line_with_images`).
/// - **codex**: `turn/steer` RPC (text-only — the RPC takes text input items;
///   image-carrying messages return Err so the frontend keeps them queued and
///   they fire as a normal turn with real content blocks).
/// - **opencode**: no live process mid-turn — always Err → frontend queue.
#[tauri::command]
pub fn chat_steer(
    session_id: u32,
    text: String,
    image_paths: Option<Vec<String>>,
) -> Result<(), String> {
    let s = with_sessions(|m| m.get(&session_id).cloned())
        .ok_or_else(|| format!("chat session {session_id} not found"))?;
    let images = image_paths.unwrap_or_default();
    match s.engine {
        Engine::Codex => {
            if !images.is_empty() {
                return Err("codex steer is text-only — image messages stay queued".into());
            }
            codex_steer(&s, &text)
        }
        Engine::Claude => {
            // No live turn → nothing to steer into; Err makes the frontend fall
            // back to a normal send/queue instead of silently starting a turn
            // the composer doesn't know about.
            if !s.busy.load(Ordering::SeqCst) {
                return Err("no active claude turn to steer".into());
            }
            let line = if images.is_empty() {
                user_line(&text)
            } else {
                user_line_with_images(&text, &images)
            };
            write_line(session_id, &line)
        }
        Engine::Opencode => Err("steering not supported for this engine".into()),
    }
}

/// Writes a raw, already-formed JSON line to a session's stdin (must end in
/// `\n`). Used by the frontend to reply to claude's control protocol — e.g.
/// permission/approval decisions in `default` mode, which arrive as a
/// `control_request` with `subtype:"can_use_tool"` and expect a matching
/// `control_response`. Kept generic so the control schema can evolve in TS
/// without touching Rust (same philosophy as the dumb-pipe stdout reader).
#[tauri::command]
pub fn chat_send_raw(session_id: u32, line: String) -> Result<(), String> {
    // codex sessions don't speak claude's control protocol. The frontend sends
    // the SAME claude `control_response` shape for an approval decision (parity
    // with the ApprovalCard); translate it into codex's JSON-RPC response on the
    // held request id (see pending_approvals). Anything that isn't a recognized
    // codex approval reply is dropped (codex has no other raw-stdin protocol).
    if let Some(s) = with_sessions(|m| m.get(&session_id).cloned()) {
        if matches!(s.engine, Engine::Codex) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                let resp = v.get("response");
                let rid = resp
                    .and_then(|r| r.get("request_id"))
                    .and_then(|x| x.as_str());
                if let Some(rid) = rid {
                    if let Some(rpc_id) = s.pending_approvals.lock().remove(rid) {
                        // claude inner shape: response.response.behavior = allow|deny.
                        let behavior = resp
                            .and_then(|r| r.get("response"))
                            .and_then(|inner| inner.get("behavior"))
                            .and_then(|x| x.as_str())
                            .unwrap_or("deny");
                        let allow_always = resp
                            .and_then(|r| r.get("response"))
                            .and_then(|inner| inner.get("updatedPermissions"))
                            .is_some();
                        // codex decision enum: approved | approved_for_session |
                        // denied | abort.
                        let decision = match (behavior, allow_always) {
                            ("allow", true) => "approved_for_session",
                            ("allow", false) => "approved",
                            _ => "denied",
                        };
                        codex_rpc_write(
                            &s,
                            &json!({
                                "jsonrpc": "2.0",
                                "id": rpc_id,
                                "result": { "decision": decision }
                            }),
                        );
                    }
                }
            }
            return Ok(());
        }
    }
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
        s.busy.store(false, Ordering::SeqCst);
        s.detached.store(false, Ordering::SeqCst);
        s.notify_on_done.store(false, Ordering::SeqCst);
        fan_out(
            &s,
            "{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"text\":\"stopped by user\",\"total_cost_usd\":0}",
        );
        if let Some(child) = s.child.lock().as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *s.stdin.lock() = None;
        *s.sink.lock() = None;
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
    /// Backend that owns this conversation (`claude` | `codex` | `opencode`).
    #[serde(default)]
    pub engine: String,
    /// Model id used when the session was recorded, if known.
    #[serde(default)]
    pub model: String,
    /// The MOST RECENT user message in the conversation (preview line in the
    /// /resume picker). The `title` stays the FIRST user message (a stable
    /// label); this surfaces "where you left off". Populated lazily by
    /// `list_chat_sessions` from the transcript/rollout; empty when unknown.
    #[serde(default)]
    pub last_user: String,
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
pub fn record_chat_session(
    id: String,
    title: String,
    cwd: Option<String>,
    engine: Option<String>,
    model: Option<String>,
    // True only on a REAL content advance (a genuine user send). False for
    // bookkeeping upserts — a no-op resume that merely re-keys the entry to a
    // fresh claude session_id, or a metadata refresh. Bumping mtime on every
    // upsert scrambled the recency order in the /resume picker (a session you
    // only RE-OPENED jumped to the top over one you actually worked in), so we
    // only advance mtime when there's true activity. Defaults to true so older
    // callers / the web path keep the previous behavior.
    bump_mtime: Option<bool>,
) -> Result<(), String> {
    if id.trim().is_empty() {
        return Ok(());
    }
    let bump_mtime = bump_mtime.unwrap_or(true);
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
        if bump_mtime {
            existing.mtime = now;
        }
        if !title.trim().is_empty() {
            existing.title = trimmed;
        }
        if let Some(engine) = engine.as_deref().filter(|s| !s.is_empty()) {
            existing.engine = engine.to_string();
        }
        if let Some(model) = model.as_deref().filter(|s| !s.is_empty()) {
            existing.model = model.to_string();
        }
    } else {
        store.push(ChatSessionInfo {
            id,
            title: trimmed,
            cwd: cwd.unwrap_or_default(),
            mtime: now,
            engine: engine.unwrap_or_default(),
            model: model.unwrap_or_default(),
            last_user: String::new(),
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

/// Lists chat-pane sessions plus local Codex rollouts, newest first.
#[tauri::command]
pub fn list_chat_sessions(limit: Option<u32>) -> Vec<ChatSessionInfo> {
    let mut store = load_store();
    if let Ok(home) = std::env::var("HOME") {
        let home = std::path::Path::new(&home);
        for session in &mut store {
            if session.engine.is_empty() {
                session.engine = infer_session_engine(home, &session.id).to_string();
            }
        }
        for session in discover_codex_sessions(home, 200) {
            if !store.iter().any(|existing| existing.id == session.id) {
                store.push(session);
            }
        }
    }
    store.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    store.truncate(limit.unwrap_or(40) as usize);
    // Enrich ONLY the returned (post-truncate) entries with their most-recent
    // user message, for the picker's "where you left off" preview. Bounded to
    // the visible window so we never read hundreds of transcripts.
    if let Ok(home) = std::env::var("HOME") {
        let home = std::path::Path::new(&home);
        for session in &mut store {
            session.last_user = last_user_text(home, &session.id).unwrap_or_default();
        }
    }
    store
}

/// Reads the MOST RECENT user-authored text from a session's transcript/rollout.
/// Handles both engines via the same files `read_chat_transcript` reads: a claude
/// `*.jsonl` at `~/.claude/projects/*/<id>.jsonl`, or a codex rollout. Returns the
/// last user turn (trimmed, single-lined, capped) — what the user said last, i.e.
/// where they left off. `None` if no transcript / no user turn is found.
fn last_user_text(home: &std::path::Path, id: &str) -> Option<String> {
    let projects = home.join(".claude/projects");
    let mut turns: Option<Vec<ChatTurn>> = None;
    if let Ok(dirs) = std::fs::read_dir(&projects) {
        for dir in dirs.flatten() {
            let cand = dir.path().join(format!("{id}.jsonl"));
            if cand.is_file() {
                if let Ok(text) = std::fs::read_to_string(&cand) {
                    turns = Some(parse_claude_transcript(&text));
                }
                break;
            }
        }
    }
    if turns.is_none() {
        if let Some(fp) = find_codex_rollout_in_home(home, id) {
            if let Ok(text) = std::fs::read_to_string(&fp) {
                turns = Some(parse_codex_rollout(&text));
            }
        }
    }
    let last = turns?
        .into_iter()
        .rev()
        .find(|t| t.role == "user")
        .map(|t| t.text)?;
    let one_line = last.trim().replace('\n', " ");
    if one_line.is_empty() {
        return None;
    }
    Some(if one_line.chars().count() > 120 {
        format!("{}…", one_line.chars().take(120).collect::<String>())
    } else {
        one_line
    })
}

/// Loads a past session's conversation (user + assistant text turns) so the pane
/// can repaint it before resuming. Handles BOTH engines: claude transcripts at
/// `~/.claude/projects/*/<id>.jsonl`, and codex rollouts at
/// `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` (a different schema).
/// Tries claude first (its id is a uuid that won't collide); falls back to codex
/// so resuming a gpt-5.x chat repaints its history instead of showing blank.
#[tauri::command]
pub fn read_chat_transcript(id: String) -> Vec<ChatTurn> {
    let Ok(home) = std::env::var("HOME") else {
        return Vec::new();
    };
    // ── claude: ~/.claude/projects/*/<id>.jsonl ──
    let projects = std::path::PathBuf::from(&home).join(".claude/projects");
    if let Ok(dirs) = std::fs::read_dir(&projects) {
        for dir in dirs.flatten() {
            let cand = dir.path().join(format!("{id}.jsonl"));
            if cand.is_file() {
                if let Ok(text) = std::fs::read_to_string(&cand) {
                    return parse_claude_transcript(&text);
                }
            }
        }
    }
    // ── codex: ~/.codex-chat/sessions OR ~/.codex/sessions ──
    // ChatPane's stripped CODEX_HOME writes rollouts under `.codex-chat`; normal
    // Codex desktop/TUI sessions live under `.codex`. Search both so reopening a
    // gpt chat repaints the real transcript instead of an empty conversation.
    if let Some(fp) = find_codex_rollout_in_home(std::path::Path::new(&home), &id) {
        if let Ok(text) = std::fs::read_to_string(&fp) {
            return parse_codex_rollout(&text);
        }
    }
    Vec::new()
}

/// Parses a claude `*.jsonl` transcript → user/assistant text turns.
fn parse_claude_transcript(text: &str) -> Vec<ChatTurn> {
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
        let Some(msg) = v.get("message") else {
            continue;
        };
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
            turns.push(ChatTurn {
                role: role.to_string(),
                text: text_acc,
            });
        }
    }
    turns
}

/// Finds the codex rollout file for a thread id by walking the YYYY/MM/DD tree
/// (3 levels deep) and matching `…<id>.jsonl`. Codex names rollouts
/// `rollout-<timestamp>-<id>.jsonl`, so a suffix match is unambiguous.
fn find_codex_rollout(root: &std::path::Path, id: &str) -> Option<std::path::PathBuf> {
    let suffix = format!("{id}.jsonl");
    fn walk(dir: &std::path::Path, suffix: &str, depth: u8) -> Option<std::path::PathBuf> {
        if depth > 4 {
            return None;
        }
        let entries = std::fs::read_dir(dir).ok()?;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if let Some(found) = walk(&p, suffix, depth + 1) {
                    return Some(found);
                }
            } else if p
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(suffix))
            {
                return Some(p);
            }
        }
        None
    }
    walk(root, &suffix, 0)
}

/// Finds a rollout in the ChatPane-specific Codex home first, then falls back to
/// the user's normal Codex home for older sessions created before isolation.
fn find_codex_rollout_in_home(home: &std::path::Path, id: &str) -> Option<std::path::PathBuf> {
    [".codex-chat/sessions", ".codex/sessions"]
        .iter()
        .find_map(|rel| find_codex_rollout(&home.join(rel), id))
}

fn discover_codex_sessions(home: &std::path::Path, limit: usize) -> Vec<ChatSessionInfo> {
    let mut sessions = Vec::new();
    for rel in [".codex-chat/sessions", ".codex/sessions"] {
        collect_codex_rollouts(&home.join(rel), &mut sessions, limit.saturating_mul(2), 0);
    }
    sessions.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    let mut seen = std::collections::HashSet::new();
    sessions.retain(|session| seen.insert(session.id.clone()));
    sessions.truncate(limit);
    sessions
}

fn collect_codex_rollouts(
    dir: &std::path::Path,
    out: &mut Vec<ChatSessionInfo>,
    max: usize,
    depth: u8,
) {
    if depth > 4 || out.len() >= max {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= max {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_codex_rollouts(&path, out, max, depth + 1);
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
        {
            if let Some(session) = codex_session_info_from_rollout(&path) {
                out.push(session);
            }
        }
    }
}

fn codex_session_info_from_rollout(path: &std::path::Path) -> Option<ChatSessionInfo> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut id = String::new();
    let mut cwd = String::new();
    let mut model = String::new();
    let mut title = String::new();

    for line in text.lines().take(200) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(payload) = v.get("payload") else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
            if let Some(s) = payload.get("id").and_then(|x| x.as_str()) {
                id = s.to_string();
            }
            if let Some(s) = payload.get("cwd").and_then(|x| x.as_str()) {
                cwd = s.to_string();
            }
            if let Some(s) = payload.get("model").and_then(|x| x.as_str()) {
                model = s.to_string();
            }
            if model.is_empty() {
                if let Some(s) = payload.get("model_slug").and_then(|x| x.as_str()) {
                    model = s.to_string();
                }
            }
            continue;
        }
        if title.is_empty() {
            if let Some(candidate) = first_codex_user_text(payload) {
                title = title_from_text(&candidate);
            }
        }
        if !id.is_empty() && !title.is_empty() {
            break;
        }
    }

    if id.is_empty() {
        id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(id_from_codex_rollout_stem)
            .unwrap_or_default();
    }
    if id.is_empty() {
        return None;
    }
    if title.is_empty() {
        title = "(untitled codex chat)".to_string();
    }
    let mtime = path
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Some(ChatSessionInfo {
        id,
        title,
        cwd,
        mtime,
        engine: "codex".to_string(),
        model,
        last_user: String::new(),
    })
}

fn first_codex_user_text(payload: &serde_json::Value) -> Option<String> {
    if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
        return None;
    }
    if payload.get("role").and_then(|r| r.as_str()) != Some("user") {
        return None;
    }
    let mut text_acc = String::new();
    for block in payload.get("content").and_then(|c| c.as_array())? {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("input_text") | Some("text") => {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    text_acc.push_str(t);
                }
            }
            _ => {}
        }
    }
    let text = text_acc.trim();
    if text.is_empty()
        || text.starts_with("<permissions")
        || text.starts_with("<user_instructions")
        || text.starts_with("<environment_context")
    {
        None
    } else {
        Some(text.to_string())
    }
}

fn title_from_text(text: &str) -> String {
    let one_line = text.trim().replace('\n', " ");
    if one_line.chars().count() > 90 {
        format!("{}…", one_line.chars().take(90).collect::<String>())
    } else if one_line.is_empty() {
        "(untitled codex chat)".to_string()
    } else {
        one_line
    }
}

fn id_from_codex_rollout_stem(stem: &str) -> String {
    // rollout-2026-06-01t02-18-15-019e7f41-aaaa-bbbb
    // keep the entire thread id, not only the uuid suffix after its last dash.
    stem.find("-019")
        .map(|idx| stem[idx + 1..].to_string())
        .unwrap_or_else(|| stem.strip_prefix("rollout-").unwrap_or(stem).to_string())
}

fn infer_session_engine(home: &std::path::Path, id: &str) -> &'static str {
    if find_codex_rollout_in_home(home, id).is_some() {
        "codex"
    } else {
        "claude"
    }
}

/// Parses a codex rollout `*.jsonl` → user/assistant text turns, in file order.
/// Codex splits the two sides across two line shapes:
///   • USER      → `{"type":"response_item","payload":{"type":"message",
///                   "role":"user","content":[{"type":"input_text","text":..}]}}`
///   • ASSISTANT → `{"type":"event_msg","payload":{"type":"agent_message",
///                   "message":".."}}`
/// (assistant replies are NOT `response_item/message` — that tripped the first
/// cut, which showed only the user side.) Skips codex's injected `developer`
/// context and the XML-tagged user context blocks (permissions / user_instructions
/// / environment_context) so only real conversation repaints.
fn parse_codex_rollout(text: &str) -> Vec<ChatTurn> {
    let mut turns = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(p) = v.get("payload") else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            // user side — response_item / message / role=user
            Some("response_item") => {
                if p.get("type").and_then(|t| t.as_str()) != Some("message") {
                    continue;
                }
                if p.get("role").and_then(|r| r.as_str()) != Some("user") {
                    continue; // developer/system/assistant handled elsewhere
                }
                let mut text_acc = String::new();
                if let Some(arr) = p.get("content").and_then(|c| c.as_array()) {
                    for b in arr {
                        match b.get("type").and_then(|t| t.as_str()) {
                            Some("input_text") | Some("text") => {
                                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                    text_acc.push_str(t);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                let text_acc = text_acc.trim().to_string();
                if text_acc.is_empty()
                    || text_acc.starts_with("<permissions")
                    || text_acc.starts_with("<user_instructions")
                    || text_acc.starts_with("<environment_context")
                {
                    continue;
                }
                turns.push(ChatTurn {
                    role: "user".to_string(),
                    text: text_acc,
                });
            }
            // assistant side — event_msg / agent_message / message:".."
            Some("event_msg") => {
                if p.get("type").and_then(|t| t.as_str()) != Some("agent_message") {
                    continue;
                }
                if let Some(t) = p.get("message").and_then(|m| m.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() {
                        turns.push(ChatTurn {
                            role: "assistant".to_string(),
                            text: t.to_string(),
                        });
                    }
                }
            }
            _ => {}
        }
    }
    turns
}

#[cfg(test)]
mod tests {
    use super::{
        adapt_codex_appserver_frame, buffer_push, codex_config_without_mcp_servers,
        discover_codex_sessions, find_codex_rollout_in_home, infer_session_engine,
        slim_user_image_line, ChatSession, Engine,
    };
    use aios_chat_core::session::REPLAY_BYTE_CAP;
    use parking_lot::Mutex;
    use serde_json::json;
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;

    fn test_codex_session() -> Arc<ChatSession> {
        Arc::new(ChatSession {
            id: 0,
            engine: Engine::Codex,
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            thread_id: Mutex::new(None),
            cwd: Mutex::new(None),
            model: Mutex::new(None),
            effort: Mutex::new(None),
            sink: Mutex::new(None),
            buffer: Mutex::new(VecDeque::new()),
            buffer_bytes: AtomicUsize::new(0),
            claude_id: Mutex::new(None),
            title: Mutex::new(String::new()),
            busy: AtomicBool::new(false),
            detached: AtomicBool::new(false),
            notify_on_done: AtomicBool::new(false),
            rpc_id: AtomicU64::new(1),
            pending_turn: Mutex::new(None),
            active_turn: Mutex::new(None),
            answer_item: Mutex::new(None),
            answer_streamed: AtomicBool::new(false),
            pending_approvals: Mutex::new(HashMap::new()),
        })
    }

    /// Registers a session under a unique high id (clear of NEXT_ID's range)
    /// so command-level tests can exercise the global registry without
    /// interfering with each other.
    fn register_test_session(id: u32, engine: Engine, busy: bool) {
        let sess = Arc::new(ChatSession {
            engine,
            busy: AtomicBool::new(busy),
            id,
            ..match Arc::try_unwrap(test_codex_session()) {
                Ok(s) => s,
                Err(_) => unreachable!("fresh test session has one owner"),
            }
        });
        super::with_sessions(|m| {
            m.insert(id, sess);
        });
    }

    #[test]
    fn chat_steer_routes_and_rejects_per_engine() {
        // claude with no live turn → Err (frontend falls back to send/queue)…
        register_test_session(900_001, Engine::Claude, false);
        let e = super::chat_steer(900_001, "x".into(), None).unwrap_err();
        assert!(e.contains("no active claude turn"), "got: {e}");
        // …and with a live turn it attempts the stdin write (no stdin in the
        // test session → the write path is reached and reports it, instead of
        // the no-active-turn gate firing).
        register_test_session(900_002, Engine::Claude, true);
        let e = super::chat_steer(900_002, "x".into(), None).unwrap_err();
        assert!(e.contains("stdin"), "got: {e}");
        // codex steering is text-only: image-carrying messages must stay queued.
        register_test_session(900_003, Engine::Codex, true);
        let e =
            super::chat_steer(900_003, "x".into(), Some(vec!["/tmp/i.png".into()])).unwrap_err();
        assert!(e.contains("text-only"), "got: {e}");
        // opencode has no mid-turn channel at all.
        register_test_session(900_004, Engine::Opencode, true);
        assert!(super::chat_steer(900_004, "x".into(), None).is_err());
        super::with_sessions(|m| {
            for id in [900_001, 900_002, 900_003, 900_004] {
                m.remove(&id);
            }
        });
    }

    #[test]
    fn codex_appserver_streams_agent_message_delta_without_item_id_as_answer() {
        let sess = test_codex_session();
        let out = adapt_codex_appserver_frame(
            &sess,
            r#"{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"hello"}}"#,
        );

        assert_eq!(out.len(), 1);
        assert!(out[0].contains("\"text_delta\""));
        assert!(out[0].contains("hello"));
        assert!(sess.answer_streamed.load(Ordering::SeqCst));
    }

    #[test]
    fn codex_appserver_streams_agent_message_delta_with_snake_item_id_as_answer() {
        let sess = test_codex_session();
        let _ = adapt_codex_appserver_frame(
            &sess,
            r#"{"jsonrpc":"2.0","method":"item/started","params":{"item":{"id":"ans-1","type":"agentMessage","phase":"final_answer"}}}"#,
        );
        let out = adapt_codex_appserver_frame(
            &sess,
            r#"{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"item_id":"ans-1","delta":"hello"}}"#,
        );

        assert_eq!(out.len(), 1);
        assert!(out[0].contains("\"text_delta\""));
        assert!(out[0].contains("hello"));
        assert!(sess.answer_streamed.load(Ordering::SeqCst));
    }

    #[test]
    fn codex_appserver_suppresses_completed_answer_after_streamed_delta_without_item_id() {
        let sess = test_codex_session();
        let _ = adapt_codex_appserver_frame(
            &sess,
            r#"{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"hello"}}"#,
        );
        let out = adapt_codex_appserver_frame(
            &sess,
            r#"{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"type":"agentMessage","phase":"final_answer","text":"hello"}}}"#,
        );

        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn codex_appserver_error_response_closes_busy_turn() {
        let sess = test_codex_session();
        *sess.thread_id.lock() = Some("thread-1".into());
        sess.busy.store(true, Ordering::SeqCst);

        let out = adapt_codex_appserver_frame(
            &sess,
            r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32602,"message":"turn already active"}}"#,
        );

        assert_eq!(out.len(), 1);
        assert!(out[0].contains(r#""type":"result""#), "{out:?}");
        assert!(
            out[0].contains(r#""subtype":"error_during_execution""#),
            "{out:?}"
        );
        assert!(out[0].contains(r#""is_error":true"#), "{out:?}");
        assert!(out[0].contains("turn already active"), "{out:?}");
    }

    #[test]
    fn codex_interrupt_before_thread_ready_drops_queued_turn_and_frees_busy() {
        let sess = test_codex_session();
        *sess.pending_turn.lock() = Some(("do it".into(), Vec::new()));
        sess.busy.store(true, Ordering::SeqCst);

        let res = super::codex_interrupt(&sess);

        assert!(res.is_ok());
        assert!(sess.pending_turn.lock().is_none());
        assert!(!sess.busy.load(Ordering::SeqCst));
        assert!(
            sess.buffer
                .lock()
                .iter()
                .any(|line| line.contains("stopped by user") && line.contains(r#""type":"result""#)),
            "buffer: {:?}",
            sess.buffer.lock()
        );
    }

    #[test]
    fn codex_chat_config_keeps_terminal_defaults_but_strips_mcp_servers() {
        let src = r#"model = "gpt-5.5"
model_reasoning_effort = "low"

[plugins."github@openai-curated"]
enabled = true

[mcp_servers.memory]
command = "node"

[mcp_servers.memory.env]
CODEX_HOME = "/Users/firazfhansurie/.codex"

[features]
js_repl = false
"#;
        let out = codex_config_without_mcp_servers(src);

        assert!(out.contains("model_reasoning_effort = \"low\""));
        assert!(out.contains("[plugins.\"github@openai-curated\"]"));
        assert!(out.contains("[features]"));
        assert!(out.contains("trust_level = \"trusted\""));
        assert!(!out.contains("[mcp_servers.memory]"));
        assert!(!out.contains("[mcp_servers.memory.env]"));
        assert!(!out.contains("command = \"node\""));
    }

    #[test]
    fn finds_chatpane_codex_rollout_before_normal_codex_home() {
        let root =
            std::env::temp_dir().join(format!("aios-chat-rollout-test-{}", std::process::id()));
        let chat = root.join(".codex-chat/sessions/2026/06/01");
        let normal = root.join(".codex/sessions/2026/06/01");
        std::fs::create_dir_all(&chat).unwrap();
        std::fs::create_dir_all(&normal).unwrap();
        let id = "019e-test-thread";
        let chat_file = chat.join(format!("rollout-chat-{id}.jsonl"));
        let normal_file = normal.join(format!("rollout-normal-{id}.jsonl"));
        std::fs::write(&chat_file, "").unwrap();
        std::fs::write(&normal_file, "").unwrap();

        assert_eq!(find_codex_rollout_in_home(&root, id), Some(chat_file));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn falls_back_to_normal_codex_home_for_older_rollouts() {
        let root =
            std::env::temp_dir().join(format!("aios-normal-rollout-test-{}", std::process::id()));
        let normal = root.join(".codex/sessions/2026/06/01");
        std::fs::create_dir_all(&normal).unwrap();
        let id = "019e-old-thread";
        let normal_file = normal.join(format!("rollout-normal-{id}.jsonl"));
        std::fs::write(&normal_file, "").unwrap();

        assert_eq!(find_codex_rollout_in_home(&root, id), Some(normal_file));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn infers_codex_engine_for_existing_chatpane_rollout() {
        let root =
            std::env::temp_dir().join(format!("aios-engine-inference-test-{}", std::process::id()));
        let chat = root.join(".codex-chat/sessions/2026/06/01");
        std::fs::create_dir_all(&chat).unwrap();
        let id = "019e-inferred-thread";
        std::fs::write(chat.join(format!("rollout-chat-{id}.jsonl")), "").unwrap();

        assert_eq!(infer_session_engine(&root, id), "codex");
        assert_eq!(infer_session_engine(&root, "missing"), "claude");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn discovers_normal_codex_rollouts_for_resume() {
        let root =
            std::env::temp_dir().join(format!("aios-discover-codex-test-{}", std::process::id()));
        let normal = root.join(".codex/sessions/2026/06/01");
        std::fs::create_dir_all(&normal).unwrap();
        let id = "019e7f41-aaaa-bbbb-cccc-000000000001";
        let rollout = normal.join(format!("rollout-2026-06-01t02-18-15-{id}.jsonl"));
        let text = format!(
            r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"/Users/firazfhansurie/Repo/firaz/aios/shell","model":"gpt-5-codex"}}}}
{{"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"make resume and buttons commercial ready"}}]}}}}
"#
        );
        std::fs::write(&rollout, text).unwrap();

        let sessions = discover_codex_sessions(&root, 40);

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, id);
        assert_eq!(sessions[0].engine, "codex");
        assert_eq!(sessions[0].model, "gpt-5-codex");
        assert_eq!(
            sessions[0].title,
            "make resume and buttons commercial ready"
        );
        assert_eq!(
            sessions[0].cwd,
            "/Users/firazfhansurie/Repo/firaz/aios/shell"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn slim_user_image_line_replaces_base64_with_placeholder() {
        let line = json!({
            "type": "user",
            "message": { "role": "user", "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA_huge_base64_AAAA" } },
                { "type": "text", "text": "what is this" }
            ]}
        });
        let slim = slim_user_image_line(&line).expect("image line should slim");
        assert!(
            !slim.contains("AAAA_huge_base64_AAAA"),
            "base64 must be dropped: {slim}"
        );
        assert!(!slim.contains("base64"), "no image source retained: {slim}");
        assert!(slim.contains("[image]"), "placeholder kept: {slim}");
        assert!(slim.contains("what is this"), "user text kept: {slim}");
    }

    #[test]
    fn slim_user_image_line_ignores_text_only_user_lines() {
        let line = json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": "hi" }] }
        });
        assert!(slim_user_image_line(&line).is_none());
    }

    #[test]
    fn buffer_push_evicts_under_byte_budget() {
        let sess = test_codex_session();
        // One line a touch over half the byte cap; the third push must evict the
        // oldest so total bytes stay under REPLAY_BYTE_CAP.
        let big = "x".repeat(REPLAY_BYTE_CAP / 2 + 1024);
        buffer_push(&sess, &big);
        buffer_push(&sess, &big);
        buffer_push(&sess, &big);
        let bytes = sess.buffer_bytes.load(Ordering::Relaxed);
        assert!(bytes <= REPLAY_BYTE_CAP, "over byte cap: {bytes}");
        // Accounting matches the actual buffered content.
        let actual: usize = sess.buffer.lock().iter().map(|l| l.len()).sum();
        assert_eq!(actual, bytes, "byte counter drifted from buffer");
    }
}
