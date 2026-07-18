//! Dependency-free wire-format helpers + the [`Engine`] tag.
//!
//! Everything here is pure (str → String / Value), depends only on serde_json +
//! base64 + std, and is shared verbatim by the shell and `aios-noded`. These were
//! lifted out of the shell's `chat.rs` unchanged — the canonical claude
//! stream-json wire shape that every engine's events are normalized into.

use serde_json::{json, Value};

/// Which CLI backend drives a chat session. `claude` is a single PERSISTENT
/// process (stream-json on stdin). `codex` (ChatGPT-subscription) is ALSO
/// persistent — it drives the standalone **codex app-server** over newline
/// JSON-RPC. `opencode` (everything else, incl. openrouter + free models) is
/// spawn-per-turn. Each engine's event shape is normalized into claude's wire
/// shape (see the adapters in the shell's `chat.rs`) so the frontend is untouched.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Engine {
    Claude,
    Codex,
    Opencode,
}

impl Engine {
    pub fn parse(s: Option<&str>) -> Engine {
        match s {
            Some("codex") => Engine::Codex,
            Some("opencode") => Engine::Opencode,
            _ => Engine::Claude,
        }
    }
    /// True for spawn-per-turn engines (no persistent stdin process). Codex is
    /// NOT per-turn — it runs a persistent app-server.
    pub fn per_turn(self) -> bool {
        matches!(self, Engine::Opencode)
    }
}

pub fn json_escape(s: &str) -> String {
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
pub fn user_line(text: &str) -> String {
    format!(
        "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}\n",
        json_escape(text)
    )
}

/// Guesses an image media_type from a file path extension. Defaults to png —
/// claude rejects unknown types, and png is the most common clipboard format.
pub fn image_media_type(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

/// Builds a stream-json user line carrying REAL image content blocks (base64)
/// followed by the text block — so claude SEES the images natively every turn,
/// instead of being handed file paths it has to remember to `Read`. Any path
/// that fails to read is skipped (still send the text). Falls back to the
/// text-only `user_line` when nothing readable is attached.
pub fn user_line_with_images(text: &str, image_paths: &[String]) -> String {
    use base64::Engine as _;
    let mut content: Vec<serde_json::Value> = Vec::new();
    for path in image_paths {
        match std::fs::read(path) {
            Ok(bytes) => {
                let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                content.push(json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image_media_type(path),
                        "data": data,
                    }
                }));
            }
            Err(e) => eprintln!("chat: skipping unreadable image {path}: {e}"),
        }
    }
    if content.is_empty() {
        return user_line(text);
    }
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    let line = json!({
        "type": "user",
        "message": { "role": "user", "content": content }
    });
    format!("{line}\n")
}

/// Given a parsed `user` message line that may carry base64 `image` content
/// blocks, returns a SLIMMED replacement line safe to keep in the replay buffer:
/// image blocks are dropped (or replaced by a tiny `[image]` text note) so the
/// megabytes of base64 never persist in RAM or get re-sent on reattach. Returns
/// `None` when the line carries no image block (nothing to slim — keep it as-is).
pub fn slim_user_image_line(parsed: &Value) -> Option<String> {
    if parsed.get("type").and_then(|x| x.as_str()) != Some("user") {
        return None;
    }
    let content = parsed
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())?;
    let has_image = content
        .iter()
        .any(|b| b.get("type").and_then(|x| x.as_str()) == Some("image"));
    if !has_image {
        return None;
    }
    let mut slim: Vec<Value> = Vec::with_capacity(content.len());
    for b in content {
        match b.get("type").and_then(|x| x.as_str()) {
            Some("image") => slim.push(json!({ "type": "text", "text": "[image]" })),
            _ => slim.push(b.clone()),
        }
    }
    Some(json!({ "type": "user", "message": { "role": "user", "content": slim } }).to_string())
}

/// One claude-shaped streaming TEXT delta (a `content_block_delta`/`text_delta`),
/// so codex's `item/agentMessage/delta` tokens type out live exactly like claude's
/// partial-message stream — instead of the whole answer landing at once.
pub fn text_delta_line(tok: &str) -> String {
    format!(
        "{{\"type\":\"stream_event\",\"event\":{{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"{}\"}}}}}}",
        json_escape(tok)
    )
}

/// One claude-shaped streaming THINKING delta — codex's reasoning-summary tokens
/// stream into the collapsible thinking block as they arrive.
pub fn thinking_delta_line(tok: &str) -> String {
    format!(
        "{{\"type\":\"stream_event\",\"event\":{{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"thinking_delta\",\"thinking\":\"{}\"}}}}}}",
        json_escape(tok)
    )
}

/// One claude-shaped assistant text line.
pub fn assistant_text_line(text: &str) -> String {
    format!(
        "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}",
        json_escape(text)
    )
}

/// One claude-shaped assistant thinking line.
pub fn assistant_thinking_line(text: &str) -> String {
    format!(
        "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"thinking\",\"thinking\":\"{}\"}}]}}}}",
        json_escape(text)
    )
}

pub fn assistant_tool_use_line(id: &str, name: &str, input: Value) -> String {
    json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input,
            }]
        }
    })
    .to_string()
}

pub fn user_tool_result_line(id: &str, content: &str, is_error: bool) -> String {
    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": id,
                "content": content,
                "is_error": is_error,
            }]
        }
    })
    .to_string()
}
