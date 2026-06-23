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

use std::collections::HashSet;
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
use aios_chat_core::adapt::{adapt_codex_line, adapt_opencode_line};
use aios_chat_core::codex_rpc::{
    adapt_codex_appserver_frame, codex_error_result_line, codex_fire_turn, codex_next_rpc,
    codex_rpc_write, NEXT_REQ,
};
use aios_chat_core::session::{buffer_push, fan_out, fan_out_split, ChatSession};
use aios_chat_core::wire::{json_escape, slim_user_image_line, user_line, user_line_with_images};
use aios_chat_core::{Engine, OutputSink};

/// How long token deltas accumulate before a coalesced frame is flushed to the
/// frontend. ~50ms caps the IPC rate at ~20 frames/sec regardless of how fast
/// claude streams tokens — instead of one Tauri event per token (hundreds/sec on
/// a fast turn), the renderer gets a steady, batched feed. Lower = snappier but
/// more IPC; higher = fewer events but choppier text reveal.
const COALESCE_FLUSH_MS: u64 = 50;

/// A run of same-kind token deltas being accumulated before flush. `template` is
/// the FIRST line of the run, parsed once; on flush we swap its delta text for
/// the concatenated `text` and re-serialize — so the emitted frame is byte-shape
/// identical to a single claude `stream_event` (same `index`, same nesting), just
/// carrying many tokens' worth of text. The frontend handler is purely additive
/// (`runEvents.ts` appends `delta.text` / `delta.thinking`), so a merged frame is
/// indistinguishable from N separate ones.
struct PendingRun {
    /// "text_delta" or "thinking_delta" — runs of different kinds never merge.
    kind: &'static str,
    template: Value,
    text: String,
}

#[derive(Default)]
struct Coalescer {
    pending: Option<PendingRun>,
}

