//! Usage stats for the account menu.
//!
//! Claude usage now prefers the logged-in claude.ai web session from the live
//! browser pane — the same source Claude's own usage screen uses — then falls
//! back to Anthropic OAuth and finally the older local statusline cache.

use chrono::DateTime;
use serde_json::{json, Value};
use std::io::Write;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const CLAUDE_USAGE_CACHE_TTL_SECS: u64 = 30;
static CLAUDE_USAGE_CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

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

/// Live Claude rate-limit usage from the active claude.ai web session, falling
/// back to Anthropic OAuth and then the local statusline cache. Returns a shape
/// that mirrors `codex_usage` so the sidebar renders both identically:
///   { "fiveHour": {pct, resetsAt}, "sevenDay": {pct, resetsAt} }
/// Returns `null` when no source is available so the sidebar block hides
/// gracefully. Reads + parses in Rust — no shelling out to node/ccusage.
#[tauri::command]
pub fn claude_usage(app: AppHandle) -> Value {
    claude_usage_value(Some(&app))
}

pub fn claude_usage_value(app: Option<&AppHandle>) -> Value {
    if let Some(app) = app {
        if let Some(data) = claude_usage_from_webview(app) {
            if claude_usage_has_signal(&data) {
                write_claude_usage_cache(&data);
                return data;
            }
        }
    }

    if let Ok(guard) = CLAUDE_USAGE_CACHE.lock() {
        if let Some((fetched_at, ref data)) = *guard {
            if fetched_at.elapsed().as_secs() < CLAUDE_USAGE_CACHE_TTL_SECS
                && claude_usage_has_signal(data)
            {
                return data.clone();
            }
        }
    }

    if let Some(data) = claude_usage_from_oauth() {
        if claude_usage_has_signal(&data) {
            write_claude_usage_cache(&data);
            return data;
        }
    }

    if let Some(data) = claude_usage_from_helper() {
        if claude_usage_has_signal(&data) {
            write_claude_usage_cache(&data);
            return data;
        }
    }

    let data = claude_usage_from_statusline().unwrap_or(Value::Null);
    if claude_usage_has_signal(&data) {
        write_claude_usage_cache(&data);
    }
    data
}

fn write_claude_usage_cache(data: &Value) {
    if let Ok(mut guard) = CLAUDE_USAGE_CACHE.lock() {
        *guard = Some((Instant::now(), data.clone()));
    }
}

fn claude_usage_has_signal(data: &Value) -> bool {
    if data.is_null() {
        return false;
    }
    for key in ["fiveHour", "sevenDay"] {
        let Some(win) = data.get(key) else {
            continue;
        };
        if win.get("resetsAt").and_then(|v| v.as_i64()).is_some() {
            return true;
        }
        if win
            .get("pct")
            .and_then(|v| v.as_f64())
            .is_some_and(|pct| pct > 0.0)
        {
            return true;
        }
    }
    false
}

fn claude_usage_from_statusline() -> Option<Value> {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = format!("{home}/.aios/state/usage.json");
    let s = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return None,
    };
    let v: Value = match serde_json::from_str(&s) {
        Ok(v) => v,
        Err(_) => return None,
    };
    let rl = match v.get("rate_limits") {
        Some(rl) => rl,
        None => return None,
    };
    let win = |k: &str| -> Value {
        let w = &rl[k];
        json!({
            "pct": w.get("used_percentage").and_then(|x| x.as_f64()),
            "resetsAt": w.get("resets_at").and_then(|x| x.as_i64()),
        })
    };
    Some(json!({
        "fiveHour": win("five_hour"),
        "sevenDay": win("seven_day"),
        "source": "statusline",
    }))
}

#[derive(Debug, Clone)]
struct ClaudeWebSession {
    org_id: String,
    cookie_header: String,
}

