//! Long-horizon usage stats for the account menu, absorbed from the retired
//! terminal HUD. The activity heatmap, streaks, active-day windows, and token
//! total come from LIVE `ccusage daily --json --offline` data (the same source
//! the terminal HUD used) so streaks stay accurate. Session/message totals and
//! the favorite model are merged in from `~/.claude/stats-cache.json` when
//! present, falling back to ccusage-derived values otherwise.
//!
//! Why the merge: the on-disk `stats-cache.json` goes stale (its latest day can
//! be weeks old), so deriving streaks from it computes 0. ccusage reflects real
//! per-day usage. But ccusage's `daily` array has no session/message counts, so
//! those still come from the cache when available.
//!
//! Distinct from `usage.rs`, which surfaces the LIVE 5h/7d rate-limit %. This is
//! the slow-moving historical layer. Defensive throughout: ccusage failing or
//! the cache being missing/invalid yields nulls/empties, never a panic.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::Local;
use serde_json::{json, Value};

/// Cached JSONL-telemetry fallback for activity/tokens/favorite-model, used when
/// neither ccusage nor `stats-cache.json` is available (the typical Windows
/// case). Walking every `~/.claude/projects/**/*.jsonl` is expensive, so the
/// result is memoised for 5 minutes — plenty fresh for an idle dashboard.
/// Returns `(date → activity-count, total-tokens, favorite-model)`.
fn telemetry_fallback() -> (HashMap<String, f64>, Option<f64>, Option<String>) {
    struct Cached {
        at: Instant,
        activity: HashMap<String, f64>,
        tokens: Option<f64>,
        favorite: Option<String>,
    }
    static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    let cell = CACHE.get_or_init(|| Mutex::new(None));

    if let Ok(guard) = cell.lock() {
        if let Some(c) = guard.as_ref() {
            if c.at.elapsed() < Duration::from_secs(300) {
                return (c.activity.clone(), c.tokens, c.favorite.clone());
            }
        }
    }

    let t = crate::telemetry::collect();
    let activity: HashMap<String, f64> = t
        .heatmap
        .iter()
        .filter(|c| c.count > 0)
        .map(|c| (c.date.clone(), c.count as f64))
        .collect();
    let tokens = (t.totals.tokens > 0).then_some(t.totals.tokens as f64);
    let favorite = (!t.streak.favorite_model.is_empty()).then_some(t.streak.favorite_model.clone());

    if let Ok(mut guard) = cell.lock() {
        *guard = Some(Cached {
            at: Instant::now(),
            activity: activity.clone(),
            tokens,
            favorite: favorite.clone(),
        });
    }
    (activity, tokens, favorite)
}

/// Number of trailing days the heatmap covers (10 weeks).
const HEATMAP_DAYS: i64 = 70;

/// Normalized working shape, derived from the on-disk cache. We parse to a loose
/// `serde_json::Value` first and walk it tolerantly, because the cache mixes
/// shapes across versions: `dailyActivity`/`dailyModelTokens` are arrays of
/// per-day objects (e.g. `{date, messageCount, sessionCount}`), while older or
/// simpler caches may use `"YYYY-MM-DD" → number` maps. Both are handled.
#[derive(Debug, Default)]
struct StatsCache {
    /// "YYYY-MM-DD" → activity count for the day (messageCount when present).
    daily_activity: HashMap<String, f64>,
    /// Sum of all per-day, per-model token counts (when `dailyModelTokens` set).
    tokens_total: Option<f64>,
    /// modelId → aggregate usage weight (total tokens) for picking a favorite.
    model_usage: HashMap<String, f64>,
    total_sessions: Option<f64>,
    total_messages: Option<f64>,
    first_session_date: Option<String>,
}

