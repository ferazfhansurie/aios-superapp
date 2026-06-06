//! Usage stats for the account menu. Reads `~/.aios/state/usage.json`, which the
//! AIOS statusline hook refreshes on every claude-code tick (the ONLY source of
//! the real 5h/7d rate-limit %, surfaced by claude only via statusLine stdin).

use serde_json::{json, Value};
use std::io::Write;
use std::process::Stdio;

/// Returns the raw usage payload as JSON, or `null` if not yet written.
/// Frontend renders 5h/7d %, reset countdowns, cost, context — or a graceful
/// "waiting for first tick" state when absent.
#[tauri::command]
pub fn usage_stats() -> Value {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = format!("{home}/.aios/state/usage.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

/// Live Claude rate-limit usage parsed directly from `~/.aios/state/usage.json`
/// (the statusline-written file `usage_stats` reads). Returns a shape that mirrors
/// `codex_usage` so the sidebar renders both identically:
///   { "fiveHour": {pct, resetsAt}, "sevenDay": {pct, resetsAt} }
/// Returns `null` when the file is missing/unwritten so the sidebar block hides
/// gracefully. Reads + parses the JSON in Rust — no shelling out to node/ccusage
/// (the GUI-launched app has no node on PATH).
#[tauri::command]
pub fn claude_usage() -> Value {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = format!("{home}/.aios/state/usage.json");
    let s = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Value::Null,
    };
    let v: Value = match serde_json::from_str(&s) {
        Ok(v) => v,
        Err(_) => return Value::Null,
    };
    let rl = match v.get("rate_limits") {
        Some(rl) => rl,
        None => return Value::Null,
    };
    let win = |k: &str| -> Value {
        let w = &rl[k];
        json!({
            "pct": w.get("used_percentage").and_then(|x| x.as_f64()),
            "resetsAt": w.get("resets_at").and_then(|x| x.as_i64()),
        })
    };
    json!({
        "fiveHour": win("five_hour"),
        "sevenDay": win("seven_day"),
    })
}

/// Live Codex (ChatGPT-subscription) rate-limit usage from the same
/// `/backend-api/wham/usage` endpoint the Codex desktop usage panel calls.
/// Returns a shape that mirrors `usage_stats`'s rate block so the sidebar renders
/// both identically:
///   { "five_hour": {pct, resets_at}, "seven_day": {pct, resets_at}, "plan": "plus" }
/// Falls back to the newest CLI websocket event in sqlite when the account
/// endpoint is temporarily unavailable.
#[tauri::command]
pub fn codex_usage() -> Value {
    codex_usage_from_wham().unwrap_or_else(codex_usage_from_sqlite)
}

fn codex_usage_from_wham() -> Option<Value> {
    let home = std::env::var("HOME").unwrap_or_default();
    let auth: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{home}/.codex/auth.json")).ok()?,
    )
    .ok()?;
    let token = auth.pointer("/tokens/access_token")?.as_str()?;
    let account = auth.pointer("/tokens/account_id")?.as_str()?;
    let mut child = std::process::Command::new("/usr/bin/curl")
        .args([
            "-fsS",
            "--max-time",
            "4",
            "--config",
            "-",
            "https://chatgpt.com/backend-api/wham/usage",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    child.stdin.as_mut()?.write_all(
        format!(
            "header = \"Authorization: Bearer {token}\"\nheader = \"ChatGPT-Account-ID: {account}\"\n"
        )
        .as_bytes(),
    )
    .ok()?;
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    let payload: Value = serde_json::from_slice(&out.stdout).ok()?;
    map_wham_usage(&payload)
}

fn map_wham_usage(payload: &Value) -> Option<Value> {
    let rl = payload.get("rate_limit")?;
    let win = |k: &str| -> Value {
        let w = &rl[k];
        json!({
            "pct": w.get("used_percent").and_then(|v| v.as_f64()),
            "resets_at": w.get("reset_at").and_then(|v| v.as_i64()),
        })
    };
    let models = map_model_windows_from_wham(payload);
    Some(json!({
        "five_hour": win("primary_window"),
        "seven_day": win("secondary_window"),
        "plan": payload.get("plan_type").and_then(|v| v.as_str()),
        "models": models,
    }))
}

fn codex_usage_from_sqlite() -> Value {
    let home = std::env::var("HOME").unwrap_or_default();
    let db = format!("{home}/.codex/logs_2.sqlite");
    if !std::path::Path::new(&db).exists() {
        return Value::Null;
    }
    // `sqlite3` ships with macOS at /usr/bin and is always on the GUI PATH.
    // `-readonly` so we never contend with the live Codex app's writes (WAL).
    let out = std::process::Command::new("sqlite3")
        .arg("-readonly")
        .arg(&db)
        .arg(
            "SELECT feedback_log_body FROM logs \
             WHERE feedback_log_body LIKE '%codex.rate_limits%used_percent%' \
             ORDER BY ts DESC LIMIT 1;",
        )
        .output();
    let body = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => return Value::Null,
    };
    // The log line embeds `…"rate_limits":{…}…`; slice out that one JSON object
    // by matching balanced braces from the first `{` after the key, then parse.
    let Some(rl) = extract_json_object(&body, "\"rate_limits\":") else {
        return Value::Null;
    };
    let parsed: Value = match serde_json::from_str(&rl) {
        Ok(v) => v,
        Err(_) => return Value::Null,
    };
    let win = |k: &str| -> Value {
        let w = &parsed[k];
        json!({
            "pct": w.get("used_percent").and_then(|v| v.as_f64()),
            "resets_at": w.get("reset_at").and_then(|v| v.as_i64()),
        })
    };
    // plan_type sits as a sibling of rate_limits in the same event object;
    // pull it out dependency-free as `"plan_type":"<word>"`.
    let plan = {
        let key = "\"plan_type\":\"";
        body.find(key).map(|i| {
            let rest = &body[i + key.len()..];
            rest.chars().take_while(|c| *c != '"').collect::<String>()
        })
    };
    let model = {
        let key = "\"model\":\"";
        body.find(key).map(|i| {
            let rest = &body[i + key.len()..];
            rest.chars().take_while(|c| *c != '"').collect::<String>()
        })
    };
    let mut models = serde_json::Map::new();
    if let Some(m) = model {
        models.insert(
            m.clone(),
            json!({
                "five_hour": win("primary"),
                "seven_day": win("secondary"),
            }),
        );
    }
    json!({
        "five_hour": win("primary"),
        "seven_day": win("secondary"),
        "plan": plan,
        "models": Value::Object(models),
    })
}

fn map_model_windows_from_wham(payload: &Value) -> Value {
    let mut out = serde_json::Map::new();
    let Some(additional) = payload.get("additional_rate_limits").and_then(|v| v.as_array()) else {
        return Value::Object(out);
    };
    for entry in additional {
        let name = entry
            .get("limit_name")
            .or_else(|| entry.get("model"))
            .or_else(|| entry.get("name"))
            .and_then(|v| v.as_str());
        let Some(name) = name else {
            continue;
        };
        let windows = entry.get("rate_limit").or_else(|| entry.get("rate_limits"));
        let windows = match windows.and_then(|v| v.as_object()) {
            Some(w) => w,
            None => continue,
        };
        let primary = windows
            .get("primary_window")
            .or_else(|| windows.get("primary"))
            .or_else(|| windows.get("five_hour"));
        let secondary = windows
            .get("secondary_window")
            .or_else(|| windows.get("secondary"))
            .or_else(|| windows.get("seven_day"));
        if primary.is_none() && secondary.is_none() {
            continue;
        }
        let parse = |w: Option<&Value>| -> Value {
            let Some(w) = w else {
                return json!({ "pct": null, "resets_at": null });
            };
            json!({
                "pct": w
                    .get("used_percent")
                    .or_else(|| w.get("usedPercent"))
                    .and_then(|v| v.as_f64()),
                "resets_at": w
                    .get("reset_at")
                    .or_else(|| w.get("resetAt"))
                    .or_else(|| w.get("resets_at"))
                    .and_then(|v| v.as_i64()),
            })
        };
        out.insert(
            name.to_string(),
            json!({
                "five_hour": parse(primary),
                "seven_day": parse(secondary),
            }),
        );
    }
    Value::Object(out)
}

/// Extracts the first balanced `{…}` JSON object that follows `key` in `s`.
/// Returns the object text (including braces) or `None` if not found / unbalanced.
fn extract_json_object(s: &str, key: &str) -> Option<String> {
    let start = s.find(key)? + key.len();
    let bytes = s.as_bytes();
    let mut i = start;
    while i < bytes.len() && bytes[i] != b'{' {
        i += 1;
    }
    if i >= bytes.len() {
        return None;
    }
    let obj_start = i;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else {
            match c {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(s[obj_start..=i].to_string());
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_codex_desktop_wham_usage_to_shell_windows() {
        let payload = json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": { "used_percent": 46, "reset_at": 111 },
                "secondary_window": { "used_percent": 7, "reset_at": 222 }
            }
        });
        assert_eq!(
            map_wham_usage(&payload),
            Some(json!({
                "five_hour": { "pct": 46.0, "resets_at": 111 },
                "seven_day": { "pct": 7.0, "resets_at": 222 },
                "plan": "plus",
                "models": {}
            }))
        );
    }

    #[test]
    fn maps_codex_wham_additional_rate_limits_by_model() {
        let payload = json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": { "used_percent": 46, "reset_at": 111 },
                "secondary_window": { "used_percent": 7, "reset_at": 222 }
            },
            "additional_rate_limits": [
                {
                    "model": "gpt-5.3-codex-spark",
                    "rate_limit": {
                        "primary_window": { "used_percent": 80, "reset_at": 333 },
                        "secondary_window": { "used_percent": 20, "reset_at": 444 }
                    }
                }
            ]
        });
        assert_eq!(
            map_wham_usage(&payload).and_then(|v| v.pointer("/models/gpt-5.3-codex-spark").cloned()),
            Some(json!({
                "five_hour": { "pct": 80.0, "resets_at": 333 },
                "seven_day": { "pct": 20.0, "resets_at": 444 }
            }))
        );
    }
}
