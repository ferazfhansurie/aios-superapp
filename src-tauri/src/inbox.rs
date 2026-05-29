//! Customer messaging INBOX — the superapp's customer-comms surface. The CRM
//! pane is no longer a deal pipeline: it's a place to talk to customers over
//! the channels AIOS already speaks (WhatsApp today, more later) and a list of
//! everyone you can message.
//!
//! Three commands, all defensive — every source fails soft to an empty field,
//! none of them ever panic:
//!
//!   - `list_customers`   — the people you can message. MERGES the WhatsApp
//!     logs (distinct peers from `outbound-log.jsonl` `target` + the inbound
//!     `personal-wa-events.jsonl` `from`/`chatName`) with the manual contacts
//!     from `crm.json` (reusing `crm::crm_load`). Deduped by handle (phone),
//!     newest conversation first.
//!   - `customer_thread`  — the recent messages with one handle, pulled from
//!     the same WhatsApp logs, chronological (oldest→newest) so it reads like a
//!     chat transcript.
//!   - `send_message`     — sends via the WhatsApp bridge's `push.js --to
//!     <phone> "<text>"`. Non-whatsapp channels honestly report "channel not
//!     connected yet".
//!
//! The log-reading + timestamp helpers are intentionally copied (not imported)
//! from `bridges.rs` so this module stands alone and can't be broken by changes
//! to the channels view. No new deps: `serde_json` + `chrono` only, both already
//! in `Cargo.toml`.

use std::path::PathBuf;

use serde_json::{json, Value};

// ════════════════════════════════════════════════════════════════════════
// paths
// ════════════════════════════════════════════════════════════════════════

/// `$HOME`, or `/` as a last resort (matches `crm.rs` / `bridges.rs`).
fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// Outbound WhatsApp log candidates — every line is a message AIOS sent. Probed
/// in order, first that exists wins. Mirrors `bridges.rs`'s whatsapp candidates.
const OUTBOUND_CANDIDATES: &[&str] = &[
    "Repo/firaz/aios/bridge/scripts/outbound-log.jsonl",
    "Repo/firaz/aios-bridge/scripts/outbound-log.jsonl",
    ".aios/state/outbound-log.jsonl",
];

/// Inbound WhatsApp conversation log — the personal-WA events feed. Each line is
/// a message a customer sent us.
const INBOUND_CANDIDATES: &[&str] = &[".aios/state/personal-wa-events.jsonl"];

/// Candidate push.js scripts, probed in order — the WhatsApp send transport.
const PUSH_CANDIDATES: &[&str] = &[
    "Repo/firaz/aios/bridge/scripts/push.js",
    "Repo/firaz/aios-bridge/scripts/push.js",
];

/// Resolves the first existing candidate path (absolute, or relative to HOME).
/// Copied from `bridges.rs::resolve_log` so this module is self-contained.
fn resolve_path(candidates: &[&str]) -> Option<String> {
    let home = home();
    for cand in candidates {
        let path = if cand.starts_with('/') {
            cand.to_string()
        } else {
            format!("{home}/{cand}")
        };
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }
    None
}

// ════════════════════════════════════════════════════════════════════════
// timestamp + text helpers (copied from bridges.rs — kept local on purpose)
// ════════════════════════════════════════════════════════════════════════

/// Pulls a timestamp out of a JSON log line, trying common key names, parsing
/// RFC3339 or a Unix epoch (secs/millis). Returns the parsed instant AND its
/// epoch-millis so callers can both render and sort without re-parsing.
fn extract_timestamp(obj: &serde_json::Map<String, Value>) -> Option<chrono::DateTime<chrono::Utc>> {
    let raw = obj
        .get("ts")
        .or_else(|| obj.get("timestamp"))
        .or_else(|| obj.get("time"))
        .or_else(|| obj.get("date"))
        .or_else(|| obj.get("at"))?;

    if let Some(s) = raw.as_str() {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
            return Some(dt.with_timezone(&chrono::Utc));
        }
    }
    if let Some(n) = raw.as_i64() {
        let (secs, nanos) = if n > 100_000_000_000 {
            (n / 1000, ((n % 1000) * 1_000_000) as u32)
        } else {
            (n, 0)
        };
        if let chrono::LocalResult::Single(dt) =
            chrono::TimeZone::timestamp_opt(&chrono::Utc, secs, nanos)
        {
            return Some(dt);
        }
    }
    None
}