/// Detects a coalescible claude token-delta line and returns its (kind, text).
/// Gated behind a cheap substring check so non-delta lines never hit serde — the
/// same hot-path discipline `ingest_line` uses. `index`/block bookkeeping is
/// preserved by reusing the first line as the flush template, so we only need the
/// delta text here.
fn coalescible_delta(line: &str) -> Option<(&'static str, Value)> {
    // Fast reject: a token frame is a stream_event content_block_delta carrying a
    // text/thinking delta. If neither needle is present it can't be coalescible.
    let is_text = line.contains("\"text_delta\"");
    let is_thinking = !is_text && line.contains("\"thinking_delta\"");
    if !is_text && !is_thinking {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    // Only coalesce the exact streaming shape; anything else passes through whole.
    if v.get("type").and_then(|x| x.as_str()) != Some("stream_event") {
        return None;
    }
    let event = v.get("event")?;
    if event.get("type").and_then(|x| x.as_str()) != Some("content_block_delta") {
        return None;
    }
    let delta = event.get("delta")?;
    let kind = delta.get("type").and_then(|x| x.as_str())?;
    match kind {
        "text_delta" if delta.get("text").and_then(|x| x.as_str()).is_some() => {
            Some(("text_delta", v))
        }
        "thinking_delta" if delta.get("thinking").and_then(|x| x.as_str()).is_some() => {
            Some(("thinking_delta", v))
        }
        _ => None,
    }
}

/// Pulls the delta text fragment out of a (already-validated) token line.
fn delta_fragment(line: &Value, kind: &str) -> String {
    let field = if kind == "thinking_delta" {
        "thinking"
    } else {
        "text"
    };
    line.get("event")
        .and_then(|e| e.get("delta"))
        .and_then(|d| d.get(field))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// Rebuilds a single coalesced `stream_event` line from a run: the run's template
/// (first line) with its delta text replaced by the concatenated text.
fn render_run(run: &PendingRun) -> Option<String> {
    let mut v = run.template.clone();
    let field = if run.kind == "thinking_delta" {
        "thinking"
    } else {
        "text"
    };
    let slot = v
        .get_mut("event")
        .and_then(|e| e.get_mut("delta"))
        .and_then(|d| d.get_mut(field))?;
    *slot = Value::String(run.text.clone());
    serde_json::to_string(&v).ok()
}

/// The Tauri-shell implementation of [`OutputSink`]: forwards each adapted line
/// over a per-session `tauri::ipc::Channel<String>`. This is the ONE place the
/// core's sink seam binds to Tauri on the laptop; `aios-noded` will provide a
/// WebSocket-backed sink instead. Sends are lossy on a dropped receiver (a closed
/// pane), exactly as before — the reader thread never wedges on a dead channel.
///
/// Per-token IPC batching: token deltas are accumulated into a coalescing buffer
/// and flushed on a ~50ms timer, on turn end, or on ANY non-token line (so a tool
/// call / result never overtakes the text preceding it). This trades one Tauri
/// event per token (hundreds/sec) for ~20 frames/sec, with zero frontend change —
/// a merged frame is a normal `stream_event` carrying more text. Ordering is
/// preserved because every non-delta `send` flushes the pending run first.
struct ChannelSink {
    chan: Channel<String>,
    coalescer: Arc<Mutex<Coalescer>>,
    alive: Arc<AtomicBool>,
}

impl ChannelSink {
    fn new(chan: Channel<String>) -> Self {
        let coalescer = Arc::new(Mutex::new(Coalescer::default()));
        let alive = Arc::new(AtomicBool::new(true));
        // One long-lived flush thread per sink: ticks every COALESCE_FLUSH_MS and
        // flushes whatever has accumulated. Exits when the sink is dropped (the
        // pane closes / detaches and the sink is swapped out). Cheap: it sleeps
        // 50ms between ticks and does nothing when the buffer is empty.
        {
            let chan = chan.clone();
            let coalescer = Arc::clone(&coalescer);
            let alive = Arc::clone(&alive);
            thread::spawn(move || {
                while alive.load(Ordering::Relaxed) {
                    thread::sleep(std::time::Duration::from_millis(COALESCE_FLUSH_MS));
                    let flushed = {
                        let mut c = coalescer.lock();
                        c.pending.take()
                    };
                    if let Some(run) = flushed {
                        if let Some(line) = render_run(&run) {
                            let _ = chan.send(line);
                        }
                    }
                }
            });
        }
        Self {
            chan,
            coalescer,
            alive,
        }
    }
}

impl Drop for ChannelSink {
    fn drop(&mut self) {
        // Stop the flush thread and flush any straggler tokens so a detach mid-run
        // doesn't drop the tail of a sentence (the send is lossy if the pane is
        // already gone, which is fine).
        self.alive.store(false, Ordering::Relaxed);
        let flushed = self.coalescer.lock().pending.take();
        if let Some(run) = flushed {
            if let Some(line) = render_run(&run) {
                let _ = self.chan.send(line);
            }
        }
    }
}

impl OutputSink for ChannelSink {
    fn send(&self, line: &str) {
        match coalescible_delta(line) {
            Some((kind, parsed)) => {
                let mut c = self.coalescer.lock();
                let frag = delta_fragment(&parsed, kind);
                match c.pending.as_mut() {
                    // Same-kind run continues: append the fragment, keep the template.
                    Some(run) if run.kind == kind => run.text.push_str(&frag),
                    // A different-kind run is in flight (text↔thinking switch):
                    // flush it whole before starting the new run, to keep order.
                    Some(_) => {
                        let prev = c.pending.take();
                        drop(c);
                        if let Some(run) = prev {
                            if let Some(out) = render_run(&run) {
                                let _ = self.chan.send(out);
                            }
                        }
                        let mut c = self.coalescer.lock();
                        c.pending = Some(PendingRun {
                            kind,
                            template: parsed,
                            text: frag,
                        });
                    }
                    None => {
                        c.pending = Some(PendingRun {
                            kind,
                            template: parsed,
                            text: frag,
                        });
                    }
                }
            }
            // Any non-token line (assistant block, tool_use, result, usage, …):
            // flush the pending run FIRST so the streamed text never lands after
            // the event that logically follows it, then forward the line as-is.
            None => {
                let flushed = self.coalescer.lock().pending.take();
                if let Some(run) = flushed {
                    if let Some(out) = render_run(&run) {
                        let _ = self.chan.send(out);
                    }
                }
                let _ = self.chan.send(line.to_string());
            }
        }
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
static WARM_CODEX: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// Runs `f` against the (lazily-initialised) session map.
fn with_sessions<R>(f: impl FnOnce(&mut HashMap<u32, Arc<ChatSession>>) -> R) -> R {
    let mut guard = SESSIONS.lock();
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

fn with_warm_codex<R>(f: impl FnOnce(&mut HashMap<String, u32>) -> R) -> R {
    let mut guard = WARM_CODEX.lock();
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

/// Builds a PATH that prepends the user's real tool dirs (homebrew, `~/.local/bin`,
/// the newest nvm-managed node bin) onto whatever the process inherited. A
/// GUI-launched app (Finder/Dock) inherits only `/usr/bin:/bin:/usr/sbin:/sbin`,
/// which starves anything `claude` spawns at session start — its MCP servers and
/// SessionStart hooks are node/python launchers that can't resolve their runtime
/// on the bare PATH, so the session DEADLOCKS on MCP init / hook resolution and the
/// pane shows "Working…" forever. (Codex sidesteps this with a native binary + a
/// stripped MCP profile; claude runs the real ~/.claude config, so it needs the
/// PATH.) Order is preserved and dirs are de-duplicated.
#[cfg(not(windows))]
pub(crate) fn enriched_path() -> String {
    let mut dirs: Vec<String> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(format!("{home}/.aios/state/bin"));
        dirs.push(format!("{home}/.local/bin"));
        // nvm: newest versioned node bin (claude's node-based MCP launchers live
        // here once installed via the nvm global).
        let nvm = format!("{home}/.nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm) {
            let mut versions: Vec<_> = entries.flatten().map(|e| e.path()).collect();
            versions.sort();
            versions.reverse();
            if let Some(v) = versions.first() {
                dirs.push(v.join("bin").to_string_lossy().to_string());
            }
        }
    }
    dirs.push("/opt/homebrew/bin".to_string());
    dirs.push("/usr/local/bin".to_string());
    dirs.push(
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".to_string()),
    );
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .flat_map(|d| d.split(':').map(|s| s.to_string()).collect::<Vec<_>>())
        .filter(|d| !d.is_empty() && seen.insert(d.clone()))
        .collect::<Vec<_>>()
        .join(":")
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
    node: Option<String>,
) -> Result<u32, String> {
    // Remote node (the bisnesgpt box): the session runs on `aios-noded` over the
    // tailnet, not locally. We allocate a local id (shared id space so the
    // frontend treats it like any session), then attach over WS. The command
    // handlers below consult the remote table first. Box is claude-only in v1.
    if node
        .as_deref()
        .is_some_and(|n| !n.is_empty() && n != "local")
    {
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        crate::remote::start(id, on_event, cwd, model, resume)?;
        return Ok(id);
    }

    let eng = Engine::parse(engine.as_deref());
    // codex (ChatGPT sub) → persistent codex app-server process (JSON-RPC).
    if matches!(eng, Engine::Codex) {
        if resume.as_deref().filter(|s| !s.is_empty()).is_none() && !fast.unwrap_or(false) {
            if let Some(id) = claim_warm_codex(
                on_event.clone(),
                cwd.as_deref(),
                model.as_deref(),
                permission_mode.as_deref(),
                effort.as_deref(),
            ) {
                return Ok(id);
            }
        }
        return start_codex_appserver(
            app,
            Some(on_event),
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
        return start_per_turn(eng, app, on_event, cwd, model, resume);
    }

    let mut cmd = Command::new(claude_bin());
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose");

    // resume a prior session id only if the transcript still exists. Claude
    // exits immediately on stale ids, leaving the pane with a broken stdin.
    let requested_resume_id = resume.filter(|s| !s.is_empty());
    let (resume_id, pruned_resume_id) = match std::env::var("HOME") {
        Ok(home) => {
            validate_claude_resume_in_home(std::path::Path::new(&home), requested_resume_id)
        }
        Err(_) => (requested_resume_id, None),
    };
    if let Some(stale) = pruned_resume_id.as_deref() {
        prune_store_session(stale);
    }
    if let Some(r) = resume_id.as_deref().filter(|s| !s.is_empty()) {
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
    // Strip MCP servers for the chat pane. The user's ~/.claude config loads every
    // configured MCP server on each spawn (memory, sentry, headroom, + plugin
    // servers like blender via `uvx`, figma, vercel, …). claude blocks on the MCP
    // init handshake before it will start a turn, so ONE slow/flaky server (e.g.
    // `uvx blender-mcp` fetching a package or waiting on a Blender socket) wedges
    // every chat turn on "Working…" forever with no reply. Codex's chat profile
    // already strips MCP for exactly this reason — match it: load a single empty
    // config and ignore all others, so the conversational chat pane spawns fast and
    // reliably. (MCP-tool use belongs in the terminal/agent, not the chat pane.)
    // Reversible: drop these two args to restore the full ~/.claude MCP set.
    cmd.arg("--strict-mcp-config")
        .arg("--mcp-config")
        .arg("{\"mcpServers\":{}}");
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

    // Give claude the user's real PATH. Without this, a GUI launch hands it the
    // bare `/usr/bin:/bin:/usr/sbin:/sbin`, and the node/python MCP servers + hooks
    // it spawns at session start can't resolve their runtime → the session
    // deadlocks on MCP init and the pane "Working…"s forever (codex is unaffected:
    // native binary + stripped MCP). Reversible: drop this line.
    #[cfg(not(windows))]
    cmd.env("PATH", enriched_path());

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
        sink: Mutex::new(Some(Box::new(ChannelSink::new(on_event)))),
        buffer: Mutex::new(VecDeque::with_capacity(256)),
        buffer_bytes: AtomicUsize::new(0),
        claude_id: Mutex::new(None),
        title: Mutex::new(String::new()),
        busy: AtomicBool::new(false),
        detached: AtomicBool::new(false),
        notify_on_done: AtomicBool::new(false),
        events: Box::new(TauriEvents { app: app.clone() }),
        rpc_id: AtomicU64::new(1),
        pending_turn: Mutex::new(None),
        active_turn: Mutex::new(None),
        answer_item: Mutex::new(None),
        answer_streamed: AtomicBool::new(false),
        pending_approvals: Mutex::new(HashMap::new()),
    });

    if let Some(stale) = pruned_resume_id.as_deref() {
        let line = format!(
            "{{\"type\":\"aios_resume_pruned\",\"engine\":\"claude\",\"id\":\"{}\"}}",
            json_escape(stale)
        );
        ingest_line(&session, &app, &line);
    }

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
        sess.events.on_exit(id);
    });

    // stderr reader: surface as synthetic error events through the same sink.
    if let Some(mut err) = stderr {
        let sess = Arc::clone(&session);
        let app_err = app.clone();
        // The resume id we passed (if any) so we can detect claude REJECTING it.
        // file-existence (our validation) ≠ resumable: claude can still exit with
        // "No conversation found with session ID: …" and die. When that happens we
        // emit `aios_resume_pruned` so the frontend drops the bad resume and respins
        // a FRESH session instead of leaving a dead-stdin, wedged pane.
        let resume_for_err = resume_id.clone();
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
                            // Resume rejected → tell the frontend to recover.
                            if line.contains("No conversation found") {
                                if let Some(stale) = resume_for_err.as_deref() {
                                    prune_store_session(stale);
                                    let pruned = format!(
                                        "{{\"type\":\"aios_resume_pruned\",\"engine\":\"claude\",\"id\":\"{}\"}}",
                                        json_escape(stale)
                                    );
                                    ingest_line(&sess, &app_err, &pruned);
                                }
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
    app: AppHandle,
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
        sink: Mutex::new(Some(Box::new(ChannelSink::new(on_event)))),
        buffer: Mutex::new(VecDeque::with_capacity(256)),
        buffer_bytes: AtomicUsize::new(0),
        claude_id: Mutex::new(None),
        title: Mutex::new(String::new()),
        busy: AtomicBool::new(false),
        detached: AtomicBool::new(false),
        notify_on_done: AtomicBool::new(false),
        events: Box::new(TauriEvents { app: app.clone() }),
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

fn codex_profile_key(
    cwd: Option<&str>,
    model: Option<&str>,
    permission_mode: Option<&str>,
    effort: Option<&str>,
) -> String {
    format!(
        "cwd={}|model={}|perm={}|effort={}",
        cwd.unwrap_or(""),
        model.unwrap_or(""),
        permission_mode.unwrap_or(""),
        effort.unwrap_or("")
    )
}

fn claim_warm_codex(
    on_event: Channel<String>,
    cwd: Option<&str>,
    model: Option<&str>,
    permission_mode: Option<&str>,
    effort: Option<&str>,
) -> Option<u32> {
    let key = codex_profile_key(cwd, model, permission_mode, effort);
    let id = with_warm_codex(|warm| warm.remove(&key))?;
    let session = with_sessions(|m| m.get(&id).cloned())?;
    if session.busy.load(Ordering::SeqCst) {
        return None;
    }
    for line in session.buffer.lock().iter() {
        let _ = on_event.send(line.clone());
    }
    *session.sink.lock() = Some(Box::new(ChannelSink::new(on_event)));
    Some(id)
}

/// Starts a persistent codex app-server session: spawns `<bin> app-server`,
/// performs the JSON-RPC handshake (initialize → initialized → thread/start or
/// thread/resume), and wires a reader thread that adapts frames into claude-shaped
/// lines. Mirrors `chat_start`'s claude path but over the JSON-RPC transport.
fn start_codex_appserver(
    app: AppHandle,
    on_event: Option<Channel<String>>,
    cwd: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    effort: Option<String>,
    resume: Option<String>,
    fast: bool,
) -> Result<u32, String> {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let mut cmd = Command::new(codex_appserver_bin());
    cmd.arg("app-server");
    cmd.env("AIOS_PARENT_CHAT_SESSION", id.to_string());
    cmd.env("AIOS_PARENT_CHAT_ENGINE", "codex");
    #[cfg(not(windows))]
    cmd.env("PATH", enriched_path());
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

    let session = Arc::new(ChatSession {
        id,
        engine: Engine::Codex,
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(Some(stdin)),
        thread_id: Mutex::new(None),
        cwd: Mutex::new(dir),
        model: Mutex::new(model.filter(|s| !s.is_empty())),
        effort: Mutex::new(effort.filter(|s| !s.is_empty())),
        sink: Mutex::new(on_event.map(|chan| Box::new(ChannelSink::new(chan)) as Box<dyn OutputSink>)),
        buffer: Mutex::new(VecDeque::with_capacity(256)),
        buffer_bytes: AtomicUsize::new(0),
        claude_id: Mutex::new(None),
        title: Mutex::new(String::new()),
        busy: AtomicBool::new(false),
        detached: AtomicBool::new(false),
        notify_on_done: AtomicBool::new(false),
        events: Box::new(TauriEvents { app: app.clone() }),
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
    let requested_resume_id = resume.filter(|s| !s.is_empty());
    let resume_id = requested_resume_id.and_then(|t| {
        let Ok(home) = std::env::var("HOME") else {
            return Some(t);
        };
        if find_codex_rollout_in_home(std::path::Path::new(&home), &t).is_some() {
            Some(t)
        } else {
            prune_store_session(&t);
            let line = format!(
                "{{\"type\":\"aios_resume_pruned\",\"engine\":\"codex\",\"id\":\"{}\"}}",
                json_escape(&t)
            );
            ingest_line_arc(&session, &line);
            None
        }
    });
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
        sess.events.on_exit(id);
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

#[tauri::command]
pub fn chat_prewarm_codex(
    app: AppHandle,
    cwd: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    effort: Option<String>,
) -> Result<u32, String> {
    let key = codex_profile_key(
        cwd.as_deref(),
        model.as_deref(),
        permission_mode.as_deref(),
        effort.as_deref(),
    );
    if let Some(existing) = with_warm_codex(|warm| warm.get(&key).copied()) {
        if with_sessions(|m| m.contains_key(&existing)) {
            return Ok(existing);
        }
        with_warm_codex(|warm| {
            warm.remove(&key);
        });
    }
    let id = start_codex_appserver(
        app,
        None,
        cwd,
        model,
        permission_mode,
        effort,
        None,
        false,
    )?;
    with_warm_codex(|warm| {
        warm.insert(key, id);
    });
    Ok(id)
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
            sess.events.on_notify(sess.id, &label);
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

/// The Tauri-shell implementation of the crate's [`aios_chat_core::SessionEvents`]
/// seam: a session's lifecycle callbacks become `AppHandle::emit` (plus a native
/// completion toast). On the box, `aios-noded` supplies its own impl, so the
/// session runtime in `aios-chat-core` never names Tauri. This struct is the ONLY
/// thing that turns those callbacks back into Tauri events.
struct TauriEvents {
    app: AppHandle,
}

impl aios_chat_core::SessionEvents for TauriEvents {
    /// Backing process exited → tell the frontend so the pane can flip state.
    fn on_exit(&self, session_id: u32) {
        let _ = self.app.emit("chat-exit", session_id);
    }

    /// A backgrounded chat finished → native OS notification AND the in-app
    /// `aios-notify` event (bell + toast, carrying the session id so the click
    /// reattaches the exact chat).
    fn on_notify(&self, session_id: u32, title: &str) {
        use tauri_plugin_notification::NotificationExt;
        let _ = self
            .app
            .notification()
            .builder()
            .title("✓ chat finished")
            .body(format!("{title} — done. click to reopen."))
            .show();
        let _ = self.app.emit(
            "aios-notify",
            AiosNotifyPayload {
                kind: "chat.done".to_string(),
                session_id,
                title: title.to_string(),
            },
        );
    }
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
    // Box-backed session → reverse-pipe the turn over the WS (images are not
    // forwarded to the remote in v1).
    if crate::remote::is_remote(session_id) {
        return crate::remote::send(session_id, &text);
    }
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
    // Remote sessions keep running on the box and buffer there; detaching the
    // pane just leaves the WS pumping in the background (v1 — no local sink to
    // null out). Reattach for remote is a future step.
    if crate::remote::is_remote(session_id) {
        return Ok(());
    }
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
    *s.sink.lock() = Some(Box::new(ChannelSink::new(on_event)));
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
    if crate::remote::is_remote(session_id) {
        return crate::remote::interrupt(session_id);
    }
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
    if crate::remote::is_remote(session_id) {
        return crate::remote::steer(session_id, &text);
    }
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
    if crate::remote::is_remote(session_id) {
        return crate::remote::stop(session_id);
    }
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

fn save_store(store: &[ChatSessionInfo]) {
    if let Some(path) = sessions_store() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        if let Ok(json) = serde_json::to_string(store) {
            let _ = std::fs::write(&tmp, json);
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn prune_store_session(id: &str) {
    let mut store = load_store();
    let before = store.len();
    store.retain(|session| session.id != id);
    if store.len() != before {
        save_store(&store);
    }
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
        let t = clean_chat_resume_text(&title);
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
    save_store(&store);
    Ok(())
}

/// Lists only sessions explicitly recorded by the chat pane, newest first.
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
        let before_prune = store.len();
        store.retain(|session| match session.engine.as_str() {
            "codex" => find_codex_rollout_in_home(home, &session.id).is_some(),
            "claude" => find_claude_transcript_in_home(home, &session.id).is_some(),
            _ => true,
        });
        if store.len() != before_prune {
            save_store(&store);
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
            session.title = clean_chat_resume_text(&session.title);
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
    let mut turns: Option<Vec<ChatTurn>> =
        find_claude_transcript_in_home(home, id).and_then(|fp| {
            std::fs::read_to_string(fp)
                .ok()
                .map(|text| parse_claude_transcript(&text))
        });
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
    let one_line = clean_chat_resume_text(&last);
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
    if let Some(fp) = find_claude_transcript_in_home(std::path::Path::new(&home), &id) {
        if let Ok(text) = std::fs::read_to_string(fp) {
            return parse_claude_transcript(&text);
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

/// Fast batch existence check for history cleanup. This intentionally validates
/// against transcript/rollout filenames, not arbitrary text matches inside a
/// transcript body, so pasted "stale resume id" errors do not keep dead rows alive.
#[tauri::command]
pub fn chat_transcripts_exist(ids: Vec<String>) -> Vec<String> {
    let Ok(home) = std::env::var("HOME") else {
        return Vec::new();
    };
    chat_transcripts_exist_in_home(std::path::Path::new(&home), ids)
}

fn chat_transcripts_exist_in_home(home: &std::path::Path, ids: Vec<String>) -> Vec<String> {
    let known = known_chat_transcript_ids(home);
    ids.into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && known.contains(id))
        .collect()
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
        let text_acc = display_claude_turn_text(role, &text_acc);
        if !text_acc.is_empty() {
            turns.push(ChatTurn {
                role: role.to_string(),
                text: text_acc,
            });
        }
    }
    turns
}

fn display_claude_turn_text(role: &str, text: &str) -> String {
    let mut out = text.trim().to_string();
    if role == "user" {
        out = strip_aios_context_capsule(&out);
        out = strip_aios_micro_context(&out);
        out = strip_channel_message_header(&out);
    }
    out.trim().to_string()
}

fn clean_chat_resume_text(text: &str) -> String {
    let mut out = text.trim().replace('\n', " ");
    out = strip_aios_context_capsule(&out);
    out = strip_aios_micro_context(&out);
    out = strip_channel_message_header(&out);
    out.replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_aios_context_capsule(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with("<aios_context>") {
        return trimmed.to_string();
    }
    trimmed
        .find("</aios_context>")
        .map(|idx| trimmed[idx + "</aios_context>".len()..].trim().to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

fn strip_aios_micro_context(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with("── AIOS MICRO-CONTEXT") {
        return trimmed.to_string();
    }
    trimmed
        .find("\n────")
        .map(|idx| trimmed[idx + "\n────".len()..].trim().to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

fn strip_channel_message_header(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with('[') {
        return trimmed.to_string();
    }
    let Some(end) = trimmed.find("]\n") else {
        return trimmed.to_string();
    };
    let header = &trimmed[1..end];
    if header.contains(" from ") {
        trimmed[end + 2..].trim().to_string()
    } else {
        trimmed.to_string()
    }
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

/// Finds a rollout in the user's normal Codex home first, then falls back to
/// the old ChatPane-specific Codex home used by fast mode.
fn find_codex_rollout_in_home(home: &std::path::Path, id: &str) -> Option<std::path::PathBuf> {
    [".codex/sessions", ".codex-chat/sessions"]
        .iter()
        .find_map(|rel| find_codex_rollout(&home.join(rel), id))
}

fn known_chat_transcript_ids(home: &std::path::Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    collect_claude_transcript_ids(home, &mut ids);
    for rel in [".codex/sessions", ".codex-chat/sessions"] {
        collect_codex_rollout_ids(&home.join(rel), &mut ids, 0);
    }
    ids
}

fn collect_claude_transcript_ids(home: &std::path::Path, out: &mut HashSet<String>) {
    let projects = home.join(".claude/projects");
    let Ok(dirs) = std::fs::read_dir(&projects) else {
        return;
    };
    for dir in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                out.insert(stem.to_string());
            }
        }
    }
}

fn collect_codex_rollout_ids(dir: &std::path::Path, out: &mut HashSet<String>, depth: u8) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_codex_rollout_ids(&path, out, depth + 1);
        } else if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                    out.insert(id_from_codex_rollout_stem(stem));
                }
            }
        }
    }
}

fn id_from_codex_rollout_stem(stem: &str) -> String {
    // rollout-2026-06-01t02-18-15-019e7f41-aaaa-bbbb
    // keep the entire thread id, not only the uuid suffix after its last dash.
    stem.find("-019")
        .map(|idx| stem[idx + 1..].to_string())
        .unwrap_or_else(|| stem.strip_prefix("rollout-").unwrap_or(stem).to_string())
}

fn find_claude_transcript_in_home(home: &std::path::Path, id: &str) -> Option<std::path::PathBuf> {
    if id.trim().is_empty() {
        return None;
    }
    let projects = home.join(".claude/projects");
    let Ok(dirs) = std::fs::read_dir(&projects) else {
        return None;
    };
    for dir in dirs.flatten() {
        let cand = dir.path().join(format!("{id}.jsonl"));
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

fn validate_claude_resume_in_home(
    home: &std::path::Path,
    resume: Option<String>,
) -> (Option<String>, Option<String>) {
    let Some(id) = resume.filter(|s| !s.trim().is_empty()) else {
        return (None, None);
    };
    if find_claude_transcript_in_home(home, &id).is_some() {
        (Some(id), None)
    } else {
        (None, Some(id))
    }
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
        adapt_codex_appserver_frame, buffer_push, chat_transcripts_exist_in_home,
        codex_config_without_mcp_servers, find_claude_transcript_in_home, find_codex_rollout_in_home,
        infer_session_engine, parse_claude_transcript, slim_user_image_line,
        validate_claude_resume_in_home, ChatSession, Engine,
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
            events: Box::new(aios_chat_core::NoopEvents),
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
    fn finds_normal_codex_rollout_before_chatpane_fast_home() {
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

        assert_eq!(find_codex_rollout_in_home(&root, id), Some(normal_file));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn falls_back_to_chatpane_fast_home_for_older_rollouts() {
        let root =
            std::env::temp_dir().join(format!("aios-normal-rollout-test-{}", std::process::id()));
        let chat = root.join(".codex-chat/sessions/2026/06/01");
        std::fs::create_dir_all(&chat).unwrap();
        let id = "019e-old-thread";
        let chat_file = chat.join(format!("rollout-chat-{id}.jsonl"));
        std::fs::write(&chat_file, "").unwrap();

        assert_eq!(find_codex_rollout_in_home(&root, id), Some(chat_file));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn transcript_existence_uses_filenames_not_mentions_inside_rollouts() {
        let root = std::env::temp_dir().join(format!(
            "aios-transcript-exists-test-{}",
            std::process::id()
        ));
        let normal = root.join(".codex/sessions/2026/06/20");
        std::fs::create_dir_all(&normal).unwrap();
        let real_id = "019ee0ab-326f-7dd2-9568-4b36dd17f8d3";
        let pasted_stale_id = "019ee09d-bef8-7173-bbd2-99076b7537ea";
        let rollout = normal.join(format!("rollout-2026-06-20T00-16-16-{real_id}.jsonl"));
        std::fs::write(
            &rollout,
            format!(
                r#"{{"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"stale codex resume id {pasted_stale_id}"}}]}}}}"#
            ),
        )
        .unwrap();

        let valid = chat_transcripts_exist_in_home(
            &root,
            vec![real_id.to_string(), pasted_stale_id.to_string()],
        );

        assert_eq!(valid, vec![real_id.to_string()]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn finds_claude_transcript_before_resuming() {
        let root = std::env::temp_dir().join(format!(
            "aios-claude-transcript-test-{}",
            std::process::id()
        ));
        let project = root.join(".claude/projects/-Users-firazfhansurie");
        std::fs::create_dir_all(&project).unwrap();
        let id = "019ee0e5-a016-7b43-a0db-8a29ca2d35eb";
        let transcript = project.join(format!("{id}.jsonl"));
        std::fs::write(
            &transcript,
            r#"{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}"#,
        )
        .unwrap();

        assert_eq!(find_claude_transcript_in_home(&root, id), Some(transcript));
        assert_eq!(find_claude_transcript_in_home(&root, "missing"), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_claude_resume_id_is_dropped_before_spawn() {
        let root =
            std::env::temp_dir().join(format!("aios-claude-resume-test-{}", std::process::id()));
        let project = root.join(".claude/projects/-Users-firazfhansurie");
        std::fs::create_dir_all(&project).unwrap();
        let id = "existing-claude-session";
        std::fs::write(project.join(format!("{id}.jsonl")), "").unwrap();

        assert_eq!(
            validate_claude_resume_in_home(&root, Some(id.to_string())),
            (Some(id.to_string()), None)
        );
        assert_eq!(
            validate_claude_resume_in_home(&root, Some("missing".to_string())),
            (None, Some("missing".to_string()))
        );
        assert_eq!(validate_claude_resume_in_home(&root, None), (None, None));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn claude_transcript_repaints_bridge_message_without_transport_context() {
        let transcript = r#"{"type":"queue-operation","operation":"enqueue","content":"ignored"}
{"type":"user","message":{"role":"user","content":"\n── AIOS MICRO-CONTEXT ──\ntime: 2026-06-19 13:08 UTC (Fri)\n\nrecent cross-tool activity...\n────\n\n\n[discord from ferazfhansurie 21:08]\nyo"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"yo. what's up."}]}}"#;

        let turns = parse_claude_transcript(transcript);

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, "user");
        assert_eq!(turns[0].text, "yo");
        assert_eq!(turns[1].role, "assistant");
        assert_eq!(turns[1].text, "yo. what's up.");
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

    // ---- per-token IPC coalescing ----

    fn text_delta_line(text: &str) -> String {
        json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": text }
            }
        })
        .to_string()
    }

    #[test]
    fn coalescible_detects_text_delta() {
        let line = text_delta_line("hel");
        let got = super::coalescible_delta(&line);
        assert!(got.is_some(), "text_delta should be coalescible");
        let (kind, _) = got.unwrap();
        assert_eq!(kind, "text_delta");
    }

    #[test]
    fn coalescible_ignores_non_delta_lines() {
        // A result / assistant / tool_use line must NOT be coalesced.
        assert!(super::coalescible_delta(r#"{"type":"result","subtype":"success"}"#).is_none());
        assert!(super::coalescible_delta(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#
        )
        .is_none());
        // A line that merely echoes "text_delta" inside model text must not parse
        // as a real stream_event delta.
        assert!(super::coalescible_delta(
            r#"{"type":"result","text":"the token type is text_delta"}"#
        )
        .is_none());
    }

    #[test]
    fn render_run_concatenates_text_shape_identical() {
        // Two deltas of the same kind merge into ONE stream_event carrying the
        // concatenated text, with the index + nesting preserved.
        let (_, template) = super::coalescible_delta(&text_delta_line("hel")).unwrap();
        let run = super::PendingRun {
            kind: "text_delta",
            template,
            text: "hello".to_string(),
        };
        let out = super::render_run(&run).expect("render");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["type"], "stream_event");
        assert_eq!(v["event"]["type"], "content_block_delta");
        assert_eq!(v["event"]["index"], 0);
        assert_eq!(v["event"]["delta"]["type"], "text_delta");
        assert_eq!(v["event"]["delta"]["text"], "hello");
    }

    #[test]
    fn delta_fragment_reads_text_and_thinking() {
        let (_, v) = super::coalescible_delta(&text_delta_line("abc")).unwrap();
        assert_eq!(super::delta_fragment(&v, "text_delta"), "abc");
        let think = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "thinking_delta", "thinking": "hmm" }
            }
        });
        assert_eq!(super::delta_fragment(&think, "thinking_delta"), "hmm");
    }
}
