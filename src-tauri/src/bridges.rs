//! BRIDGES health surface — is each external-channel bridge ALIVE, and what's
//! it been doing lately, at a glance.
//!
//! A "bridge" here is a long-running process that connects AIOS to an external
//! channel (WhatsApp today; more to come). For each bridge we probe THREE
//! read-only macOS sources, each independently best-effort — any source failing
//! yields an empty field, never an error for the whole call:
//!
//!   1. process liveness — `/bin/ps -axo pid,etime,command`, matched against a
//!      set of command substrings (e.g. `inbox-worker`, `push.js`,
//!      `meta-webhook`, `aios-bridge`/`aios/bridge`). First match gives pid +
//!      elapsed time (uptime).
//!   2. launchd — `/bin/launchctl list` lines whose label matches `*bridge*`
//!      → loaded + running (has a live pid).
//!   3. activity log — the first existing `outbound-log.jsonl` from a probe
//!      list. From it: total line count (≈ messages sent), the timestamp of the
//!      LAST entry (parsed from a `ts`/`timestamp`/`time` field), "X ago", and
//!      today's entry count.
//!
//! Designed to be EXTENSIBLE: a `BridgeProbe` descriptor describes one bridge;
//! `bridge_probes()` returns the list. Adding a second bridge later = pushing
//! another descriptor — `list_bridges` maps over them uniformly.
//!
//! Mirrors the clean, commented style of `oracles.rs` / `automations.rs`. No new
//! deps: `chrono` for timestamp math, `serde_json` for the output shape.

use serde_json::{json, Value};

/// `$HOME`, or `/` as a last resort.
fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// Static descriptor for one bridge. Add a new bridge = add one of these to
/// `bridge_probes()` — everything downstream maps over the list uniformly.
struct BridgeProbe {
    /// Stable slug, e.g. `whatsapp`.
    id: &'static str,
    /// Human label, e.g. `WhatsApp bridge`.
    name: &'static str,
    /// Channel type chip, e.g. `whatsapp`.
    kind: &'static str,
    /// Command substrings that identify the bridge process(es) in `ps` output.
    /// First matching process wins (pid + uptime).
    proc_match: &'static [&'static str],
    /// Substring a `launchctl list` LABEL must contain to count as this bridge's
    /// job (matched case-insensitively against `*bridge*`-style labels).
    launchd_match: &'static str,
    /// Candidate activity-log paths (relative to `$HOME` if not absolute),
    /// probed in order — first that exists is used.
    log_candidates: &'static [&'static str],
}

/// The registry of known bridges. WhatsApp today; push more here later.
fn bridge_probes() -> Vec<BridgeProbe> {
    vec![BridgeProbe {
        id: "whatsapp",
        name: "WhatsApp bridge",
        kind: "whatsapp",
        proc_match: &["inbox-worker", "push.js", "meta-webhook", "aios-bridge", "aios/bridge"],
        launchd_match: "bridge",
        log_candidates: &[
            "Repo/firaz/aios/bridge/scripts/outbound-log.jsonl",
            "Repo/firaz/aios-bridge/scripts/outbound-log.jsonl",
            ".aios/state/outbound-log.jsonl",
        ],
    }]
}

// ════════════════════════════════════════════════════════════════════════
// 1. process liveness
// ════════════════════════════════════════════════════════════════════════

/// One matched bridge process: pid + a humanized uptime.
struct ProcHit {
    pid: i64,
    uptime: String,
}

