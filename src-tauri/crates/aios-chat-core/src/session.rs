//! The engine-agnostic chat session: state + the replay ring buffer + sink
//! fan-out. This is the runtime heart shared by the Tauri shell (laptop) and the
//! headless `aios-noded` daemon (box) — neither the struct nor the fan-out names
//! Tauri; output leaves only through the [`OutputSink`] seam.
//!
//! Fields are `pub` because the session's lifecycle (spawn, per-turn send,
//! interrupt, detach/reattach) and the line-ingest orchestration still live in
//! the host (`chat.rs` on the laptop) and read/mutate this state directly. As the
//! extraction continues those orchestrators move in here too; for now the struct
//! is a shared data carrier with the buffer/fan-out primitives attached.

use std::collections::{HashMap, VecDeque};
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;

use crate::{Engine, OutputSink, SessionEvents};

/// How many raw output lines a detached session keeps for replay on reattach.
/// Generous enough to reconstruct a long agentic run; oldest lines drop first.
pub const REPLAY_CAP: usize = 6000;

/// Approximate BYTE budget for the replay buffer, evicted alongside `REPLAY_CAP`.
/// A line-count cap alone can't bound memory: one huge line (a big tool output,
/// or a base64 image if the slimming path is ever bypassed) counts as 1 line yet
/// holds many MB. We sum line lengths and evict oldest until under BOTH caps.
/// 12 MB is generous for a long agentic transcript while still capping a runaway.
pub const REPLAY_BYTE_CAP: usize = 12 * 1024 * 1024;

/// A turn-scoped Codex control request that arrived after `turn/start` was sent
/// but before the app-server published `turn/started` (the first point at which
/// its required turn id is known). The adapter drains these in order as soon as
/// that notification lands. An interrupt supersedes any queued steers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PendingCodexControl {
    Steer(String),
    Interrupt,
}

/// One live chat session. For `claude` this is a persistent child + its stdin
/// (turns are pushed as stream-json lines). For `codex`/`opencode` there is no
/// persistent process: `child` holds the CURRENT turn's subprocess (so an
/// interrupt can kill it) and `thread_id` is the resume handle for the next turn.
/// The reader thread forwards through the swappable `sink` and always appends to
/// `buffer`, so the session keeps running (and buffering) after a pane closes.
pub struct ChatSession {
    /// This session's own numeric id (the key in the sessions map), copied in so
    /// `ingest_line` can name the session when emitting the `aios-notify` event.
    pub id: u32,
    /// Which CLI backend this session drives.
    pub engine: Engine,
    /// claude → the persistent process; codex/opencode → the in-flight turn's
    /// child (None when idle). Kept so an interrupt can kill the current turn.
    pub child: Mutex<Option<Child>>,
    /// claude's persistent stdin. `None` for spawn-per-turn engines.
    pub stdin: Mutex<Option<ChildStdin>>,
    /// Resume handle for spawn-per-turn engines (codex thread_id / opencode ses_).
    pub thread_id: Mutex<Option<String>>,
    /// Working dir, captured for per-turn re-spawns.
    pub cwd: Mutex<Option<String>>,
    /// Model id, captured for per-turn re-spawns (e.g. `gpt-5.5`, `opencode/...`).
    pub model: Mutex<Option<String>>,
    /// Reasoning effort the composer picked (`low|medium|high|xhigh|max|ultra`),
    /// kept so codex `turn/start` can carry it every turn. The AIOS-only
    /// `ultracode` workflow preset is resolved before this boundary. Claude
    /// passes effort at spawn; `None` = engine default.
    pub effort: Mutex<Option<String>>,
    /// Current output sink; `None` while detached (output only buffers). Boxed
    /// behind [`OutputSink`] so the same session runtime can forward to a Tauri
    /// `Channel` (laptop) or a WebSocket (`aios-noded` on the box) unchanged.
    pub sink: Mutex<Option<Box<dyn OutputSink>>>,
    /// Side-channel lifecycle events (process exit, turn-done notify). On the
    /// Tauri shell this wraps `AppHandle::emit` (+ a native toast); on
    /// `aios-noded` it updates the registry / pushes over the tailnet. Set once
    /// at construction — the last Tauri coupling the session runtime carried.
    pub events: Box<dyn SessionEvents>,
    /// Ring buffer of recent raw lines, replayed verbatim on reattach.
    pub buffer: Mutex<VecDeque<String>>,
    /// Approximate total bytes currently held in `buffer` (sum of line lengths).
    /// Tracked so a BYTE budget (REPLAY_BYTE_CAP) can evict oldest lines even when
    /// the line COUNT is far under REPLAY_CAP — one huge line must not pin MBs.
    pub buffer_bytes: AtomicUsize,
    /// claude's own session uuid (from the init event) — used to match a
    /// reopened pane back to this live process.
    pub claude_id: Mutex<Option<String>>,
    /// Human label for the tray + notification.
    pub title: Mutex<String>,
    /// True while a turn is in flight (set on send, cleared on `result`).
    pub busy: AtomicBool,
    /// Serializes turn-changing operations (send / steer / interrupt) for this
    /// session. Without it, an old steer can validate then inject after a result
    /// freed the session and a newer run started.
    pub operation_lock: Mutex<()>,
    /// True once the pane closed but we kept the process alive.
    pub detached: AtomicBool,
    /// Fire an OS notification when the current/next turn completes.
    pub notify_on_done: AtomicBool,
    /// codex app-server: monotonic JSON-RPC request id for this session.
    pub rpc_id: AtomicU64,
    /// codex app-server: a turn's text queued until `thread/start` resolves the
    /// threadId (the first turn races the handshake). Fired once the id lands.
    pub pending_turn: Mutex<Option<(String, Vec<String>)>>,
    /// codex app-server: the in-flight turn's id (from `turn/started`), needed as
    /// `expectedTurnId` to steer it. `None` between turns. Cleared on turn end.
    pub active_turn: Mutex<Option<String>>,
    /// Codex controls received during the narrow `turn/start` → `turn/started`
    /// window, when the session is busy but the required turn id is not known.
    pub pending_controls: Mutex<VecDeque<PendingCodexControl>>,
    /// codex app-server: the item id of the turn's REAL answer (the agentMessage
    /// whose `phase` is `final_answer`). Codex also emits preamble/status agent
    /// messages mid-turn; we route THOSE to the thinking block so only the final
    /// answer renders as the reply (not an identical-looking text bubble).
    pub answer_item: Mutex<Option<String>>,
    /// codex app-server: true once the current answer item has streamed at least
    /// one `text_delta`. When true, `item/completed` MUST suppress its full
    /// `assistant_text_line` (the stream already rendered it — emitting it too
    /// would double-render the answer). False (a short answer that never
    /// streamed deltas) → emit the full line so the answer isn't dropped. Reset
    /// per turn (`turn/started`) and when the answer item id changes.
    pub answer_streamed: AtomicBool,
    /// codex app-server: maps a synthetic approval `request_id` (the string we
    /// put in the frontend's `can_use_tool` control_request) → the codex
    /// JSON-RPC request id we must answer. In `on-request` approval mode codex
    /// sends a server→client request (`exec_command_approval` /
    /// `apply_patch_approval`); we surface it as the SAME ApprovalCard claude
    /// uses and, on the user's decision, reply over JSON-RPC with the mapped id.
    pub pending_approvals: Mutex<HashMap<String, Value>>,
}