#[cfg(target_os = "macos")]
fn claude_usage_from_webview(app: &AppHandle) -> Option<Value> {
    for (_label, webview) in app.webviews() {
        let Some(cookies) = claude_cookie_pairs_from_webview(&webview) else {
            continue;
        };
        let Some(session) = claude_web_session_from_cookies(&cookies) else {
            continue;
        };
        if let Some(data) = claude_usage_from_web_session(&session) {
            return Some(data);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn claude_usage_from_webview(_app: &AppHandle) -> Option<Value> {
    None
}

#[cfg(target_os = "macos")]
fn claude_cookie_pairs_from_webview<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
) -> Option<Vec<(String, String)>> {
    use block2::RcBlock;
    use objc2_foundation::{NSArray, NSHTTPCookie};
    use std::ptr::NonNull;

    let (tx, rx) = std::sync::mpsc::channel::<Vec<(String, String)>>();
    let _ = webview.with_webview(move |pw| {
        let ptr = pw.inner() as *mut objc2_web_kit::WKWebView;
        let Some(wk) = (unsafe { ptr.as_ref() }) else {
            let _ = tx.send(Vec::new());
            return;
        };
        let store = unsafe { wk.configuration().websiteDataStore() };
        let cookie_store = unsafe { store.httpCookieStore() };
        let done = RcBlock::new(move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
            let pairs = unsafe { cookies.as_ref() }
                .to_vec()
                .into_iter()
                .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
                .collect::<Vec<_>>();
            let _ = tx.send(pairs);
        });
        unsafe {
            cookie_store.getAllCookies(&done);
        }
    });
    rx.recv_timeout(Duration::from_millis(900)).ok()
}

fn claude_web_session_from_cookies(cookies: &[(String, String)]) -> Option<ClaudeWebSession> {
    let mut org_id = None;
    let mut has_session_key = false;
    let mut header = Vec::new();

    for (name, value) in cookies {
        let name = name.trim();
        let value = value.trim();
        if name.is_empty()
            || value.is_empty()
            || !is_cookie_header_safe(name)
            || !is_cookie_header_safe(value)
        {
            continue;
        }
        if name == "sessionKey" && value.starts_with("sk-") {
            has_session_key = true;
        }
        if org_id.is_none() && name.eq_ignore_ascii_case("lastActiveOrg") {
            org_id = find_uuid_like(value);
        }
        if org_id.is_none() && name.to_ascii_lowercase().contains("org") {
            org_id = find_uuid_like(value);
        }
        header.push(format!("{name}={value}"));
    }

    let org_id = org_id?;
    if !has_session_key || header.is_empty() {
        return None;
    }
    Some(ClaudeWebSession {
        org_id,
        cookie_header: header.join("; "),
    })
}

fn claude_usage_from_web_session(session: &ClaudeWebSession) -> Option<Value> {
    let url = format!(
        "https://claude.ai/api/organizations/{}/usage",
        session.org_id
    );
    let mut child = std::process::Command::new("/usr/bin/curl")
        .args(["-fsS", "--max-time", "5", "--config", "-", &url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    let config = format!(
        "header = \"Cookie: {}\"\n\
         header = \"User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.0\"\n\
         header = \"Accept: application/json, text/plain, */*\"\n\
         header = \"Referer: https://claude.ai/settings/usage\"\n\
         header = \"anthropic-client-platform: web_claude_ai\"\n",
        curl_config_escape(&session.cookie_header),
    );
    child.stdin.as_mut()?.write_all(config.as_bytes()).ok()?;
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    let payload: Value = serde_json::from_slice(&out.stdout).ok()?;
    map_claude_web_usage(&payload)
}

fn claude_usage_from_helper() -> Option<Value> {
    let home = std::env::var("HOME").ok()?;
    let helper = format!("{home}/.config/aios/helpers/claude-usage-fetch.py");
    if std::path::Path::new(&helper).exists() {
        let _ = std::process::Command::new(&helper)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let cache = format!("{home}/.cache/adletic/claude-usage.json");
    let meta = std::fs::metadata(&cache).ok()?;
    let modified = meta.modified().ok()?;
    if modified.elapsed().ok()?.as_secs() > 180 {
        return None;
    }
    let payload: Value = serde_json::from_str(&std::fs::read_to_string(cache).ok()?).ok()?;
    map_claude_helper_usage(&payload)
}

fn map_claude_helper_usage(payload: &Value) -> Option<Value> {
    let usage = payload.get("usage").unwrap_or(payload);
    let mut mapped = map_claude_web_usage(usage)?;
    if let Some(obj) = mapped.as_object_mut() {
        obj.insert("source".to_string(), json!("claude-helper"));
    }
    Some(mapped)
}

fn find_uuid_like(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() < 36 {
        return None;
    }
    for start in 0..=chars.len() - 36 {
        let candidate = &chars[start..start + 36];
        if candidate.iter().enumerate().all(|(i, c)| {
            matches!(i, 8 | 13 | 18 | 23) && *c == '-'
                || !matches!(i, 8 | 13 | 18 | 23) && c.is_ascii_hexdigit()
        }) {
            return Some(candidate.iter().collect::<String>().to_ascii_lowercase());
        }
    }
    None
}

fn is_cookie_header_safe(s: &str) -> bool {
    s.chars()
        .all(|c| c.is_ascii_graphic() && c != ';' && c != '"')
}

fn curl_config_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\r', '\n'], " ")
}

fn claude_usage_from_oauth() -> Option<Value> {
    let token = claude_oauth_token()?;
    let mut child = std::process::Command::new("/usr/bin/curl")
        .args([
            "-fsS",
            "--max-time",
            "4",
            "--config",
            "-",
            "https://api.anthropic.com/api/oauth/usage",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    child.stdin.as_mut()?.write_all(
        format!(
            "header = \"Authorization: Bearer {token}\"\nheader = \"anthropic-beta: oauth-2025-04-20\"\nheader = \"User-Agent: claude-code/2.0.32\"\n"
        )
        .as_bytes(),
    )
    .ok()?;
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    let payload: Value = serde_json::from_slice(&out.stdout).ok()?;
    map_claude_oauth_usage(&payload)
}

fn claude_oauth_token() -> Option<String> {
    claude_oauth_token_from_keychain()
        .or_else(claude_oauth_token_from_credentials_file)
        .or_else(claude_oauth_token_from_env_file)
}

fn claude_oauth_token_from_env_file() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let path = format!("{home}/.aios/state/claude-oauth.env");
    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "CLAUDE_CODE_OAUTH_TOKEN" {
            continue;
        }
        let token = value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string();
        if !token.is_empty() {
            return Some(token);
        }
    }
    None
}

fn claude_oauth_token_from_credentials_file() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let path = format!("{home}/.claude/.credentials.json");
    let text = std::fs::read_to_string(path).ok()?;
    parse_claude_credentials_token(&text)
}

#[cfg(target_os = "macos")]
fn claude_oauth_token_from_keychain() -> Option<String> {
    let user = std::env::var("USER").ok()?;
    let out = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-a",
            &user,
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    parse_claude_credentials_token(text.trim())
}

#[cfg(not(target_os = "macos"))]
fn claude_oauth_token_from_keychain() -> Option<String> {
    None
}

fn parse_claude_credentials_token(text: &str) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    let oauth = v
        .get("claudeAiOauth")
        .or_else(|| v.get("claude_ai_oauth"))?;
    let expires_at = oauth
        .get("expiresAt")
        .or_else(|| oauth.get("expires_at"))
        .and_then(|v| v.as_u64());
    if let Some(expires_at) = expires_at {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis() as u64;
        if expires_at < now_ms + 60_000 {
            return None;
        }
    }
    oauth
        .get("accessToken")
        .or_else(|| oauth.get("access_token"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn iso_to_unix_secs(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|dt| dt.timestamp()),
        _ => None,
    }
}

fn percent_from_utilization(v: Option<&Value>) -> Option<f64> {
    let raw = v?.as_f64()?;
    Some(if raw >= 1.0 { raw } else { raw * 100.0 })
}

fn map_claude_oauth_usage(payload: &Value) -> Option<Value> {
    let win = |k: &str| -> Value {
        let w = payload.get(k);
        json!({
            "pct": percent_from_utilization(w.and_then(|x| x.get("utilization"))),
            "resetsAt": iso_to_unix_secs(w.and_then(|x| x.get("resets_at"))),
        })
    };
    if payload.get("five_hour").is_none() && payload.get("seven_day").is_none() {
        return None;
    }
    Some(json!({
        "fiveHour": win("five_hour"),
        "sevenDay": win("seven_day"),
        "opus": win("seven_day_opus"),
        "source": "oauth",
    }))
}

fn map_claude_web_usage(payload: &Value) -> Option<Value> {
    let win = |k: &str| -> Value {
        let w = payload.get(k);
        json!({
            "pct": w.and_then(|x| x.get("utilization")).and_then(|x| x.as_f64()),
            "resetsAt": iso_to_unix_secs(w.and_then(|x| x.get("resets_at"))),
        })
    };
    if payload.get("five_hour").is_none() && payload.get("seven_day").is_none() {
        return None;
    }
    Some(json!({
        "fiveHour": win("five_hour"),
        "sevenDay": win("seven_day"),
        "opus": win("seven_day_opus"),
        "source": "claude-web",
    }))
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
    let auth: Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{home}/.codex/auth.json")).ok()?)
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
    let Some(additional) = payload
        .get("additional_rate_limits")
        .and_then(|v| v.as_array())
    else {
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
            map_wham_usage(&payload)
                .and_then(|v| v.pointer("/models/gpt-5.3-codex-spark").cloned()),
            Some(json!({
                "five_hour": { "pct": 80.0, "resets_at": 333 },
                "seven_day": { "pct": 20.0, "resets_at": 444 }
            }))
        );
    }

    #[test]
    fn maps_claude_web_usage_to_current_session_windows() {
        let payload = json!({
            "five_hour": {
                "utilization": 1,
                "resets_at": "2026-06-06T12:08:00Z"
            },
            "seven_day": {
                "utilization": 20,
                "resets_at": "2026-06-12T09:59:00Z"
            }
        });
        let mapped = map_claude_web_usage(&payload).expect("mapped");
        assert_eq!(
            mapped.pointer("/fiveHour/pct").and_then(|v| v.as_f64()),
            Some(1.0)
        );
        assert_eq!(
            mapped.pointer("/sevenDay/pct").and_then(|v| v.as_f64()),
            Some(20.0)
        );
        assert_eq!(
            mapped.pointer("/source").and_then(|v| v.as_str()),
            Some("claude-web")
        );
        assert!(
            mapped
                .pointer("/fiveHour/resetsAt")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                > 0
        );
    }

    #[test]
    fn maps_claude_helper_cache_to_shell_windows() {
        let payload = json!({
            "org_id": "18ec2fc4-cfd2-42f8-9a69-76ca3088f5d0",
            "usage": {
                "five_hour": {
                    "utilization": 0,
                    "resets_at": "2026-06-06T12:08:00Z"
                },
                "seven_day": {
                    "utilization": 20,
                    "resets_at": "2026-06-12T09:59:00Z"
                }
            }
        });
        let mapped = map_claude_helper_usage(&payload).expect("mapped");
        assert_eq!(
            mapped.pointer("/fiveHour/pct").and_then(|v| v.as_f64()),
            Some(0.0)
        );
        assert_eq!(
            mapped.pointer("/sevenDay/pct").and_then(|v| v.as_f64()),
            Some(20.0)
        );
        assert_eq!(
            mapped.pointer("/source").and_then(|v| v.as_str()),
            Some("claude-helper")
        );
    }

    #[test]
    fn rejects_zeroed_claude_usage_without_reset_signal() {
        let stale = json!({
            "fiveHour": { "pct": 0.0, "resetsAt": null },
            "sevenDay": { "pct": 0.0, "resetsAt": null },
            "source": "claude-helper",
        });
        assert!(!claude_usage_has_signal(&stale));

        let real_zero = json!({
            "fiveHour": { "pct": 0.0, "resetsAt": 1770000000 },
            "sevenDay": { "pct": 0.0, "resetsAt": null },
            "source": "claude-web",
        });
        assert!(claude_usage_has_signal(&real_zero));

        let active = json!({
            "fiveHour": { "pct": 1.0, "resetsAt": null },
            "sevenDay": { "pct": 20.0, "resetsAt": null },
            "source": "oauth",
        });
        assert!(claude_usage_has_signal(&active));
    }

    #[test]
    fn extracts_claude_web_session_from_cookie_pairs() {
        let cookies = vec![
            ("other".to_string(), "noise".to_string()),
            (
                "lastActiveOrg".to_string(),
                "18ec2fc4-cfd2-42f8-9a69-76ca3088f5d0".to_string(),
            ),
            ("sessionKey".to_string(), "sk-ant-sid01-test".to_string()),
        ];
        let session = claude_web_session_from_cookies(&cookies).expect("session");
        assert_eq!(session.org_id, "18ec2fc4-cfd2-42f8-9a69-76ca3088f5d0");
        assert!(session.cookie_header.contains("lastActiveOrg=18ec2fc4"));
        assert!(session
            .cookie_header
            .contains("sessionKey=sk-ant-sid01-test"));
    }

    #[test]
    fn maps_claude_oauth_usage_to_shell_windows() {
        let payload = json!({
            "five_hour": {
                "utilization": 0.01,
                "resets_at": "2026-06-06T12:08:00Z"
            },
            "seven_day": {
                "utilization": 20,
                "resets_at": "2026-06-12T09:59:00Z"
            },
            "seven_day_opus": {
                "utilization": 0,
                "resets_at": "2026-06-12T10:00:00Z"
            }
        });
        let mapped = map_claude_oauth_usage(&payload).expect("mapped");
        assert_eq!(
            mapped.pointer("/fiveHour/pct").and_then(|v| v.as_f64()),
            Some(1.0)
        );
        assert_eq!(
            mapped.pointer("/sevenDay/pct").and_then(|v| v.as_f64()),
            Some(20.0)
        );
        assert_eq!(
            mapped.pointer("/source").and_then(|v| v.as_str()),
            Some("oauth")
        );
        assert!(
            mapped
                .pointer("/fiveHour/resetsAt")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                > 0
        );
    }

    #[test]
    fn parses_unexpired_claude_credentials_tokens() {
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 3_600_000;
        let creds = json!({
            "claudeAiOauth": {
                "accessToken": "sk-ant-oat01-test",
                "expiresAt": expires_at
            }
        });
        assert_eq!(
            parse_claude_credentials_token(&creds.to_string()),
            Some("sk-ant-oat01-test".to_string())
        );
    }
}
