//! `aios-chat-core` — the engine-agnostic heart of an AIOS chat session.
//!
//! This crate exists so the SAME chat runtime (engine adapters, the claude/codex
//! wire format, the session lifecycle) can back BOTH:
//!   - the Tauri shell on the laptop (output → a `tauri::ipc::Channel<String>`)
//!   - the headless `aios-noded` daemon on the bisnesgpt box (output → a WebSocket)
//!
//! The only things that differ between those two hosts are (a) where output lines
//! go and (b) the side-channel events (process exit, OS notifications). Both are
//! abstracted behind the [`OutputSink`] and [`SessionEvents`] traits below, so the
//! core logic never names Tauri. The Tauri shell plugs in a `Channel`-backed sink;
//! `aios-noded` plugs in a WebSocket-backed sink. One core, zero duplicated logic.
//!
//! Extraction is incremental: `wire` (the dependency-free formatters + `Engine`)
//! lands first; the session struct, engine adapters, and lifecycle follow, each
//! moved behind the traits while keeping the shell compiling at every step.

pub mod wire;

pub use wire::Engine;

/// Where a session's output lines go. The reader thread calls [`OutputSink::send`]
/// for each adapted line. Implementations are cheap, non-blocking, and lossy on a
/// dead receiver (a closed pane / dropped socket must never wedge the reader).
///
/// - Tauri shell: wraps `tauri::ipc::Channel<String>`.
/// - `aios-noded`: wraps a per-connection WebSocket sender (broadcast to N
///   attached GUIs → "open the pane in both" is a fan-out of sinks).
pub trait OutputSink: Send + Sync {
    /// Forward one already-adapted output line (no trailing newline) to the host.
    fn send(&self, line: &str);
}

/// Side-channel session events that, on the Tauri shell, become `AppHandle::emit`
/// calls (the only other Tauri coupling besides the sink). On `aios-noded` these
/// map to registry/heartbeat updates and push notifications over the tailnet.
///
/// All methods default to no-ops so a host can implement only what it needs.
pub trait SessionEvents: Send + Sync {
    /// The backing process for `session_id` exited (today: shell emits `chat-exit`).
    fn on_exit(&self, _session_id: u32) {}
    /// A turn finished on a session whose pane wanted a completion ping
    /// (today: shell emits `aios-notify`).
    fn on_notify(&self, _session_id: u32, _title: &str) {}
}
