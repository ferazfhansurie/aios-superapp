//! Automations surface — everything AIOS runs in the background, at a glance.
//!
//! Three read-only sources, each independently best-effort (a failing source
//! yields an empty section, never an error for the whole call):
//!
//!   1. `launchd` jobs — `launchctl list` filtered to `com.firaz.aios-*` /
//!      `com.aios.*`. Each label's plist in `~/Library/LaunchAgents/` is parsed
//!      for its command (ProgramArguments) and schedule (StartInterval /
//!      StartCalendarInterval / RunAtLoad / KeepAlive), rendered to a human
//!      string like "every 15m", "daily 00:15", "at load", "always on".
//!   2. proactive plan — `~/.aios/state/proactive/tomorrow-plan.json`, the timed
//!      interventions designed by the nightly planner, surfaced as today's plan.
//!   3. background sessions — `aios-*` tmux sessions on socket `adletic`, the
//!      live agents (with attached state).
//!
//! Mirrors the clean, commented style of `oracles.rs` / `files.rs`. No new deps:
//! the plist is XML, parsed with a tiny purpose-built scanner (no plist crate).

use serde_json::{json, Value};

/// The tmux socket the bridge runs background oracle sessions on.
const ORACLE_SOCKET: &str = "adletic";

/// Resolves a usable `tmux` binary. GUI apps inherit a minimal PATH, so prefer
/// known Homebrew/system locations before falling back to bare `tmux`.
fn tmux_bin() -> String {
    #[cfg(unix)]
    {
        for candidate in ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"] {
            if std::path::Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
    }
    "tmux".to_string()
}

/// `$HOME`, or `/` as a last resort.
fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// True for the AIOS labels we care about.
fn is_aios_label(label: &str) -> bool {
    label.starts_with("com.firaz.aios-") || label.starts_with("com.aios.")
}

// ════════════════════════════════════════════════════════════════════════
// 1. launchd jobs
// ════════════════════════════════════════════════════════════════════════

/// Parsed schedule + command for one launchd plist.
struct PlistInfo {
    command: String,
    schedule: String,
}

/// Reads `~/Library/LaunchAgents/<label>.plist` and extracts the command
/// (joined ProgramArguments) plus a human schedule string. Missing/unparseable
/// → empty command + "unknown" schedule (never errors).
fn read_plist(label: &str) -> PlistInfo {
    let path = format!("{}/Library/LaunchAgents/{label}.plist", home());
    let Ok(xml) = std::fs::read_to_string(&path) else {
        return PlistInfo { command: String::new(), schedule: "unknown".into() };
    };

    let command = parse_program_arguments(&xml);
    let schedule = parse_schedule(&xml);
    PlistInfo { command, schedule }
}

/// Pulls the `<string>` values out of the `ProgramArguments` `<array>` and joins
/// them with spaces. We only need the gist — the script being run.
fn parse_program_arguments(xml: &str) -> String {
    let Some(block) = slice_after_key_array(xml, "ProgramArguments") else {
        return String::new();
    };
    let mut args: Vec<String> = Vec::new();
    let mut rest = block;
    while let Some(start) = rest.find("<string>") {
        let after = &rest[start + "<string>".len()..];
        let Some(end) = after.find("</string>") else { break };
        args.push(unescape_xml(after[..end].trim()));
        rest = &after[end + "</string>".len()..];
    }
    args.join(" ")
}

/// Returns the slice of `xml` BETWEEN the `<array>`…`</array>` that immediately
/// follows `<key>NAME</key>` — i.e. the array body for that key.
fn slice_after_key_array<'a>(xml: &'a str, key: &str) -> Option<&'a str> {
    let key_tag = format!("<key>{key}</key>");
    let key_pos = xml.find(&key_tag)?;
    let after = &xml[key_pos + key_tag.len()..];
    let arr_start = after.find("<array>")?;
    let body = &after[arr_start + "<array>".len()..];
    let arr_end = body.find("</array>")?;
    Some(&body[..arr_end])
}

