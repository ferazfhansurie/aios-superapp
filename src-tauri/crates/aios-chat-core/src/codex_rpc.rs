//! Codex app-server JSON-RPC: the write side (handshake/turn/steer/interrupt
//! replies) plus the frame adapter that maps codex's app-server protocol onto
//! claude's stream-json wire format. Lives in the crate (not `chat.rs`) because
//! the box daemon (`aios-noded`) runs codex sessions too and must adapt their
//! output identically before pushing it over the WebSocket sink.
//!
//! Nothing here names Tauri: it reads/mutates the shared [`ChatSession`] state
//! and writes back to the session's own stdin. The Tauri shell and the headless
//! box daemon call these the same way; only the [`crate::OutputSink`] differs.

use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::json;

use crate::adapt::{
    codex_delta_is_answer, codex_effort, codex_input_items, codex_is_action_item, codex_item_id,
    codex_item_is_error, codex_tool_input, codex_tool_name, codex_tool_result_text,
    codex_usage_event, codex_usage_to_claude,
};
use crate::session::{ChatSession, PendingCodexControl};
use crate::wire::{
    assistant_text_line, assistant_thinking_line, assistant_tool_use_line, json_escape,
    text_delta_line, thinking_delta_line, user_tool_result_line,
};

/// Monotonic counter for control_request `request_id`s (codex approval cards and
/// the claude interrupt/decision protocol). Shared: `chat.rs`'s claude interrupt
/// path imports this so the two protocols can't collide on a request id.
pub static NEXT_REQ: AtomicU64 = AtomicU64::new(1);

/// Writes one JSON-RPC value (newline-terminated) to a codex app-server session's
/// stdin — handshake, turns, interrupts, and server-request replies all go here.
pub fn codex_rpc_write(sess: &Arc<ChatSession>, val: &serde_json::Value) -> std::io::Result<()> {
    let mut line = val.to_string();
    line.push('\n');
    let mut stdin = sess.stdin.lock();
    let stdin = stdin.as_mut().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotConnected,
            "codex stdin is unavailable",
        )
    })?;
    stdin.write_all(line.as_bytes())?;
    stdin.flush()
}

/// Next JSON-RPC request id for this session.
pub fn codex_next_rpc(sess: &Arc<ChatSession>) -> u64 {
    sess.rpc_id.fetch_add(1, Ordering::SeqCst)
}

/// Builds a claude-shaped `result`/error line for a failed/stopped codex turn so
/// the composer frees and shows the error in the same envelope claude uses.
pub fn codex_error_result_line(sess: &Arc<ChatSession>, text: &str) -> String {
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
pub fn codex_fire_turn(
    sess: &Arc<ChatSession>,
    thread_id: &str,
    text: &str,
    image_paths: &[String],
) -> std::io::Result<()> {
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
    )
}

/// Sends a same-turn steer once the app-server's `turn/started` notification has
/// supplied the required active turn id.
pub fn codex_fire_steer(
    sess: &Arc<ChatSession>,
    thread_id: &str,
    turn_id: &str,
    text: &str,
) -> std::io::Result<()> {
    codex_fire_steer_attempt(sess, thread_id, turn_id, text, false)
}

/// The raw steer write. Registers the request id in `pending_steers` first so
/// the adapter can recognize the (async) response: on a stale-turn-id rejection
/// it resyncs from the error and retries once — `retried` marks that retry so a
/// second rejection re-queues instead of looping.
fn codex_fire_steer_attempt(
    sess: &Arc<ChatSession>,
    thread_id: &str,
    turn_id: &str,
    text: &str,
    retried: bool,
) -> std::io::Result<()> {
    let id = codex_next_rpc(sess);
    sess.pending_steers
        .lock()
        .insert(id, (text.to_string(), retried));
    if let Err(error) = codex_rpc_write(
        sess,
        &json!({
            "jsonrpc": "2.0", "id": id, "method": "turn/steer",
            "params": {
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": [{ "type": "text", "text": text }],
            }
        }),
    ) {
        sess.pending_steers.lock().remove(&id);
        return Err(error);
    }
    Ok(())
}

/// Parses the server's ACTUAL active turn id out of codex's steer rejection —
/// "expected active turn id `X` but found `Y`". Codex formats the error so the
/// client can resync and retry; its own TUI parses it exactly the same way.
fn steer_mismatch_actual(message: &str) -> Option<String> {
    let (_, rest) = message.split_once("but found `")?;
    let (actual, _) = rest.split_once('`')?;
    (!actual.is_empty()).then(|| actual.to_string())
}

