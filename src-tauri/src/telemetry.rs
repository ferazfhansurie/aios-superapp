//! Claude Code JSONL telemetry — reads `~/.claude/projects/*/jsonl` and
//! aggregates into the shape the React sidebar consumes.
//!
//! Output shape (serde JSON):
//!   {
//!     totals: { tokens, sessions, messages, cache_hit_pct },
//!     streak: { current, longest, active_days_7d, active_days_30d, favorite_model },
//!     heatmap: [{ date: "YYYY-MM-DD", count: N }, ...]   // last 365 days
//!     quotas: { window_5h_pct, window_7d_pct }           // local-only estimate
//!   }
//!
//! Local-only — no Anthropic API call. We treat "active in last N hours" as a
//! cheap proxy for the 5-hour / 7-day rolling windows shown in Antigravity.

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use walkdir::WalkDir;

#[derive(Serialize, Default, Debug)]
pub struct Totals {
    pub tokens: u64,
    pub sessions: u64,
    pub messages: u64,
    pub cache_hit_pct: f64,
}

#[derive(Serialize, Default, Debug)]
pub struct Streak {
    pub current: u32,
    pub longest: u32,
    pub active_days_7d: u32,
    pub active_days_30d: u32,
    pub favorite_model: String,
}

#[derive(Serialize, Default, Debug)]
pub struct HeatmapCell {
    pub date: String,
    pub count: u64,
}

#[derive(Serialize, Default, Debug)]
pub struct Quotas {
    pub window_5h_pct: f64,
    pub window_7d_pct: f64,
}

#[derive(Serialize, Default, Debug)]
pub struct Telemetry {
    pub totals: Totals,
    pub streak: Streak,
    pub heatmap: Vec<HeatmapCell>,
    pub quotas: Quotas,
}

/// Walk `~/.claude/projects/**/*.jsonl` and aggregate.
/// Soft-fails: returns Default::default() if anything goes wrong.
pub fn collect() -> Telemetry {
    let home = match std::env::var("HOME") {
        Ok(h) => PathBuf::from(h),
        Err(_) => return Telemetry::default(),
    };
    let root = home.join(".claude").join("projects");
    if !root.is_dir() {
        return Telemetry::default();
    }

    let mut totals = Totals::default();
    let mut by_day: BTreeMap<NaiveDate, u64> = BTreeMap::new();
    let mut by_model: HashMap<String, u64> = HashMap::new();
    let mut cache_hits = 0u64;
    let mut cache_total = 0u64;
    let now = Utc::now();
    let mut tokens_5h = 0u64;
    let mut tokens_7d = 0u64;

    for entry in WalkDir::new(&root)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() || path.extension().map_or(true, |e| e != "jsonl") {
            continue;
        }
        totals.sessions += 1;
        let Ok(file) = std::fs::File::open(path) else {
            continue;
        };
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(file);
        for line in reader.lines().flatten() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            totals.messages += 1;
            let ts = v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Utc));
            // Token usage lives at message.usage.{input_tokens, output_tokens,
            // cache_creation_input_tokens, cache_read_input_tokens}.
            let usage = v.pointer("/message/usage");
            if let Some(u) = usage {
                let inp = u
                    .get("input_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                let out = u
                    .get("output_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                let creation = u
                    .get("cache_creation_input_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                let read = u
                    .get("cache_read_input_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                let row_total = inp + out + creation + read;
                totals.tokens += row_total;
                cache_hits += read;
                cache_total += inp + creation + read;
                if let Some(t) = ts {
                    let age = now - t;
                    if age <= Duration::hours(5) {
                        tokens_5h += row_total;
                    }
                    if age <= Duration::days(7) {
                        tokens_7d += row_total;
                    }
                    let d = t.date_naive();
                    *by_day.entry(d).or_insert(0) += 1;
                }
            }
            if let Some(model) = v.pointer("/message/model").and_then(|m| m.as_str()) {
                *by_model.entry(model.to_string()).or_insert(0) += 1;
            }
        }
    }

    totals.cache_hit_pct = if cache_total > 0 {
        (cache_hits as f64 / cache_total as f64) * 100.0
    } else {
        0.0
    };

    // Heatmap: last 365 days, zero-fill missing days.
    let mut heatmap = Vec::with_capacity(365);
    let today = now.date_naive();
    for i in (0..365).rev() {
        let d = today - Duration::days(i);
        let count = by_day.get(&d).copied().unwrap_or(0);
        heatmap.push(HeatmapCell {
            date: d.format("%Y-%m-%d").to_string(),
            count,
        });
    }

    // Streak: contiguous days back from today with > 0 activity.
    let mut current = 0u32;
    for cell in heatmap.iter().rev() {
        if cell.count > 0 {
            current += 1;
        } else {
            break;
        }
    }
    // Longest streak in window.
    let mut longest = 0u32;
    let mut run = 0u32;
    for cell in &heatmap {
        if cell.count > 0 {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let active_7d = heatmap.iter().rev().take(7).filter(|c| c.count > 0).count() as u32;
    let active_30d = heatmap.iter().rev().take(30).filter(|c| c.count > 0).count() as u32;
    let favorite = by_model
        .iter()
        .max_by_key(|(_, c)| *c)
        .map(|(k, _)| short_model_name(k))
        .unwrap_or_default();

    // Crude quota estimate: assume soft cap of 5M tokens / 5h, 50M / 7d.
    // Real Anthropic limits vary per plan — these defaults are a useful
    // visual signal until we wire to the Console API.
    const CAP_5H: f64 = 5_000_000.0;
    const CAP_7D: f64 = 50_000_000.0;
    let quotas = Quotas {
        window_5h_pct: (tokens_5h as f64 / CAP_5H * 100.0).min(100.0),
        window_7d_pct: (tokens_7d as f64 / CAP_7D * 100.0).min(100.0),
    };

    Telemetry {
        totals,
        streak: Streak {
            current,
            longest,
            active_days_7d: active_7d,
            active_days_30d: active_30d,
            favorite_model: favorite,
        },
        heatmap,
        quotas,
    }
}

fn short_model_name(full: &str) -> String {
    // "claude-sonnet-4-5-20250929" -> "Sonnet 4.5"
    let l = full.to_lowercase();
    if l.contains("opus") && l.contains("4-7") {
        return "Opus 4.7".into();
    }
    if l.contains("opus") {
        return "Opus".into();
    }
    if l.contains("sonnet-4-5") {
        return "Sonnet 4.5".into();
    }
    if l.contains("sonnet-4-6") {
        return "Sonnet 4.6".into();
    }
    if l.contains("sonnet") {
        return "Sonnet".into();
    }
    if l.contains("haiku") {
        return "Haiku".into();
    }
    full.to_string()
}
