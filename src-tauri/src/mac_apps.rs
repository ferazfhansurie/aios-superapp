//! Running mac apps as AIOS attach targets.
//!
//! This is intentionally conservative. macOS does not support reliably
//! reparenting arbitrary native app windows into a Tauri webview. The useful
//! first layer is inventory + focus/control: list visible apps, expose their
//! bundle ids, focus them on demand, best-effort window titles when
//! Accessibility permits it, and screen-capture previews when Screen Recording
//! permits it.

use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(serde::Serialize)]
pub struct MacAppInfo {
    pub name: String,
    pub bundle_id: Option<String>,
    pub windows: Vec<String>,
    pub window_error: Option<String>,
}

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

fn split_apple_list(raw: &str) -> Vec<String> {
    raw.split(", ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn apple_quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn app_windows(name: &str) -> (Vec<String>, Option<String>) {
    let script = format!(
        "tell application \"System Events\" to tell application process \"{}\" to get name of every window",
        apple_quote(name),
    );
    match osascript(&script) {
        Ok(raw) => (split_apple_list(&raw), None),
        Err(e) => (Vec::new(), Some(e)),
    }
}

#[tauri::command]
pub fn mac_list_apps() -> Result<Vec<MacAppInfo>, String> {
    let names = split_apple_list(&osascript(
        "tell application \"System Events\" to get name of every application process whose background only is false",
    )?);
    let bundle_ids = split_apple_list(&osascript(
        "tell application \"System Events\" to get bundle identifier of every application process whose background only is false",
    )?);

    Ok(names
        .into_iter()
        .enumerate()
        .map(|(idx, name)| {
            let bundle_id = bundle_ids
                .get(idx)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && s != "missing value");
            let (windows, window_error) = app_windows(&name);
            MacAppInfo {
                name,
                bundle_id,
                windows,
                window_error,
            }
        })
        .collect())
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