/// Returns the slice of `xml` BETWEEN the `<dict>`…`</dict>` that immediately
/// follows `<key>NAME</key>` — the dict body for that key.
fn slice_after_key_dict<'a>(xml: &'a str, key: &str) -> Option<&'a str> {
    let key_tag = format!("<key>{key}</key>");
    let key_pos = xml.find(&key_tag)?;
    let after = &xml[key_pos + key_tag.len()..];
    let d_start = after.find("<dict>")?;
    let body = &after[d_start + "<dict>".len()..];
    let d_end = body.find("</dict>")?;
    Some(&body[..d_end])
}

/// Reads the `<integer>` value that immediately follows `<key>NAME</key>`.
fn integer_for_key(xml: &str, key: &str) -> Option<i64> {
    let key_tag = format!("<key>{key}</key>");
    let key_pos = xml.find(&key_tag)?;
    let after = &xml[key_pos + key_tag.len()..];
    let start = after.find("<integer>")?;
    let body = &after[start + "<integer>".len()..];
    let end = body.find("</integer>")?;
    body[..end].trim().parse().ok()
}

/// True when `<key>NAME</key>` is followed by `<true/>` before any `<false/>`.
fn bool_for_key(xml: &str, key: &str) -> bool {
    let key_tag = format!("<key>{key}</key>");
    let Some(pos) = xml.find(&key_tag) else { return false };
    let after = &xml[pos + key_tag.len()..];
    // Look only at the immediate value region (next ~60 chars is plenty).
    let window = &after[..after.len().min(64)];
    let t = window.find("<true/>");
    let f = window.find("<false/>");
    match (t, f) {
        (Some(ti), Some(fi)) => ti < fi,
        (Some(_), None) => true,
        _ => false,
    }
}

/// Turns the various scheduling keys into a single human string.
fn parse_schedule(xml: &str) -> String {
    // StartInterval (seconds) → "every Nm" / "every Nh" / "every Ns".
    if let Some(secs) = integer_for_key(xml, "StartInterval") {
        return humanize_interval(secs);
    }

    // StartCalendarInterval — either a single <dict> or an <array> of <dict>s.
    if xml.contains("<key>StartCalendarInterval</key>") {
        if let Some(s) = parse_calendar_intervals(xml) {
            return s;
        }
    }

    // KeepAlive (bool or dict) → long-running daemon.
    if xml.contains("<key>KeepAlive</key>")
        && (bool_for_key(xml, "KeepAlive") || keepalive_is_dict(xml))
    {
        return "always on (KeepAlive)".into();
    }

    // RunAtLoad with no other trigger → fires once when loaded.
    if bool_for_key(xml, "RunAtLoad") {
        return "at load".into();
    }

    "manual".into()
}

/// KeepAlive may be a `<dict>` of conditions rather than a plain bool.
fn keepalive_is_dict(xml: &str) -> bool {
    let key = "<key>KeepAlive</key>";
    let Some(pos) = xml.find(key) else { return false };
    let after = &xml[pos + key.len()..];
    let window = &after[..after.len().min(64)];
    window.find("<dict>").map_or(false, |d| {
        window.find("<true/>").map_or(true, |t| d < t)
    })
}

/// Renders a StartInterval (seconds) as "every 15m" etc.
fn humanize_interval(secs: i64) -> String {
    if secs <= 0 {
        return "manual".into();
    }
    if secs % 3600 == 0 {
        format!("every {}h", secs / 3600)
    } else if secs % 60 == 0 {
        format!("every {}m", secs / 60)
    } else {
        format!("every {secs}s")
    }
}