/// Runs `ps -axo pid,etime,command` and returns the first process whose command
/// contains any of `needles`. Best-effort → `None` on any failure / no match.
fn find_process(needles: &[&str]) -> Option<ProcHit> {
    #[cfg(unix)]
    {
        let out = std::process::Command::new("/bin/ps")
            .args(["-axo", "pid,etime,command"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines().skip(1) {
            // Columns: PID ELAPSED COMMAND… — split off the first two tokens,
            // the rest (which may contain spaces) is the command.
            let trimmed = line.trim_start();
            let mut it = trimmed.splitn(3, char::is_whitespace);
            let pid_raw = it.next().unwrap_or("");
            let etime_raw = it.next().unwrap_or("");
            let command = it.next().unwrap_or("");
            if command.is_empty() {
                continue;
            }
            // Don't match our own grep/probe or other false positives — require
            // the needle in the COMMAND portion only.
            if needles.iter().any(|n| command.contains(n)) {
                let Ok(pid) = pid_raw.parse::<i64>() else { continue };
                return Some(ProcHit { pid, uptime: humanize_etime(etime_raw) });
            }
        }
        None
    }

    #[cfg(not(unix))]
    {
        let _ = needles;
        None
    }
}

/// Converts a `ps` ETIME field (`[[dd-]hh:]mm:ss`) into "3h 12m" / "12m" /
/// "5d 3h" / "<1m". Unparseable → the raw string trimmed.
fn humanize_etime(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    // Split optional "dd-" day prefix.
    let (days, hms) = match raw.split_once('-') {
        Some((d, rest)) => (d.parse::<i64>().unwrap_or(0), rest),
        None => (0, raw),
    };
    // hms is one of mm:ss or hh:mm:ss.
    let parts: Vec<i64> = hms.split(':').map(|p| p.parse::<i64>().unwrap_or(0)).collect();
    let (hours, mins) = match parts.len() {
        3 => (parts[0], parts[1]),
        2 => (0, parts[0]),
        _ => return raw.to_string(),
    };
    let total_h = days * 24 + hours;
    if days > 0 {
        format!("{days}d {hours}h")
    } else if total_h > 0 {
        format!("{total_h}h {mins}m")
    } else if mins > 0 {
        format!("{mins}m")
    } else {
        "<1m".into()
    }
}

// ════════════════════════════════════════════════════════════════════════
// 2. launchd
// ════════════════════════════════════════════════════════════════════════

/// launchd state for a bridge: `(label, loaded, running)`.
struct LaunchdHit {
    label: String,
    running: bool,
}

/// Runs `launchctl list` and finds the first job whose label contains both
/// `bridge` and the bridge's `launchd_match` substring. `running` = it has a
/// live pid (not `-`). Best-effort → `None`.
fn find_launchd(needle: &str) -> Option<LaunchdHit> {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("/bin/launchctl").arg("list").output();
        let out = match output {
            Ok(o) if o.status.success() => o,
            _ => std::process::Command::new("launchctl").arg("list").output().ok()?,
        };
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let needle_l = needle.to_lowercase();
        // Columns: PID(or `-`)\tEXIT\tLABEL. Skip the header line.
        for line in text.lines().skip(1) {
            let mut cols = line.split('\t');
            let pid_raw = cols.next().unwrap_or("-").trim();
            let _exit = cols.next();
            let label = cols.next().unwrap_or("").trim();
            let label_l = label.to_lowercase();
            if label.is_empty() || !label_l.contains("bridge") || !label_l.contains(&needle_l) {
                continue;
            }
            let running = pid_raw != "-" && pid_raw.parse::<i64>().is_ok();
            return Some(LaunchdHit { label: label.to_string(), running });
        }
        None
    }

    #[cfg(not(unix))]
    {
        let _ = needle;
        None
    }
}

// ════════════════════════════════════════════════════════════════════════
// 3. activity log
// ════════════════════════════════════════════════════════════════════════

/// Parsed activity from a bridge's outbound log.
struct LogStats {
    path: String,
    messages_total: i64,
    last_activity: Option<String>,
    last_activity_ago: Option<String>,
    today: Option<i64>,
}

/// Resolves the first existing candidate path (absolute, or relative to HOME).
fn resolve_log(candidates: &[&str]) -> Option<String> {
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

/// Reads the outbound log: total lines (≈ messages), last entry's timestamp,
/// "X ago", and today's count. Best-effort — a missing/garbage log yields the
/// counts it can and `None` for the rest.
fn read_log(candidates: &[&str]) -> Option<LogStats> {
    let path = resolve_log(candidates)?;
    let Ok(text) = std::fs::read_to_string(&path) else {
        // Path existed but unreadable — still surface it with empty data.
        return Some(LogStats {
            path,
            messages_total: 0,
            last_activity: None,
            last_activity_ago: None,
            today: None,
        });
    };

    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let messages_total = lines.len() as i64;

    // Last entry's timestamp — parse the last JSON line, try a few key names.
    let mut last_activity = None;
    let mut last_activity_ago = None;
    if let Some(last) = lines.last() {
        if let Some(ts) = extract_timestamp(last) {
            last_activity = Some(format_local(&ts));
            last_activity_ago = humanize_ago(&ts);
        }
    }

    // Today's count — compare each entry's local date to today's local date.
    let today_str = chrono::Local::now().format("%Y-%m-%d").to_string();
    let today = lines
        .iter()
        .filter(|l| {
            extract_timestamp(l)
                .map(|ts| ts.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string() == today_str)
                .unwrap_or(false)
        })
        .count() as i64;

    Some(LogStats {
        path,
        messages_total,
        last_activity,
        last_activity_ago,
        today: Some(today),
    })
}

/// Pulls a timestamp out of a JSON log line, trying common key names
/// (`ts`/`timestamp`/`time`/`date`/`at`), and parses it as RFC3339. Falls back
/// to a Unix epoch (seconds or millis) if the value is numeric.
fn extract_timestamp(line: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = v.as_object()?;
    let raw = obj
        .get("ts")
        .or_else(|| obj.get("timestamp"))
        .or_else(|| obj.get("time"))
        .or_else(|| obj.get("date"))
        .or_else(|| obj.get("at"))?;

    // String → RFC3339 / ISO 8601.
    if let Some(s) = raw.as_str() {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
            return Some(dt.with_timezone(&chrono::Utc));
        }
    }
    // Number → epoch seconds or millis.
    if let Some(n) = raw.as_i64() {
        let (secs, nanos) = if n > 100_000_000_000 {
            (n / 1000, ((n % 1000) * 1_000_000) as u32)
        } else {
            (n, 0)
        };
        if let chrono::LocalResult::Single(dt) = chrono::TimeZone::timestamp_opt(&chrono::Utc, secs, nanos) {
            return Some(dt);
        }
    }
    None
}

/// Renders a UTC instant as local "YYYY-MM-DD HH:MM".
fn format_local(ts: &chrono::DateTime<chrono::Utc>) -> String {
    ts.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string()
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

// ════════════════════════════════════════════════════════════════════════
// assembly
// ════════════════════════════════════════════════════════════════════════

/// Probes a single bridge across all three sources and returns its descriptor.
fn probe_bridge(p: &BridgeProbe) -> Value {
    let proc_hit = find_process(p.proc_match);
    let launchd_hit = find_launchd(p.launchd_match);
    let log = read_log(p.log_candidates);

    // ALIVE = a live process, OR launchd reports it running.
    let alive = proc_hit.is_some() || launchd_hit.as_ref().map(|l| l.running).unwrap_or(false);

    let pid = proc_hit.as_ref().map(|h| h.pid);
    let uptime = proc_hit
        .as_ref()
        .map(|h| h.uptime.clone())
        .filter(|u| !u.is_empty());

    let launchd = launchd_hit.as_ref().map(|l| l.label.clone());
    let loaded = launchd_hit.is_some();

    let (messages_total, last_activity, last_activity_ago, today, log_path) = match &log {
        Some(s) => (
            Some(s.messages_total),
            s.last_activity.clone(),
            s.last_activity_ago.clone(),
            s.today,
            Some(s.path.clone()),
        ),
        None => (None, None, None, None, None),
    };

    json!({
        "id": p.id,
        "name": p.name,
        "kind": p.kind,
        "alive": alive,
        "pid": pid,
        "uptime": uptime,
        "launchd": launchd,
        "loaded": loaded,
        "messagesTotal": messages_total,
        "lastActivity": last_activity,
        "lastActivityAgo": last_activity_ago,
        "today": today,
        "logPath": log_path,
    })
}

/// Lists every known bridge with its health + recent activity. The whole call is
/// best-effort: each source per-bridge fails soft to an empty field, never an
/// error. Returns `{ "bridges": [ … ] }` so future bridges slot straight in.
#[tauri::command]
pub fn list_bridges() -> Value {
    let bridges: Vec<Value> = bridge_probes().iter().map(probe_bridge).collect();
    json!({ "bridges": bridges })
}
