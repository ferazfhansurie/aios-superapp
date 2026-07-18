//! Live PM2 process monitor for the idle dashboard.
//!
//! On the bisnesgpt box (Ubuntu) there's a pm2 fleet (bisnesgpt, bisnesgpt-api
//! ×2, bisnesgpt-wwebjs, bisnesgpt-meta ×2, ajim-bot). On the laptop pm2 is
//! absent — in that case `pm2_list` returns an empty Vec and the frontend tile
//! renders nothing. Never panics, never Errs: any failure (no node, no pm2,
//! non-zero exit, unparseable JSON) yields an empty list so the idle screen is
//! never blanked.
//!
//! GUI-launched apps inherit a minimal PATH with no `node` (the known cockpit
//! gotcha — see stats.rs / monitor.rs), so we resolve `node` via
//! `crate::monitor::node_bin()` and run pm2's CLI as a node script
//! (`<node> <pm2-cli> jlist`), falling back to a bare `pm2 jlist`.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pm2Proc {
    pub name: String,
    pub status: String,
    pub cpu: f64,
    pub memory_mb: u64,
    pub restarts: u64,
    pub uptime_ms: u64,
    pub pid: u64,
    pub pm_id: u64,
}

/// Resolves a `pm2` CLI script path. Mirrors `monitor::node_bin()`'s probe
/// order: fixed locations first, then the newest nvm version dir.
fn pm2_cli() -> Option<String> {
    for candidate in ["/usr/local/bin/pm2", "/opt/homebrew/bin/pm2"] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    let home = std::env::var("HOME").ok()?;
    let nvm = format!("{home}/.nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm) {
        let mut versions: Vec<String> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path().join("bin/pm2"))
            .filter(|p| p.exists())
            .filter_map(|p| p.to_str().map(|s| s.to_string()))
            .collect();
        versions.sort();
        if let Some(latest) = versions.pop() {
            return Some(latest);
        }
    }
    None
}

/// Runs `pm2 jlist` and returns the parsed process list. Empty Vec on ANY
/// failure (no node, no pm2, non-zero exit, parse error) — the empty list is
/// the "pm2 absent" signal the frontend keys off, so the laptop renders nothing.
#[tauri::command]
pub fn pm2_list() -> Vec<Pm2Proc> {
    // Resolve `node` (GUI PATH is minimal) and the pm2 CLI script, then run
    // `node <pm2-cli> jlist`. Fall back to a bare `pm2 jlist` if either probe
    // misses (e.g. a dev shell with pm2 on PATH).
    let node = crate::monitor::node_bin();
    let cli = pm2_cli();

    let mut stdout: Option<Vec<u8>> = None;
    if let (Some(n), Some(c)) = (&node, &cli) {
        if let Ok(out) = std::process::Command::new(n).arg(c).arg("jlist").output() {
            if out.status.success() {
                stdout = Some(out.stdout);
            }
        }
    }
    if stdout.is_none() {
        if let Ok(out) = std::process::Command::new("pm2").arg("jlist").output() {
            if out.status.success() {
                stdout = Some(out.stdout);
            }
        }
    }

    let Some(bytes) = stdout else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    let Some(arr) = root.as_array() else {
        return Vec::new();
    };

    let mut procs = Vec::with_capacity(arr.len());
    for elem in arr {
        let env = elem.get("pm2_env");
        let monit = elem.get("monit");
        let name = elem
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let status = env
            .and_then(|e| e.get("status"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let cpu = monit
            .and_then(|m| m.get("cpu"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let memory_bytes = monit
            .and_then(|m| m.get("memory"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let restarts = env
            .and_then(|e| e.get("restart_time"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let uptime_ms = env
            .and_then(|e| e.get("pm_uptime"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let pid = elem.get("pid").and_then(|v| v.as_u64()).unwrap_or(0);
        let pm_id = elem.get("pm_id").and_then(|v| v.as_u64()).unwrap_or(0);

        procs.push(Pm2Proc {
            name,
            status,
            cpu,
            memory_mb: memory_bytes / 1_048_576,
            restarts,
            uptime_ms,
            pid,
            pm_id,
        });
    }
    procs
}