/// Tells the frontend a steer could not be delivered into the live turn: the
/// pane drops its optimistic "steered" bubble, re-queues the text, and the
/// normal end-of-turn flush sends it as a fresh turn. Never a fatal `result`
/// line — the turn the steer bounced off is still running.
fn codex_steer_requeue_line(text: &str) -> String {
    format!(
        "{{\"type\":\"system\",\"subtype\":\"codex_steer_requeued\",\"text\":\"{}\"}}",
        json_escape(text)
    )
}

/// Sends a turn-scoped interrupt. Codex app-server v2 requires BOTH ids; sending
/// only `threadId` is rejected while the model keeps working.
pub fn codex_fire_interrupt(
    sess: &Arc<ChatSession>,
    thread_id: &str,
    turn_id: &str,
) -> std::io::Result<()> {
    let id = codex_next_rpc(sess);
    codex_rpc_write(
        sess,
        &json!({
            "jsonrpc": "2.0", "id": id, "method": "turn/interrupt",
            "params": { "threadId": thread_id, "turnId": turn_id }
        }),
    )
}

/// Adapts one codex app-server JSON-RPC frame to zero-or-more claude stream-json
/// lines. Also talks back to the session (acks server requests, fires queued
/// turns) via `codex_rpc_write` — so it is line→lines PLUS a stdin side-effect,
/// identical on the laptop and the box.
pub fn adapt_codex_appserver_frame(sess: &Arc<ChatSession>, line: &str) -> Vec<String> {
    adapt_codex_appserver_frame_before_emit(sess, line, || {})
}