impl ChatSession {
    /// Builds a freshly-spawned session from the parts a host must supply (id,
    /// engine, the child + its stdin, the output sink, and the lifecycle events
    /// impl); every other field gets its idle/empty default. Lets the `aios-noded`
    /// daemon construct a session without re-stating the 20-field literal that
    /// `chat.rs` carries — same defaults, one place. `child`/`stdin` are `Option`
    /// so a spawn-per-turn engine (codex/opencode) can pass `None` until a turn.
    #[allow(clippy::too_many_arguments)]
    pub fn spawned(
        id: u32,
        engine: Engine,
        child: Option<Child>,
        stdin: Option<ChildStdin>,
        sink: Box<dyn OutputSink>,
        events: Box<dyn SessionEvents>,
    ) -> Self {
        ChatSession {
            id,
            engine,
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            thread_id: Mutex::new(None),
            cwd: Mutex::new(None),
            model: Mutex::new(None),
            effort: Mutex::new(None),
            sink: Mutex::new(Some(sink)),
            buffer: Mutex::new(VecDeque::with_capacity(256)),
            buffer_bytes: AtomicUsize::new(0),
            claude_id: Mutex::new(None),
            title: Mutex::new(String::new()),
            busy: AtomicBool::new(false),
            operation_lock: Mutex::new(()),
            detached: AtomicBool::new(false),
            notify_on_done: AtomicBool::new(false),
            rpc_id: AtomicU64::new(1),
            pending_turn: Mutex::new(None),
            active_turn: Mutex::new(None),
            pending_controls: Mutex::new(VecDeque::new()),
            answer_item: Mutex::new(None),
            answer_streamed: AtomicBool::new(false),
            pending_approvals: Mutex::new(HashMap::new()),
            events,
        }
    }
}

/// Appends one line to the replay ring buffer, evicting oldest lines while over
/// EITHER the line-count or byte budget. Always keeps at least the incoming line
/// even if it alone exceeds the byte budget (so the turn isn't lost entirely).
pub fn buffer_push(sess: &Arc<ChatSession>, line: &str) {
    let mut b = sess.buffer.lock();
    let incoming = line.len();
    while !b.is_empty()
        && (b.len() >= REPLAY_CAP
            || sess.buffer_bytes.load(Ordering::Relaxed) + incoming > REPLAY_BYTE_CAP)
    {
        if let Some(old) = b.pop_front() {
            sess.buffer_bytes.fetch_sub(old.len(), Ordering::Relaxed);
        }
    }
    b.push_back(line.to_string());
    sess.buffer_bytes.fetch_add(incoming, Ordering::Relaxed);
}

/// Appends one line to the replay buffer AND forwards it to the live sink (if a
/// pane is attached). The low-level fan-out shared by `ingest_line` and by
/// synthetic lines we inject (e.g. the live `usage` tick after a turn).
pub fn fan_out(sess: &Arc<ChatSession>, line: &str) {
    buffer_push(sess, line);
    if let Some(ch) = sess.sink.lock().as_ref() {
        ch.send(line);
    }
}

/// Like `fan_out` but stores a DIFFERENT (slimmed) copy in the replay buffer than
/// the one sent live. Used for image-bearing user lines: the LIVE sink gets the
/// real line (claude needs the base64 this turn) while the buffer keeps only a
/// lightweight placeholder, so a pasted screenshot isn't retained in RAM for the
/// whole session and re-sent on every reattach/replay.
pub fn fan_out_split(sess: &Arc<ChatSession>, live: &str, buffered: &str) {
    buffer_push(sess, buffered);
    if let Some(ch) = sess.sink.lock().as_ref() {
        ch.send(live);
    }
}
