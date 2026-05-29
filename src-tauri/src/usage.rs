//! Usage stats for the account menu. Reads `~/.aios/state/usage.json`, which the
//! AIOS statusline hook refreshes on every claude-code tick (the ONLY source of
//! the real 5h/7d rate-limit %, surfaced by claude only via statusLine stdin).

use serde_json::Value;

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
