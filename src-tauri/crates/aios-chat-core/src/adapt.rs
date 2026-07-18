//! Engine adapters — the pure functions that map codex (`exec --json`) and
//! opencode (`run --format json`) JSONL into the claude-shaped wire lines the
//! frontend consumes, plus the codex value-extraction helpers and usage
//! normalizers they share.
//!
//! Everything here is PURE: it reads a `&Value` / `&Arc<ChatSession>` and returns
//! `Vec<String>` / `Value` / `String`. No process I/O, no Tauri, no module
//! statics. That's why it lives in the shared crate — `aios-noded` on the box
//! adapts engine output with the exact same code the laptop shell uses.
//!
//! NOT here (stays host-side in `chat.rs`): `adapt_codex_appserver_frame` (writes
//! JSON-RPC to stdin + uses the `NEXT_REQ` static) and the `adapt_line` dispatcher
//! (routes to that frame adapter). Those call into the helpers below via `use`.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::session::ChatSession;
use crate::wire::{
    assistant_text_line, assistant_thinking_line, assistant_tool_use_line, json_escape,
    user_tool_result_line,
};

/// Builds the codex `turn/start` input array: any attached local images as
/// `localImage` items first, then the text item. Mirrors the claude image path.
pub fn codex_input_items(text: &str, image_paths: &[String]) -> serde_json::Value {
    let mut items: Vec<serde_json::Value> = image_paths
        .iter()
        .map(|p| json!({ "type": "localImage", "path": p }))
        .collect();
    items.push(json!({ "type": "text", "text": text }));
    json!(items)
}

/// Validates the composer's effort id against current Codex model tiers.
/// `max` and `ultra` are real app-server values for the 5.6 model family;
/// `ultracode` remains an AIOS workflow preset and must never cross the wire.
pub fn codex_effort(raw: &str) -> Option<&'static str> {
    match raw {
        "none" => Some("none"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        "ultra" => Some("ultra"),
        _ => None,
    }
}

pub fn codex_item_id(item: &Value) -> String {
    item.get("id")
        .and_then(|x| x.as_str())
        .or_else(|| item.get("call_id").and_then(|x| x.as_str()))
        .or_else(|| item.get("callId").and_then(|x| x.as_str()))
        .unwrap_or("codex-action")
        .to_string()
}

pub fn codex_agent_message_method(method: &str) -> bool {
    method.contains("agentMessage") || method.contains("agent_message")
}

pub fn codex_delta_item_id(params: Option<&Value>) -> Option<&str> {
    params
        .and_then(|p| p.get("itemId"))
        .and_then(|x| x.as_str())
        .or_else(|| {
            params
                .and_then(|p| p.get("item_id"))
                .and_then(|x| x.as_str())
        })
        .or_else(|| params.and_then(|p| p.get("id")).and_then(|x| x.as_str()))
        .or_else(|| {
            params
                .and_then(|p| p.get("item"))
                .and_then(|i| i.get("id"))
                .and_then(|x| x.as_str())
        })
}

pub fn codex_delta_phase(params: Option<&Value>) -> Option<&str> {
    params
        .and_then(|p| p.get("phase"))
        .and_then(|x| x.as_str())
        .or_else(|| {
            params
                .and_then(|p| p.get("item"))
                .and_then(|i| i.get("phase"))
                .and_then(|x| x.as_str())
        })
}

pub fn codex_delta_is_answer(
    sess: &Arc<ChatSession>,
    method: &str,
    params: Option<&Value>,
) -> bool {
    if method.contains("reasoning")
        || matches!(
            codex_delta_phase(params),
            Some("preamble" | "status" | "reasoning")
        )
    {
        return false;
    }
    if !codex_agent_message_method(method) {
        return false;
    }
    let item_id = codex_delta_item_id(params);
    let answer_item = sess.answer_item.lock().clone();
    if let (Some(done), Some(tracked)) = (item_id, answer_item.as_deref()) {
        return done == tracked;
    }
    item_id.is_none() || matches!(codex_delta_phase(params), Some("final_answer"))
}

pub fn codex_item_type(item: &Value) -> &str {
    item.get("type").and_then(|x| x.as_str()).unwrap_or("")
}

pub fn codex_is_action_item(item: &Value) -> bool {
    !matches!(
        codex_item_type(item),
        "" | "userMessage" | "user_message" | "agentMessage" | "agent_message" | "reasoning"
    )
}