/// Renders a UTC instant as local "YYYY-MM-DD HH:MM".
fn format_local(ts: &chrono::DateTime<chrono::Utc>) -> String {
    ts.with_timezone(&chrono::Local)
        .format("%Y-%m-%d %H:%M")
        .to_string()
}

/// "4m" / "3h" / "2d" since `ts`, or `None` if in the future / unparseable.
fn humanize_ago(ts: &chrono::DateTime<chrono::Utc>) -> Option<String> {
    let now = chrono::Utc::now();
    let delta = now.signed_duration_since(*ts);
    let secs = delta.num_seconds();
    if secs < 0 {
        return None;
    }
    Some(if secs < 60 {
        "<1m".into()
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    })
}

/// Pulls the first present, non-empty string value among `keys`.
fn first_str(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = obj.get(*k).and_then(|v| v.as_str()) {
            if !s.trim().is_empty() {
                return Some(s.trim().to_string());
            }
        }
    }
    None
}

/// Trims `s` to at most `max` chars (char-safe), collapsing interior whitespace
/// so a multi-line WA message renders as one tidy preview row.
fn trim_text(s: &str, max: usize) -> String {
    let collapsed: String = {
        let mut out = String::with_capacity(s.len());
        let mut prev_ws = false;
        for ch in s.trim().chars() {
            if ch.is_whitespace() {
                if !prev_ws {
                    out.push(' ');
                }
                prev_ws = true;
            } else {
                out.push(ch);
                prev_ws = false;
            }
        }
        out
    };
    if collapsed.chars().count() <= max {
        return collapsed;
    }
    let truncated: String = collapsed.chars().take(max).collect();
    format!("{}…", truncated.trim_end())
}

/// Normalises a phone/handle to its bare digits so the same person logged as
/// `+60 11-2167 7522`, `601121677522`, etc. dedups to one customer. Non-digit
/// handles (e.g. an `@lid` id with no phone) fall back to the trimmed original.
fn normalize_handle(raw: &str) -> String {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        raw.trim().to_string()
    } else {
        digits
    }
}

// ════════════════════════════════════════════════════════════════════════
// log line → a normalised message
// ════════════════════════════════════════════════════════════════════════

/// One parsed message from a WhatsApp log, normalised across the two log shapes.
struct Msg {
    /// Bare-digit (or raw) handle of the OTHER party — the customer.
    handle: String,
    /// Best human name we could find for that party (may equal the handle).
    name: String,
    direction: &'static str, // "out" | "in"
    text: String,
    ts: chrono::DateTime<chrono::Utc>,
}

/// Parses one OUTBOUND log line (`outbound-log.jsonl`). Every entry is a message
/// AIOS sent → direction "out", and the OTHER party is the `target` phone.
fn parse_outbound_line(line: &str) -> Option<Msg> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = v.as_object()?;
    let ts = extract_timestamp(obj)?;

    // Recipient phone — the customer on the other end.
    let raw_handle = first_str(obj, &["target", "to", "recipient", "phone"])?;
    let handle = normalize_handle(&raw_handle);
    if handle.is_empty() {
        return None;
    }

    // Body — prefer a real text body, fall back to a media tag.
    let text = first_str(obj, &["body", "text", "message", "content"])
        .or_else(|| first_str(obj, &["media"]).map(|m| format!("[{m}]")))
        .or_else(|| first_str(obj, &["kind"]).map(|k| format!("[{k}]")))
        .unwrap_or_default();

    Some(Msg {
        name: handle.clone(),
        handle,
        direction: "out",
        text,
        ts,
    })
}