/// Reads + parses the stats cache; missing/invalid → `None`.
fn read_cache() -> Option<StatsCache> {
    let home = std::env::var("HOME").ok()?;
    let path = format!("{home}/.claude/stats-cache.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let root: Value = serde_json::from_str(&text).ok()?;
    Some(parse_cache(&root))
}

/// Pulls a number out of a `Value` regardless of int/float encoding.
fn as_num(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// Live usage derived from `ccusage daily --json --offline`. The activity map is
/// `"YYYY-MM-DD" → totalTokens` for every day ccusage reports (a day's presence
/// with tokens > 0 means it was active). `tokens_total` prefers the top-level
/// `totals.totalTokens` grand total, else sums the per-day values. `model_freq`
/// counts how often each model appears across days for a favorite fallback.
#[derive(Debug, Default)]
struct LiveUsage {
    /// "YYYY-MM-DD" → that day's totalTokens (used as heatmap count + activity).
    daily_activity: HashMap<String, f64>,
    tokens_total: Option<f64>,
    /// modelName → number of days it appears (favorite fallback when no cache).
    model_freq: HashMap<String, f64>,
}

/// Runs ccusage and parses its daily output. Returns `None` on any failure
/// (binary missing, non-zero exit, unparseable JSON, empty data) so callers can
/// fall back to the stale on-disk cache. Never panics.
fn read_live_usage() -> Option<LiveUsage> {
    // Resolve the binary: prefer the known nvm path, fall back to PATH lookup.
    let home = std::env::var("HOME").ok();
    let nvm_bin = home
        .as_deref()
        .map(|h| format!("{h}/.nvm/versions/node/v22.12.0/bin/ccusage"));
    let candidates: Vec<&str> = nvm_bin
        .as_deref()
        .filter(|p| std::path::Path::new(p).exists())
        .into_iter()
        .chain(std::iter::once("ccusage"))
        .collect();

    // ccusage is a `#!/usr/bin/env node` script. GUI apps launched from Finder/
    // dock inherit a minimal PATH with no `node`, so spawning the script directly
    // fails (non-zero exit) and we'd silently fall back to the stale on-disk cache
    // — which is exactly how the streak/active counts collapsed to 0 while best +
    // tok (computed from the frozen cache) still showed. Resolve `node` explicitly
    // (same probe monitor.rs uses) and run `node <ccusage-cli> …` instead.
    let node = crate::monitor::node_bin();
    let mut output = None;
    for bin in candidates {
        let spawned = match &node {
            Some(n) => std::process::Command::new(n)
                .arg(bin)
                .args(["daily", "--json", "--offline"])
                .output(),
            None => std::process::Command::new(bin)
                .args(["daily", "--json", "--offline"])
                .output(),
        };
        if let Ok(out) = spawned {
            if out.status.success() {
                output = Some(out.stdout);
                break;
            }
        }
    }
    let stdout = output?;
    let root: Value = serde_json::from_slice(&stdout).ok()?;
    let daily = root.get("daily")?.as_array()?;
    if daily.is_empty() {
        return None;
    }

    let mut daily_activity: HashMap<String, f64> = HashMap::new();
    let mut model_freq: HashMap<String, f64> = HashMap::new();
    let mut per_day_sum = 0.0;
    for entry in daily {
        let Value::Object(o) = entry else { continue };
        // ccusage labels the day under `period` (fall back to `date` defensively).
        let Some(date) = o
            .get("period")
            .or_else(|| o.get("date"))
            .and_then(|d| d.as_str())
        else {
            continue;
        };
        let tokens = o.get("totalTokens").and_then(as_num).unwrap_or(0.0);
        // A day can appear more than once in theory; accumulate.
        *daily_activity.entry(date.to_string()).or_insert(0.0) += tokens;
        per_day_sum += tokens;
        if let Some(models) = o.get("modelsUsed").and_then(|m| m.as_array()) {
            for m in models {
                if let Some(name) = m.as_str() {
                    *model_freq.entry(name.to_string()).or_insert(0.0) += 1.0;
                }
            }
        }
    }
    if daily_activity.is_empty() {
        return None;
    }

    // Grand total: prefer ccusage's own `totals.totalTokens`, else the per-day sum.
    let tokens_total = root
        .get("totals")
        .and_then(|t| t.get("totalTokens"))
        .and_then(as_num)
        .or(Some(per_day_sum));

    Some(LiveUsage {
        daily_activity,
        tokens_total,
        model_freq,
    })
}

/// Walks a `dailyActivity`-style field into a `date → count` map. Accepts both
/// the array-of-objects shape (`[{date, messageCount, ...}]`, also under numeric
/// keys in an object) and the plain `date → number` map shape.
fn parse_daily_activity(v: &Value) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    let entries: Vec<&Value> = match v {
        Value::Array(a) => a.iter().collect(),
        Value::Object(o) => o.values().collect(),
        _ => return out,
    };
    for entry in entries {
        match entry {
            // Per-day object: prefer messageCount, fall back to other counters.
            Value::Object(o) => {
                let Some(date) = o.get("date").and_then(|d| d.as_str()) else {
                    continue;
                };
                let count = o
                    .get("messageCount")
                    .or_else(|| o.get("toolCallCount"))
                    .or_else(|| o.get("sessionCount"))
                    .and_then(as_num)
                    .unwrap_or(0.0);
                out.insert(date.to_string(), count);
            }
            // Plain number under a date key — only reachable for the map shape,
            // handled below instead.
            _ => {}
        }
    }
    // If nothing matched as objects, treat the object as a date→number map.
    if out.is_empty() {
        if let Value::Object(o) = v {
            for (k, val) in o {
                if let Some(n) = as_num(val) {
                    out.insert(k.clone(), n);
                }
            }
        }
    }
    out
}

/// Sums every per-day, per-model token count from a `dailyModelTokens` field
/// (array-of-`{date, tokensByModel}` or `date → {model: tokens}` map).
fn parse_tokens_total(v: &Value) -> Option<f64> {
    let entries: Vec<&Value> = match v {
        Value::Array(a) => a.iter().collect(),
        Value::Object(o) => o.values().collect(),
        _ => return None,
    };
    let mut sum = 0.0;
    let mut saw_any = false;
    for entry in entries {
        let by_model = match entry {
            Value::Object(o) => o.get("tokensByModel").and_then(|t| t.as_object()).or(Some(o)),
            _ => None,
        };
        if let Some(map) = by_model {
            for val in map.values() {
                if let Some(n) = as_num(val) {
                    sum += n;
                    saw_any = true;
                }
            }
        }
    }
    saw_any.then_some(sum)
}

/// Builds `model → weight` for favorite selection. `modelUsage` values are
/// either a bare count (older shape) or an object of token buckets (current),
/// in which case we sum input + output as the weight.
fn parse_model_usage(v: &Value) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    let Value::Object(o) = v else { return out };
    for (model, usage) in o {
        let weight = match usage {
            Value::Object(u) => ["inputTokens", "outputTokens"]
                .iter()
                .filter_map(|k| u.get(*k).and_then(as_num))
                .sum::<f64>(),
            other => as_num(other).unwrap_or(0.0),
        };
        out.insert(model.clone(), weight);
    }
    out
}