pub fn codex_tool_name(item: &Value) -> String {
    if let Some(name) = item.get("name").and_then(|x| x.as_str()) {
        return name.to_string();
    }
    match codex_item_type(item) {
        "commandExecution" | "command_execution" | "exec" | "command" => "bash",
        "fileChange" | "file_change" | "patch" | "apply_patch" => "edit",
        "webSearch" | "web_search" => "websearch",
        "mcpToolCall" | "mcp_tool_call" => "mcp",
        other if !other.is_empty() => other,
        _ => "codex_action",
    }
    .to_string()
}

pub fn codex_tool_input(item: &Value) -> Value {
    if let Some(args) = item.get("arguments").or_else(|| item.get("args")) {
        if let Some(s) = args.as_str() {
            return serde_json::from_str::<Value>(s).unwrap_or_else(|_| json!({ "arguments": s }));
        }
        return args.clone();
    }
    let mut out = serde_json::Map::new();
    for key in [
        "command",
        "cmd",
        "cwd",
        "path",
        "file",
        "query",
        "url",
        "server",
        "tool",
        "status",
        "description",
    ] {
        if let Some(v) = item.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    if out.is_empty() {
        item.clone()
    } else {
        Value::Object(out)
    }
}

pub fn codex_tool_result_text(item: &Value) -> String {
    for key in ["output", "result", "content", "text", "error", "message"] {
        if let Some(v) = item.get(key) {
            if let Some(s) = v.as_str() {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
            if !v.is_null() {
                return v.to_string();
            }
        }
    }
    item.get("status")
        .and_then(|x| x.as_str())
        .unwrap_or("completed")
        .to_string()
}

pub fn codex_item_is_error(item: &Value) -> bool {
    item.get("is_error")
        .or_else(|| item.get("isError"))
        .and_then(|x| x.as_bool())
        .unwrap_or_else(|| {
            item.get("status")
                .and_then(|x| x.as_str())
                .map(|s| matches!(s, "failed" | "error" | "cancelled"))
                .unwrap_or(false)
        })
}

/// Maps Codex `exec --json` JSONL → claude-shaped event lines.
/// `thread.started{thread_id}` → capture resume id + real `system/init`;
/// `item.completed{agent_message|reasoning}` → assistant text/thinking;
/// `turn.completed{usage}` → `result`; `turn.failed`/`error` → error result.
pub fn adapt_codex_line(sess: &Arc<ChatSession>, line: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let mut out = Vec::new();
    match t {
        "thread.started" => {
            if let Some(tid) = v.get("thread_id").and_then(|x| x.as_str()) {
                let mut g = sess.thread_id.lock();
                let fresh = g.as_deref() != Some(tid);
                *g = Some(tid.to_string());
                drop(g);
                if fresh {
                    out.push(format!(
                        "{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{}\"}}",
                        json_escape(tid)
                    ));
                }
            }
        }
        "item.completed" => {
            if let Some(item) = v.get("item") {
                let itype = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
                let txt = item
                    .get("text")
                    .and_then(|x| x.as_str())
                    .or_else(|| item.get("content").and_then(|x| x.as_str()))
                    .unwrap_or("");
                match itype {
                    "agent_message" if !txt.is_empty() => out.push(assistant_text_line(txt)),
                    "reasoning" if !txt.is_empty() => out.push(assistant_thinking_line(txt)),
                    _ if codex_is_action_item(item) => {
                        let id = codex_item_id(item);
                        out.push(assistant_tool_use_line(
                            &id,
                            &codex_tool_name(item),
                            codex_tool_input(item),
                        ));
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
        "turn.completed" => {
            let tid = sess.thread_id.lock().clone().unwrap_or_default();
            let usage = codex_usage_to_claude(v.get("usage"));
            out.push(format!(
                "{{\"type\":\"result\",\"subtype\":\"success\",\"session_id\":\"{}\",\"usage\":{usage},\"total_cost_usd\":0}}",
                json_escape(&tid)
            ));
        }
        "turn.failed" | "error" => {
            let tid = sess.thread_id.lock().clone().unwrap_or_default();
            out.push(format!(
                "{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"session_id\":\"{}\",\"total_cost_usd\":0}}",
                json_escape(&tid)
            ));
        }
        _ => {}
    }
    out
}

/// Maps opencode `run --format json` JSONL → claude-shaped event lines.
/// First `sessionID` (`ses_…`) → resume id + real `system/init`; `text` parts →
/// assistant text; `reasoning` parts → thinking. Turn-end is handled by the EOF
/// fallback in `run_per_turn` (opencode just exits when the run completes).
pub fn adapt_opencode_line(sess: &Arc<ChatSession>, line: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(sid) = v.get("sessionID").and_then(|x| x.as_str()) {
        let mut g = sess.thread_id.lock();
        if g.is_none() {
            *g = Some(sid.to_string());
            drop(g);
            out.push(format!(
                "{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{}\"}}",
                json_escape(sid)
            ));
        }
    }
    let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let part_text = v
        .get("part")
        .and_then(|p| p.get("text"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    match t {
        "text" if !part_text.is_empty() => out.push(assistant_text_line(part_text)),
        "reasoning" if !part_text.is_empty() => out.push(assistant_thinking_line(part_text)),
        _ => {}
    }
    out
}

/// Builds a claude-shaped `usage` event line from a codex app-server rate-limits
/// object (primary = 5h, secondary = 7d), mirroring `claude_usage_event`'s shape.
pub fn codex_usage_event(rl: &serde_json::Value) -> String {
    // Field names verified live against codex 0.135's app-server push:
    //   params.rateLimits.{primary,secondary}.{usedPercent,resetsAt}
    // The logs_2.sqlite path uses snake_case (used_percent / reset_at); accept
    // both so this helper works for the push AND any sqlite-shaped caller.
    let win = |k: &str| -> serde_json::Value {
        let w = &rl[k];
        json!({
            "pct": w.get("usedPercent")
                .or_else(|| w.get("used_percent"))
                .and_then(|x| x.as_f64()),
            "resets_at": w.get("resetsAt")
                .or_else(|| w.get("reset_at"))
                .or_else(|| w.get("resetAt"))
                .and_then(|x| x.as_i64()),
        })
    };
    json!({
        "type": "usage",
        "provider": "codex",
        "five_hour": win("primary"),
        "seven_day": win("secondary"),
    })
    .to_string()
}

/// Normalizes a codex turn `usage` object into claude's usage field names so the
/// frontend's `tokensFromUsage` + ctx-pill math (which read `input_tokens`,
/// `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`)
/// populate for codex EXACTLY like claude. Codex emits `cached_input_tokens`
/// (claude's `cache_read_input_tokens`) and has no separate cache-creation
/// bucket; accepts both camelCase and snake_case shapes across codex versions.
/// Returns the literal JSON object string ready to splice into the result line.
pub fn codex_usage_to_claude(usage: Option<&serde_json::Value>) -> String {
    let Some(u) = usage else {
        return "{}".to_string();
    };
    let num = |keys: &[&str]| -> u64 {
        for k in keys {
            if let Some(n) = u.get(*k).and_then(|x| x.as_u64()) {
                return n;
            }
            if let Some(f) = u.get(*k).and_then(|x| x.as_f64()) {
                if f >= 0.0 {
                    return f as u64;
                }
            }
        }
        0
    };
    // codex `input_tokens` already INCLUDES the cached portion in recent
    // versions; claude's `input_tokens` is the non-cached remainder. Subtract so
    // the summed ctx total (input + cache_read + cache_creation) doesn't double
    // count. If input < cached (older shape where input excludes cache), keep
    // input as-is.
    let cache_read = num(&["cached_input_tokens", "cache_read_input_tokens"]);
    let input_raw = num(&["input_tokens", "prompt_tokens"]);
    let input = if input_raw >= cache_read {
        input_raw - cache_read
    } else {
        input_raw
    };
    let cache_create = num(&["cache_creation_input_tokens"]);
    let output = num(&["output_tokens", "completion_tokens"]);
    json!({
        "input_tokens": input,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_create,
        "output_tokens": output,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::codex_effort;

    #[test]
    fn codex_effort_preserves_current_model_tiers() {
        assert_eq!(codex_effort("max"), Some("max"));
        assert_eq!(codex_effort("ultra"), Some("ultra"));
        assert_eq!(codex_effort("ultracode"), None);
        assert_eq!(codex_effort("bogus"), None);
    }
}