/// Parses one INBOUND log line (`personal-wa-events.jsonl`). Every entry is a
/// message a customer sent us → direction "in". The party is identified by
/// `from`/`chatName` (a name) and `fromId`/`chatId` (a `…@lid`/`…@c.us` id we
/// derive the handle from). Group chats (`isGroup: true`) are skipped — this is
/// a 1:1 customer inbox.
fn parse_inbound_line(line: &str) -> Option<Msg> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = v.as_object()?;
    let ts = extract_timestamp(obj)?;

    if obj.get("isGroup").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }

    // Name first (display), then an id we can derive a handle from.
    let name = first_str(obj, &["from", "chatName", "name", "sender"])
        .unwrap_or_else(|| "unknown".to_string());
    let raw_id = first_str(obj, &["fromId", "chatId", "from", "phone"]).unwrap_or_else(|| name.clone());
    let handle = normalize_handle(&raw_id);
    if handle.is_empty() {
        return None;
    }

    let text = first_str(obj, &["body_preview", "body", "text", "message", "content"])
        .or_else(|| first_str(obj, &["type"]).map(|t| format!("[{t}]")))
        .unwrap_or_default();

    Some(Msg {
        handle,
        name,
        direction: "in",
        text,
        ts,
    })
}

/// Reads + parses an entire log file with the given per-line parser. Best-effort
/// — a missing/unreadable file yields an empty vec; bad lines are skipped.
fn read_messages(candidates: &[&str], parse: impl Fn(&str) -> Option<Msg>) -> Vec<Msg> {
    let Some(path) = resolve_path(candidates) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| parse(l))
        .collect()
}

/// Every WhatsApp message across both logs, unsorted.
fn all_wa_messages() -> Vec<Msg> {
    let mut msgs = read_messages(OUTBOUND_CANDIDATES, parse_outbound_line);
    msgs.extend(read_messages(INBOUND_CANDIDATES, parse_inbound_line));
    msgs
}

// ════════════════════════════════════════════════════════════════════════
// commands
// ════════════════════════════════════════════════════════════════════════

