//! Session manager for the box daemon. Spawns chat sessions locally (today:
//! claude, the persistent stream-json engine) and fans their output to any number
//! of attached Mac panes via a tokio broadcast channel. The session state +
//! replay ring buffer are the SAME `aios-chat-core::ChatSession` the laptop uses;
//! only the `OutputSink` differs — here it's a broadcast sender, there a Tauri
//! Channel. "Open the pane in both" is just two WS subscribers on one broadcast.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use aios_chat_core::session::{buffer_push, fan_out, ChatSession};
use aios_chat_core::wire::{json_escape, user_line};
use aios_chat_core::{Engine, NoopEvents, OutputSink};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::broadcast;

/// Broadcast fan-out sink: every adapted output line is pushed to all attached
/// WS receivers. Lossy on no-receivers (matches the `OutputSink` contract — a
/// detached session must keep running + buffering, never wedge on a dead pane).
struct BroadcastSink(broadcast::Sender<String>);

impl OutputSink for BroadcastSink {
    fn send(&self, line: &str) {
        // Err just means no live subscribers right now; the ring buffer still has
        // it for the next attach. Drop silently.
        let _ = self.0.send(line.to_string());
    }
}

/// One session running on this node: the shared chat state, the live broadcast
/// handle (subscribe to attach), and a little metadata for `/registry`.
pub struct NodeSession {
    pub sess: Arc<ChatSession>,
    pub tx: broadcast::Sender<String>,
    pub engine: Engine,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub started_unix: u64,
}

/// What `/registry` reports per session — enough for the Mac roster to list box
/// sessions and offer "attach".
#[derive(Serialize, Clone)]
pub struct RegistryEntry {
    pub id: u32,
    pub engine: String,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub started_unix: u64,
    pub busy: bool,
    pub attached: usize,
    pub buffered_lines: usize,
}

#[derive(Default)]
pub struct Manager {
    sessions: Mutex<HashMap<u32, Arc<NodeSession>>>,
    next_id: AtomicU32,
}

/// How many lines the live broadcast holds for a slow subscriber before it lags
/// (separate from the session's own replay ring buffer, which is the source of
/// truth on attach). Generous so a briefly-stalled WS doesn't drop tokens.
const BROADCAST_CAP: usize = 4096;

impl Manager {
    pub fn new() -> Self {
        Manager {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }

    /// Snapshot of all live sessions for `/registry`.
    pub fn registry(&self) -> Vec<RegistryEntry> {
        let map = self.sessions.lock();
        let mut out: Vec<RegistryEntry> = map
            .values()
            .map(|ns| RegistryEntry {
                id: ns.sess.id,
                engine: format!("{:?}", ns.engine).to_lowercase(),
                cwd: ns.cwd.clone(),
                model: ns.model.clone(),
                started_unix: ns.started_unix,
                busy: ns.sess.busy.load(Ordering::SeqCst),
                attached: ns.tx.receiver_count(),
                buffered_lines: ns.sess.buffer.lock().len(),
            })
            .collect();
        out.sort_by_key(|e| e.id);
        out
    }

    pub fn get(&self, id: u32) -> Option<Arc<NodeSession>> {
        self.sessions.lock().get(&id).cloned()
    }

    /// Spawns a claude session on this node and registers it. Mirrors the laptop's
    /// claude spawn (stream-json in/out, partial messages) so the wire format the
    /// Mac pane consumes is byte-identical — the pane can't tell box from local.
    pub fn start_claude(
        &self,
        cwd: Option<String>,
        model: Option<String>,
        resume: Option<String>,
    ) -> Result<u32, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let bin = std::env::var("AIOS_CLAUDE_BIN")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "claude".to_string());