/// Parses one-or-many StartCalendarInterval dicts into a string like
/// "daily 00:15", "06:00", "weekly (sun) 21:00", or "min :30".
fn parse_calendar_intervals(xml: &str) -> Option<String> {
    // Collect every <dict>…</dict> that appears AFTER the key tag. For the
    // common single-dict and array-of-dicts cases this captures all of them.
    let key = "<key>StartCalendarInterval</key>";
    let pos = xml.find(key)?;
    let mut rest = &xml[pos + key.len()..];

    // Stop scanning once we hit the NEXT top-level key (so we don't bleed into
    // unrelated dicts further down the plist).
    if let Some(next_key) = rest.find("<key>") {
        // Only clamp if there's an intervening dict close before that key —
        // otherwise the array body legitimately contains nested dicts.
        if let Some(arr_end) = rest.find("</array>") {
            if arr_end < next_key {
                rest = &rest[..arr_end];
            } else {
                rest = &rest[..next_key];
            }
        } else {
            rest = &rest[..next_key];
        }
    }

    let mut parts: Vec<String> = Vec::new();
    let mut scan = rest;
    while let Some(ds) = scan.find("<dict>") {
        let body = &scan[ds + "<dict>".len()..];
        let Some(de) = body.find("</dict>") else { break };
        let dict = &body[..de];
        parts.push(render_calendar_dict(dict));
        scan = &body[de + "</dict>".len()..];
    }

    if parts.is_empty() {
        return None;
    }
    if parts.len() == 1 {
        Some(parts.remove(0))
    } else {
        Some(format!("{} times/day ({})", parts.len(), parts.join(", ")))
    }
}

const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// Renders a single calendar-interval dict (Hour/Minute/Weekday/Day) to text.
fn render_calendar_dict(dict: &str) -> String {
    let hour = integer_for_key(dict, "Hour");
    let minute = integer_for_key(dict, "Minute");
    let weekday = integer_for_key(dict, "Weekday");
    let day = integer_for_key(dict, "Day");

    let time = match (hour, minute) {
        (Some(h), Some(m)) => format!("{h:02}:{m:02}"),
        (Some(h), None) => format!("{h:02}:00"),
        (None, Some(m)) => format!(":{m:02}"),
        (None, None) => String::new(),
    };

    if let Some(w) = weekday {
        let name = WEEKDAYS.get((w as usize) % 7).copied().unwrap_or("?");
        return format!("weekly ({name}) {time}").trim().to_string();
    }
    if let Some(d) = day {
        return format!("monthly (d{d}) {time}").trim().to_string();
    }
    match (hour, minute) {
        (Some(_), _) => format!("daily {time}"),
        (None, Some(_)) => format!("hourly {time}"),
        _ => "scheduled".into(),
    }
}

/// Minimal XML entity unescape for the bits we surface.
fn unescape_xml(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

/// Runs `launchctl list`, filters to AIOS labels, and joins each with its plist
/// detail. Best-effort: any failure → empty vec.
fn collect_jobs() -> Vec<Value> {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("/bin/launchctl")
            .arg("list")
            .output();
        let out = match output {
            Ok(o) if o.status.success() => o,
            // Fall back to PATH-resolved launchctl if the absolute path failed.
            _ => match std::process::Command::new("launchctl").arg("list").output() {
                Ok(o) if o.status.success() => o,
                _ => return Vec::new(),
            },
        };

        let text = String::from_utf8_lossy(&out.stdout);
        let mut jobs: Vec<Value> = Vec::new();

        // Columns: PID(or `-`)\tEXIT\tLABEL. First line is a header.
        for line in text.lines().skip(1) {
            let mut cols = line.split('\t');
            let pid_raw = cols.next().unwrap_or("-").trim();
            let exit_raw = cols.next().unwrap_or("0").trim();
            let label = cols.next().unwrap_or("").trim();
            if label.is_empty() || !is_aios_label(label) {
                continue;
            }

            let running = pid_raw != "-" && pid_raw.parse::<i64>().is_ok();
            let last_exit = exit_raw.parse::<i64>().unwrap_or(0);
            let info = read_plist(label);

            jobs.push(json!({
                "label": label,
                "command": info.command,
                "schedule": info.schedule,
                "running": running,
                "last_exit": last_exit,
            }));
        }

        // Sort: running first, then non-zero-exit (problems), then alpha.
        jobs.sort_by(|a, b| {
            let ar = a["running"].as_bool().unwrap_or(false);
            let br = b["running"].as_bool().unwrap_or(false);
            let ae = a["last_exit"].as_i64().unwrap_or(0) != 0;
            let be = b["last_exit"].as_i64().unwrap_or(0) != 0;
            br.cmp(&ar)
                .then(be.cmp(&ae))
                .then_with(|| {
                    a["label"]
                        .as_str()
                        .unwrap_or("")
                        .cmp(b["label"].as_str().unwrap_or(""))
                })
        });
        jobs
    }

    #[cfg(not(unix))]
    {
        Vec::new()
    }
}