/// The people you can message. MERGES:
///   (a) distinct WhatsApp peers from the logs — last message time, last text,
///       and a message count, and
///   (b) manual contacts from `crm.json` (via `crm::crm_load`) — so someone you
///       added but never messaged still shows up.
///
/// Deduped by handle (bare-digit phone). When a manual contact and a logged peer
/// share a handle, the manual contact's name + id win (so editing the name in
/// the contacts store sticks) while the conversation stats come from the logs.
/// Sorted most-recent conversation first; never-messaged contacts sort last.
///
/// Shape: `[{ id, name, channel:"whatsapp", handle, lastAt, lastText, msgCount }]`.
/// Never errors — every source fails soft.
#[tauri::command]
pub fn list_customers() -> Value {
    use std::collections::HashMap;

    // Accumulator per handle.
    struct Agg {
        name: String,
        last_text: String,
        last_ts: Option<chrono::DateTime<chrono::Utc>>,
        msg_count: i64,
        /// Manual-contact id, if this handle is in crm.json.
        contact_id: Option<String>,
        /// Whether the name came from a manual contact (so it isn't overwritten
        /// by a log-derived name).
        name_pinned: bool,
    }

    let mut by_handle: HashMap<String, Agg> = HashMap::new();

    // 1) fold in every WhatsApp message.
    for m in all_wa_messages() {
        let entry = by_handle.entry(m.handle.clone()).or_insert_with(|| Agg {
            name: m.name.clone(),
            last_text: String::new(),
            last_ts: None,
            msg_count: 0,
            contact_id: None,
            name_pinned: false,
        });
        entry.msg_count += 1;
        // Keep the most-recent message's text + timestamp.
        let newer = entry.last_ts.map(|prev| m.ts > prev).unwrap_or(true);
        if newer {
            entry.last_ts = Some(m.ts);
            if !m.text.is_empty() {
                entry.last_text = m.text.clone();
            }
        }
        // Prefer an inbound display name (a real contact name) over a bare phone
        // unless we've already pinned a manual-contact name.
        if !entry.name_pinned && m.direction == "in" && m.name != m.handle && !m.name.is_empty() {
            entry.name = m.name.clone();
        }
    }

    // 2) fold in manual contacts (crm.json). Reuse the existing store loader.
    let store = crate::crm::crm_load();
    if let Some(contacts) = store.get("contacts").and_then(Value::as_array) {
        for c in contacts {
            let Some(obj) = c.as_object() else { continue };
            // Need a phone to message over WhatsApp; skip contacts without one.
            let Some(phone) = first_str(obj, &["phone", "handle"]) else {
                continue;
            };
            let handle = normalize_handle(&phone);
            if handle.is_empty() {
                continue;
            }
            let id = obj.get("id").and_then(Value::as_str).map(str::to_string);
            let name = first_str(obj, &["name"]).unwrap_or_else(|| handle.clone());

            let entry = by_handle.entry(handle.clone()).or_insert_with(|| Agg {
                name: name.clone(),
                last_text: String::new(),
                last_ts: None,
                msg_count: 0,
                contact_id: None,
                name_pinned: false,
            });
            // Manual contact wins on identity.
            entry.contact_id = id;
            entry.name = name;
            entry.name_pinned = true;
        }
    }

    // 3) project + sort (newest conversation first; never-messaged last).
    let mut out: Vec<(Option<chrono::DateTime<chrono::Utc>>, Value)> = by_handle
        .into_iter()
        .map(|(handle, a)| {
            let id = a.contact_id.unwrap_or_else(|| format!("wa:{handle}"));
            let last_at = a.last_ts.as_ref().map(format_local);
            let last_ago = a.last_ts.as_ref().and_then(humanize_ago);
            let value = json!({
                "id": id,
                "name": trim_text(&a.name, 48),
                "channel": "whatsapp",
                "handle": handle,
                "lastAt": last_at,
                "lastAgo": last_ago,
                "lastText": trim_text(&a.last_text, 120),
                "msgCount": a.msg_count,
            });
            (a.last_ts, value)
        })
        .collect();

    out.sort_by(|a, b| match (a.0, b.0) {
        (Some(x), Some(y)) => y.cmp(&x),       // both messaged → newest first
        (Some(_), None) => std::cmp::Ordering::Less, // messaged before never-messaged
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    Value::Array(out.into_iter().map(|(_, v)| v).collect())
}

/// Recent messages with one handle, pulled from the WhatsApp logs and returned
/// chronologically (oldest→newest) so it reads like a chat transcript. Matches
/// by normalised handle so the dedup in `list_customers` lines up.
///
/// Shape: `[{ ts, tsAgo, direction:"out"|"in", text }]`. Never errors.
#[tauri::command]
pub fn customer_thread(handle: String, limit: u32) -> Value {
    let limit = (limit.max(1) as usize).min(2000);
    let want = normalize_handle(&handle);

    let mut msgs: Vec<&Msg> = Vec::new();
    let all = all_wa_messages();
    for m in &all {
        if m.handle == want {
            msgs.push(m);
        }
    }

    // Chronological (oldest first).
    msgs.sort_by(|a, b| a.ts.cmp(&b.ts));

    // Keep the most-recent `limit` (the tail), still chronological.
    let start = msgs.len().saturating_sub(limit);
    let out: Vec<Value> = msgs[start..]
        .iter()
        .map(|m| {
            json!({
                "ts": format_local(&m.ts),
                "tsAgo": humanize_ago(&m.ts),
                "direction": m.direction,
                "text": m.text,
            })
        })
        .collect();

    Value::Array(out)
}

/// Sends a message over a channel. WhatsApp goes through the bridge's `push.js`
/// using the verified `--to <phone> "<text>"` flag (push.js:92 —
/// `if (a === '--to') { out.target = args[++i]; ... }`). Other channels honestly
/// report that they aren't connected yet.
///
/// Returns the script's stdout trimmed (typically a wamid or "sent") on success,
/// or an `Err(String)` describing what went wrong — never panics.
#[tauri::command]
pub fn send_message(channel: String, to: String, text: String) -> Result<String, String> {
    let channel = channel.trim().to_lowercase();
    if channel != "whatsapp" {
        return Err("channel not connected yet".into());
    }

    let to = to.trim();
    let text = text.trim();
    if to.is_empty() {
        return Err("no recipient".into());
    }
    if text.is_empty() {
        return Err("empty message".into());
    }

    let Some(script) = resolve_path(PUSH_CANDIDATES) else {
        return Err("push.js not found (looked under ~/Repo/firaz/aios/bridge + aios-bridge)".into());
    };

    // node push.js --to <phone> "<text>"
    let output = std::process::Command::new("node")
        .arg(&script)
        .arg("--to")
        .arg(to)
        .arg(text)
        .output()
        .map_err(|e| format!("spawn node failed: {e}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if stdout.is_empty() { "sent".into() } else { stdout })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("push.js exited with {}", output.status)
        };
        Err(trim_text(&msg, 240))
    }
}