        let mut cmd = Command::new(&bin);
        cmd.arg("--print")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--include-partial-messages")
            .arg("--verbose");
        if let Some(r) = resume.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg("--resume").arg(r);
        }
        if let Some(m) = model.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg("--model").arg(m);
        }
        match cwd.as_deref() {
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
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn {bin}: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture claude stdin".to_string())?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture claude stdout".to_string())?;
        let stderr = child.stderr.take();

        let (tx, _rx) = broadcast::channel::<String>(BROADCAST_CAP);
        let sink: Box<dyn OutputSink> = Box::new(BroadcastSink(tx.clone()));
        let sess = Arc::new(ChatSession::spawned(
            id,
            Engine::Claude,
            Some(child),
            Some(stdin),
            sink,
            Box::new(NoopEvents),
        ));

        let started_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let node = Arc::new(NodeSession {
            sess: Arc::clone(&sess),
            tx: tx.clone(),
            engine: Engine::Claude,
            cwd: cwd.clone(),
            model: model.clone(),
            started_unix,
        });
        self.sessions.lock().insert(id, Arc::clone(&node));

        // stdout reader: blocking byte reads → whole UTF-8 lines → fan_out (which
        // appends to the replay ring buffer AND broadcasts to attached panes).
        // claude is passthrough — its stream-json IS the wire format, no adapter.
        let sess_rdr = Arc::clone(&sess);
        thread::spawn(move || {
            let mut pending: Vec<u8> = Vec::new();
            let mut line_buf = String::new();
            let mut buf = [0u8; 16384];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        // Split on the last valid UTF-8 boundary so a multi-byte
                        // char straddling a read isn't mangled.
                        let valid = match std::str::from_utf8(&pending) {
                            Ok(s) => s.len(),
                            Err(e) => e.valid_up_to(),
                        };
                        let text = String::from_utf8_lossy(&pending[..valid]).to_string();
                        pending.drain(..valid);
                        line_buf.push_str(&text);
                        while let Some(nl) = line_buf.find('\n') {
                            let line: String = line_buf.drain(..=nl).collect();
                            let trimmed = line.trim_end_matches(['\n', '\r']);
                            if !trimmed.is_empty() {
                                fan_out(&sess_rdr, trimmed);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            let tail = line_buf.trim_end_matches(['\n', '\r']);
            if !tail.is_empty() {
                fan_out(&sess_rdr, tail);
            }
            // Synthesize a terminal exit line so an attached pane clears its
            // streaming cursor when the process dies without a final result.
            if sess_rdr.busy.swap(false, Ordering::SeqCst) {
                let cid = sess_rdr.claude_id.lock().clone().unwrap_or_default();
                fan_out(
                    &sess_rdr,
                    &format!(
                        "{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"text\":\"claude exited\",\"session_id\":\"{}\",\"total_cost_usd\":0}}",
                        json_escape(&cid)
                    ),
                );
            }
        });

        // stderr reader: surface as synthetic error events on the same stream so a
        // missing-binary / auth failure shows up in the pane instead of vanishing.
        if let Some(mut err) = stderr {
            let sess_err = Arc::clone(&sess);
            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                let mut acc = String::new();
                loop {
                    match err.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => acc.push_str(&String::from_utf8_lossy(&buf[..n])),
                        Err(_) => break,
                    }
                }
                let acc = acc.trim();
                if !acc.is_empty() {
                    buffer_push(
                        &sess_err,
                        &format!(
                            "{{\"type\":\"system\",\"subtype\":\"stderr\",\"text\":\"{}\"}}",
                            json_escape(acc)
                        ),
                    );
                }
            });
        }

        Ok(id)
    }

    /// Writes one user turn to a claude session's stdin (stream-json user line).
    pub fn send(&self, id: u32, text: &str) -> Result<(), String> {
        let node = self.get(id).ok_or("no such session")?;
        node.sess.busy.store(true, Ordering::SeqCst);
        let line = format!("{}\n", user_line(text));
        write_stdin(&node.sess, line.as_bytes())
    }

    /// Interrupts the in-flight turn (claude control_request, same shape the
    /// laptop uses). `NEXT_REQ` is the shared monotonic request-id counter.
    pub fn interrupt(&self, id: u32) -> Result<(), String> {
        let node = self.get(id).ok_or("no such session")?;
        let rid = aios_chat_core::codex_rpc::NEXT_REQ.fetch_add(1, Ordering::SeqCst);
        let line = format!(
            "{{\"type\":\"control_request\",\"request_id\":\"int-{rid}\",\"request\":{{\"subtype\":\"interrupt\"}}}}\n"
        );
        write_stdin(&node.sess, line.as_bytes())
    }

    /// Stops + removes a session: kill the child, drop it from the registry.
    pub fn stop(&self, id: u32) -> Result<(), String> {
        let node = self.sessions.lock().remove(&id).ok_or("no such session")?;
        if let Some(mut child) = node.sess.child.lock().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

fn write_stdin(sess: &Arc<ChatSession>, bytes: &[u8]) -> Result<(), String> {
    let mut guard = sess.stdin.lock();
    let stdin = guard.as_mut().ok_or("session has no stdin")?;
    stdin.write_all(bytes).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}
