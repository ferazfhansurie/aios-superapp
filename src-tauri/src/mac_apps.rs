//! Running mac apps as AIOS attach targets.
//!
//! This is intentionally conservative. macOS does not support reliably
//! reparenting arbitrary native app windows into a Tauri webview. The useful
//! first layer is inventory + focus/control: list visible apps, expose their
//! bundle ids, focus them on demand, best-effort window titles when
//! Accessibility permits it, and screen-capture previews when Screen Recording
//! permits it.

use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(serde::Serialize, Clone)]
pub struct MacAppInfo {
    pub name: String,
    pub bundle_id: Option<String>,
    pub windows: Vec<String>,
    pub window_error: Option<String>,
}

/// Short-lived cache for the (expensive) running-apps enumeration. The pane polls
/// on a timer + has a manual refresh button; without this, every tick re-spawned
/// osascript. A few seconds of staleness is invisible for an app list, and it
/// collapses bursty refreshes (poll + manual tap landing together) into one scan.
const APPS_CACHE_TTL: Duration = Duration::from_secs(5);

struct AppsCache {
    at: Instant,
    apps: Vec<MacAppInfo>,
}

static APPS_CACHE: Mutex<Option<AppsCache>> = Mutex::new(None);

fn osascript(script: &str) -> Result<String, String> {
    let out = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("osascript exited with {}", out.status)
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn apple_quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// ASCII control chars used as delimiters in the combined-script output. App and
/// window titles routinely contain commas/spaces, so the old ", " split was
/// already fragile — these can't appear in window/app names.
const REC_SEP: char = '\u{1e}'; // between processes
const FIELD_SEP: &str = "\u{1f}"; // name / bundle / windows-blob within a process
const WIN_SEP: &str = "\u{1d}"; // between window titles

/// Enumerates running (non-background) apps with their bundle ids AND window
/// titles in a SINGLE osascript pass.
///
/// Idle-CPU fix: the old path spawned osascript twice (names, then bundle ids)
/// PLUS once per app for window titles — 40+ process spawns per poll on a busy
/// desktop. This walks every process once in one script, building a delimited
/// record per app. Window titles still need Accessibility; if that's denied the
/// inner `try` yields an empty blob and we surface the usual hint per app rather
/// than failing the whole list.
fn enumerate_apps_uncached() -> Result<Vec<MacAppInfo>, String> {
    // One pass over the process list. For each process emit:
    //   name <FIELD_SEP> bundleId <FIELD_SEP> win1 <WIN_SEP> win2 …
    // records joined by <REC_SEP>. Window enumeration is wrapped in try so a
    // single AX-restricted app can't abort the whole scan.
    let script = format!(
        r#"set fs to (ASCII character 31)
set rs to (ASCII character 30)
set ws to (ASCII character 29)
set outv to ""
tell application "System Events"
  set procs to (every application process whose background only is false)
  repeat with p in procs
    set pname to name of p
    try
      set bid to bundle identifier of p
    on error
      set bid to ""
    end try
    if bid is missing value then set bid to ""
    set wins to ""
    try
      set wnames to name of every window of p
      repeat with w in wnames
        if wins is not "" then set wins to wins & ws
        set wins to wins & (w as string)
      end repeat
    end try
    if outv is not "" then set outv to outv & rs
    set outv to outv & pname & fs & bid & fs & wins
  end repeat
end tell
return outv"#,
    );

    let raw = osascript(&script)?;
    let mut apps = Vec::new();
    for rec in raw.split(REC_SEP) {
        if rec.trim().is_empty() {
            continue;
        }
        let mut fields = rec.splitn(3, FIELD_SEP);
        let name = fields.next().unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        let bundle_id = fields
            .next()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "missing value");
        let win_blob = fields.next().unwrap_or("");
        let windows: Vec<String> = win_blob
            .split(WIN_SEP)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        apps.push(MacAppInfo {
            name,
            bundle_id,
            windows,
            // Per-app window errors are no longer distinguishable in the single
            // pass; the frontend already shows a generic "needs accessibility"
            // hint when an app has no windows, which covers the AX-denied case.
            window_error: None,
        });
    }
    Ok(apps)
}

#[tauri::command]
pub fn mac_list_apps() -> Result<Vec<MacAppInfo>, String> {
    // Serve from cache if fresh — collapses bursty refreshes into one scan.
    if let Ok(guard) = APPS_CACHE.lock() {
        if let Some(c) = guard.as_ref() {
            if c.at.elapsed() < APPS_CACHE_TTL {
                return Ok(c.apps.clone());
            }
        }
    }

    let apps = enumerate_apps_uncached()?;

    if let Ok(mut guard) = APPS_CACHE.lock() {
        *guard = Some(AppsCache {
            at: Instant::now(),
            apps: apps.clone(),
        });
    }
    Ok(apps)
}

#[tauri::command]
pub fn mac_focus_app(name: String, bundle_id: Option<String>) -> Result<(), String> {
    if let Some(bundle) = bundle_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let status = Command::new("/usr/bin/open")
            .arg("-b")
            .arg(bundle)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
    }

    let script = format!("tell application \"{}\" to activate", apple_quote(&name));
    osascript(&script).map(|_| ())
}

#[tauri::command]
pub fn mac_capture_app(name: String, bundle_id: Option<String>) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (name, bundle_id);
        return Err("external app capture is macos-only right now".into());
    }

    #[cfg(target_os = "macos")]
    {
        mac_focus_app(name, bundle_id)?;
        thread::sleep(Duration::from_millis(350));

        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let path = format!("/tmp/aios-app-capture-{epoch}.png");
        let status = Command::new("/usr/sbin/screencapture")
            .arg("-x")
            .arg(&path)
            .status()
            .map_err(|e| format!("screencapture failed to launch: {e}"))?;
        if !status.success() {
            return Err(format!(
                "screencapture exited with {} (check Screen Recording permission)",
                status.code().unwrap_or(-1)
            ));
        }
        Ok(path)
    }
}