// ════════════════════════════════════════════════════════════════════════
// 2. proactive plan
// ════════════════════════════════════════════════════════════════════════

/// Reads `~/.aios/state/proactive/tomorrow-plan.json` and surfaces its timed
/// interventions as `{ time, title }`. Tolerates either a bare array or an
/// object with a `plan`/`items`/`interventions` array. Best-effort → empty.
fn collect_planned() -> Vec<Value> {
    let path = format!("{}/.aios/state/proactive/tomorrow-plan.json", home());
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };

    // Find the array of items wherever it lives.
    let items: &Vec<Value> = if let Some(arr) = v.as_array() {
        arr
    } else if let Some(obj) = v.as_object() {
        match obj
            .get("plan")
            .or_else(|| obj.get("items"))
            .or_else(|| obj.get("interventions"))
            .and_then(|x| x.as_array())
        {
            Some(arr) => arr,
            None => return Vec::new(),
        }
    } else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            // Time: try common keys, fall back to empty.
            let time = obj
                .get("time")
                .or_else(|| obj.get("at"))
                .or_else(|| obj.get("when"))
                .or_else(|| obj.get("time_myt"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            // Title / story: first non-empty of several candidate keys.
            let title = obj
                .get("title")
                .or_else(|| obj.get("story"))
                .or_else(|| obj.get("intervention"))
                .or_else(|| obj.get("summary"))
                .or_else(|| obj.get("text"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if time.is_empty() && title.is_empty() {
                return None;
            }
            Some(json!({ "time": time, "title": title }))
        })
        .collect()
}

// ════════════════════════════════════════════════════════════════════════
// 3. background sessions (live agents)
// ════════════════════════════════════════════════════════════════════════

/// Lists `aios-*` tmux sessions on the oracle socket as live agents with their
/// attached state. Best-effort → empty.
fn collect_agents() -> Vec<Value> {
    #[cfg(unix)]
    {
        let output = std::process::Command::new(tmux_bin())
            .args([
                "-L",
                ORACLE_SOCKET,
                "list-sessions",
                "-F",
                "#{session_name}|#{session_attached}",
            ])
            .output();
        let Ok(out) = output else { return Vec::new() };
        if !out.status.success() {
            return Vec::new();
        }

        let mut agents: Vec<Value> = Vec::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let mut p = line.splitn(2, '|');
            let name = p.next().unwrap_or("").trim();
            if !name.starts_with("aios-") {
                continue;
            }
            let attached = p.next().unwrap_or("0").trim() != "0";
            agents.push(json!({ "name": name, "attached": attached }));
        }

        // Attached first, then alpha.
        agents.sort_by(|a, b| {
            let aa = a["attached"].as_bool().unwrap_or(false);
            let ba = b["attached"].as_bool().unwrap_or(false);
            ba.cmp(&aa).then_with(|| {
                a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
            })
        });
        agents
    }

    #[cfg(not(unix))]
    {
        Vec::new()
    }
}

/// Aggregates all three background-automation sources into one structured blob.
/// Every section is independently best-effort — a failing source yields an empty
/// array, the call itself never errors.
#[tauri::command]
pub fn list_automations() -> Value {
    json!({
        "jobs": collect_jobs(),
        "planned": collect_planned(),
        "agents": collect_agents(),
    })
}