/// Tolerant walk of the cache `Value` into the normalized working struct.
fn parse_cache(root: &Value) -> StatsCache {
    let get = |k: &str| root.get(k);
    StatsCache {
        daily_activity: get("dailyActivity").map(parse_daily_activity).unwrap_or_default(),
        tokens_total: get("dailyModelTokens").and_then(parse_tokens_total),
        model_usage: get("modelUsage").map(parse_model_usage).unwrap_or_default(),
        total_sessions: get("totalSessions").and_then(as_num),
        total_messages: get("totalMessages").and_then(as_num),
        first_session_date: get("firstSessionDate")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    }
}

/// Days since the Unix epoch for a `YYYY-MM-DD` string (UTC, proleptic
/// Gregorian). `None` if it doesn't parse. Avoids pulling in a date crate.
fn day_number(date: &str) -> Option<i64> {
    let mut it = date.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    let d: i64 = it.next()?.trim().parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Howard Hinnant's days-from-civil algorithm.
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

/// Inverse of `day_number`: epoch-day → `YYYY-MM-DD`.
fn date_string(z: i64) -> String {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Today as an epoch-day number, in LOCAL time (the machine is MYT/UTC+8, and
/// both ccusage and the cache key days by local date). Uses chrono so the day
/// boundary matches the data; falls back to UTC epoch-days if chrono somehow
/// yields a date that doesn't round-trip.
fn today_day_number() -> i64 {
    let local_date = Local::now().date_naive();
    day_number(&local_date.format("%Y-%m-%d").to_string()).unwrap_or_else(|| {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        secs / 86_400
    })
}

/// Pretty model label, e.g. `claude-opus-4-8` → `Opus 4.8`. Falls back to the
/// raw id if it doesn't match the known shape.
fn pretty_model(id: &str) -> String {
    let lower = id.to_lowercase();
    let family = if lower.contains("opus") {
        "Opus"
    } else if lower.contains("sonnet") {
        "Sonnet"
    } else if lower.contains("haiku") {
        "Haiku"
    } else {
        return id.to_string();
    };
    // Pull a major[.minor] version out of the digit groups.
    let nums: Vec<&str> = id
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .collect();
    match nums.as_slice() {
        [maj, min, ..] => format!("{family} {maj}.{min}"),
        [maj] => format!("{family} {maj}"),
        [] => family.to_string(),
    }
}

/// Returns derived long-horizon usage stats for the account menu. Always returns
/// a JSON object; on a missing/invalid cache the numeric fields are `null`/`0`
/// and `heatmap` is still a full last-70-days run of zeros so the grid renders.
#[tauri::command]
pub fn usage_extras() -> Value {
    let cache = read_cache();
    let live = read_live_usage();
    let today = today_day_number();

    // --- Activity source priority: LIVE ccusage → on-disk cache → JSONL
    // telemetry. Streaks/heatmap/active-windows/tokens all key off this map. The
    // telemetry fallback is what lights up the homescreen on Windows, where
    // ccusage isn't installed and stats-cache.json doesn't exist. ---
    let mut activity_owned: Option<HashMap<String, f64>> = live
        .as_ref()
        .map(|l| l.daily_activity.clone())
        .or_else(|| {
            cache
                .as_ref()
                .map(|c| c.daily_activity.clone())
                .filter(|m| !m.is_empty())
        });
    let mut tele_tokens: Option<f64> = None;
    let mut tele_favorite: Option<String> = None;
    if activity_owned.is_none() {
        let (act, tok, fav) = telemetry_fallback();
        if !act.is_empty() {
            activity_owned = Some(act);
        }
        tele_tokens = tok;
        tele_favorite = fav;
    }
    let activity: Option<&HashMap<String, f64>> = activity_owned.as_ref();

    // --- Heatmap: last HEATMAP_DAYS days ascending, missing filled with 0. ---
    let mut heatmap = Vec::with_capacity(HEATMAP_DAYS as usize);
    for offset in (0..HEATMAP_DAYS).rev() {
        let day = today - offset;
        let date = date_string(day);
        let count = activity
            .and_then(|a| a.get(&date))
            .map(|v| v.round() as i64)
            .unwrap_or(0);
        heatmap.push(json!({ "date": date, "count": count }));
    }

    // --- Streaks + active windows over the full activity history. ---
    let mut current_streak: i64 = 0;
    let mut longest_streak: i64 = 0;
    let mut active7d: i64 = 0;
    let mut active30d: i64 = 0;

    if let Some(act) = activity {
        // Build a set of active epoch-days (count > 0).
        let active_days: std::collections::HashSet<i64> = act
            .iter()
            .filter(|(_, &v)| v > 0.0)
            .filter_map(|(k, _)| day_number(k))
            .collect();

        // Current streak: consecutive active days ending today (or yesterday, so
        // a not-yet-active "today" doesn't break an ongoing run).
        let start = if active_days.contains(&today) {
            today
        } else {
            today - 1
        };
        let mut d = start;
        while active_days.contains(&d) {
            current_streak += 1;
            d -= 1;
        }

        // Longest streak: scan sorted days for the longest consecutive run.
        let mut sorted: Vec<i64> = active_days.iter().copied().collect();
        sorted.sort_unstable();
        let mut run = 0i64;
        let mut prev: Option<i64> = None;
        for day in sorted {
            run = match prev {
                Some(p) if day == p + 1 => run + 1,
                _ => 1,
            };
            longest_streak = longest_streak.max(run);
            prev = Some(day);
        }

        // Active days within the trailing 7 / 30 day windows (inclusive of today).
        for &day in &active_days {
            let age = today - day;
            if (0..7).contains(&age) {
                active7d += 1;
            }
            if (0..30).contains(&age) {
                active30d += 1;
            }
        }
    }

    // --- Totals + favorite model + token total. ---
    // Sessions/messages/firstSessionDate only exist in the on-disk cache (ccusage
    // daily has no such counts), so read them there; null when no cache.
    let (total_sessions, total_messages, first_session_date) = match &cache {
        Some(c) => (
            c.total_sessions.map(|v| v as i64),
            c.total_messages.map(|v| v as i64),
            c.first_session_date.clone(),
        ),
        None => (None, None, None),
    };

    // Favorite model: prefer the cache's token-weighted modelUsage; if that's
    // empty/absent, fall back to the most-frequently-used model from ccusage.
    let favorite_model = cache
        .as_ref()
        .and_then(|c| {
            c.model_usage
                .iter()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(id, _)| pretty_model(id))
        })
        .or_else(|| {
            live.as_ref().and_then(|l| {
                l.model_freq
                    .iter()
                    .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
                    .map(|(id, _)| pretty_model(id))
            })
        })
        .or_else(|| tele_favorite.as_deref().map(pretty_model));

    // Token total: prefer LIVE ccusage grand total, fall back to the cache.
    let tokens_total: Option<i64> = live
        .as_ref()
        .and_then(|l| l.tokens_total)
        .or_else(|| cache.as_ref().and_then(|c| c.tokens_total))
        .or(tele_tokens)
        .map(|t| t.round() as i64);

    json!({
        "totalSessions": total_sessions,
        "totalMessages": total_messages,
        "favoriteModel": favorite_model,
        "tokensTotal": tokens_total,
        "firstSessionDate": first_session_date,
        "currentStreak": current_streak,
        "longestStreak": longest_streak,
        "active7d": active7d,
        "active30d": active30d,
        "heatmap": heatmap,
    })
}