/// Adapts a frame while guaranteeing that a `turn/started` id is committed
/// before the host publishes its renderer-facing `running` lifecycle event.
/// Hosts should put that publication in `before_emit`; all other frames simply
/// call it after their ordinary pre-adaptation state (which is a no-op today).
pub fn adapt_codex_appserver_frame_before_emit<F>(
    sess: &Arc<ChatSession>,
    line: &str,
    before_emit: F,
) -> Vec<String>
where
    F: FnOnce(),
{
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    // `turn/started` mutates active_turn then drains queued steer/interrupt
    // controls. Keep that state transition in the same operation boundary as
    // foreground send/steer/interrupt and result settlement, so a completed
    // turn cannot cross over a just-drained steer.
    let _operation = sess.operation_lock.lock();
    let method = v.get("method").and_then(|x| x.as_str());
    let has_id = v.get("id").is_some();
    let mut out = Vec::new();
    let turn_started_id = (method == Some("turn/started"))
        .then(|| {
            v.get("params")
                .and_then(|p| p.get("turn"))
                .and_then(|t| t.get("id"))
                .and_then(|x| x.as_str())
                .map(str::to_owned)
        })
        .flatten();
    if let Some(id) = turn_started_id {
        *sess.active_turn.lock() = Some(id);
    }
    before_emit();

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
            if let Err(error) =
                codex_rpc_write(sess, &json!({ "jsonrpc": "2.0", "id": idv, "result": {} }))
            {
                out.push(codex_error_result_line(sess, &error.to_string()));
            }
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
            // A rejected `turn/steer` must NOT tear down the still-running turn
            // (the old blanket cleanup below did exactly that: it cleared
            // active_turn and emitted a fatal result line, freeing the composer
            // while codex kept streaming — and every later steer then failed
            // with "no active turn"). Codex's own recovery protocol instead:
            // resync to the actual id it reports and retry the steer once.
            let steer = v
                .get("id")
                .and_then(|x| x.as_u64())
                .and_then(|id| sess.pending_steers.lock().remove(&id));
            if let Some((text, retried)) = steer {
                if !retried {
                    if let Some(actual) = steer_mismatch_actual(message) {
                        let tid = sess.thread_id.lock().clone().unwrap_or_default();
                        if !tid.is_empty() {
                            *sess.active_turn.lock() = Some(actual.clone());
                            if codex_fire_steer_attempt(sess, &tid, &actual, &text, true).is_ok() {
                                return out;
                            }
                        }
                    }
                }
                // Retry exhausted / turn not steerable (review, compact) / turn
                // already over → hand the text back to the frontend queue.
                out.push(codex_steer_requeue_line(&text));
                return out;
            }
            *sess.pending_turn.lock() = None;
            *sess.active_turn.lock() = None;
            sess.pending_controls.lock().clear();
            *sess.answer_item.lock() = None;
            sess.answer_streamed.store(false, Ordering::SeqCst);
            sess.pending_approvals.lock().clear();
            out.push(codex_error_result_line(sess, message));
            return out;
        }
        // A successful `turn/steer` response confirms the live turn id (codex
        // returns the turn it actually steered into) — resync so the NEXT steer
        // starts from the server's truth rather than a possibly stale cache.
        if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
            if sess.pending_steers.lock().remove(&id).is_some() {
                if let Some(turn_id) = v
                    .get("result")
                    .and_then(|r| r.get("turnId"))
                    .and_then(|x| x.as_str())
                {
                    *sess.active_turn.lock() = Some(turn_id.to_string());
                }
                return out;
            }
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
                if let Err(error) = codex_fire_turn(sess, tid, &text, &images) {
                    out.push(codex_error_result_line(sess, &error.to_string()));
                }
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
                let thread_id = params
                    .and_then(|p| p.get("threadId"))
                    .and_then(|x| x.as_str())
                    .map(str::to_owned)
                    .or_else(|| sess.thread_id.lock().clone())
                    .unwrap_or_default();
                let controls = sess.pending_controls.lock().drain(..).collect::<Vec<_>>();
                for control in controls {
                    match control {
                        PendingCodexControl::Steer(text) => {
                            if codex_fire_steer(sess, &thread_id, id, &text).is_err() {
                                out.push(codex_steer_requeue_line(&text));
                            }
                        }
                        PendingCodexControl::Interrupt => {
                            if let Err(error) = codex_fire_interrupt(sess, &thread_id, id) {
                                out.push(codex_error_result_line(sess, &error.to_string()));
                            }
                        }
                    }
                }
            }
        }
        "turn/completed" => {
            *sess.active_turn.lock() = None;
            // Steers still waiting on a turn id when the turn ended can never
            // fire — hand them back to the frontend queue (before the result
            // line, so they're re-queued by the time the flush effect runs)
            // instead of dropping them silently. `pending_steers` is
            // deliberately NOT drained here: codex answers every `turn/steer`
            // request, so an in-flight steer outliving its turn gets a late
            // "no active turn" error response, which the error path above
            // re-queues — draining it here too would double-deliver and send
            // that late response down the fatal cleanup path.
            for control in sess.pending_controls.lock().drain(..) {
                if let PendingCodexControl::Steer(text) = control {
                    out.push(codex_steer_requeue_line(&text));
                }
            }
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
            for control in sess.pending_controls.lock().drain(..) {
                if let PendingCodexControl::Steer(text) = control {
                    out.push(codex_steer_requeue_line(&text));
                }
            }
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
                let message = params
                    .and_then(|p| p.get("error"))
                    .and_then(|e| e.get("message"))
                    .and_then(|x| x.as_str())
                    .or_else(|| {
                        params
                            .and_then(|p| p.get("message"))
                            .and_then(|x| x.as_str())
                    })
                    .unwrap_or("codex turn failed");
                out.push(codex_error_result_line(sess, message));
            }
        }
        _ => {} // thread/started, item/started, deltas, mcp status — ignored in v1
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Engine, NoopEvents, OutputSink};
    use std::process::{Command, Stdio};

    struct NullSink;
    impl OutputSink for NullSink {
        fn send(&self, _: &str) {}
    }

    fn session() -> Arc<ChatSession> {
        Arc::new(ChatSession::spawned(
            1,
            Engine::Codex,
            None,
            None,
            Box::new(NullSink),
            Box::new(NoopEvents),
        ))
    }

    #[test]
    fn rpc_write_reports_missing_stdin() {
        let error = codex_rpc_write(&session(), &json!({"method":"turn/start"}))
            .expect_err("a missing transport must not look accepted");
        assert!(error.to_string().contains("stdin"), "{error}");
    }

    #[test]
    fn rpc_write_propagates_broken_pipe() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("exit 0")
            .stdin(Stdio::piped())
            .spawn()
            .expect("spawn closed reader");
        let stdin = child.stdin.take().expect("stdin");
        child.wait().expect("exit");
        let sess = session();
        *sess.stdin.lock() = Some(stdin);
        let error = codex_rpc_write(&sess, &json!({"method":"turn/start"}))
            .expect_err("broken pipe must reach the caller");
        assert!(matches!(error.kind(), std::io::ErrorKind::BrokenPipe));
    }

    #[test]
    fn turn_started_state_is_visible_before_running_callback() {
        let sess = session();
        adapt_codex_appserver_frame_before_emit(
            &sess,
            r#"{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}"#,
            || assert_eq!(sess.active_turn.lock().as_deref(), Some("turn-1")),
        );
    }
}
