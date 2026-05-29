//! AIOS oracle roster — read-only discovery of bridge-managed oracle sessions.
//!
//! Enumerates `aios-*` tmux sessions on socket `adletic` and enriches them from
//! `~/.aios/instances.json`. The AIOS bridge (launchd) keeps these sessions
//! alive; the cockpit only attaches/views.

use serde::{Deserialize, Serialize};

/// One oracle in the roster, surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct OracleInfo {
    /// Identity slug, e.g. `firaz` (from session `aios-firaz`).
    pub identity: String,
    /// Full tmux session name, e.g. `aios-firaz`.
    pub session: String,
    /// Human label from instances.json, falling back to the identity.
    pub display_name: String,
    /// Whether a client is currently attached to this session.
    pub attached: bool,
}

/// Shape of an entry in `~/.aios/instances.json` (written by the bridge).
#[derive(Debug, Deserialize)]
struct Instance {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
}

/// Resolves a usable `tmux` binary. GUI apps inherit a minimal PATH, so prefer
/// known Homebrew/system locations before falling back to bare `tmux`.
pub fn tmux_bin() -> String {
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

/// Reads the bridge's instance registry; missing/invalid → empty.
fn read_instances() -> Vec<Instance> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let path = std::path::PathBuf::from(home).join(".aios/instances.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<Instance>>(&text).unwrap_or_default()
}

/// Lists oracle tmux sessions on the `adletic` socket (Unix only).
/// Returns an empty list (not an error) when there is no server/session yet.
#[tauri::command]
pub fn list_oracles() -> Result<Vec<OracleInfo>, String> {
    #[cfg(unix)]
    {
        let output = std::process::Command::new(tmux_bin())
            .args([
                "-L",
                "adletic",
                "list-sessions",
                "-F",
                "#{session_name}|#{session_attached}",
            ])
            .output()
            .map_err(|e| format!("failed to run tmux: {e}"))?;

        if !output.status.success() {
            return Ok(Vec::new());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let instances = read_instances();
        let mut oracles: Vec<OracleInfo> = Vec::new();

        for line in stdout.lines() {
            let mut parts = line.splitn(2, '|');
            let session = parts.next().unwrap_or("").trim().to_string();
            let attached = parts.next().unwrap_or("0").trim() != "0";

            if !session.starts_with("aios-") {
                continue;
            }
            let identity = session.trim_start_matches("aios-").to_string();

            let inst = instances.iter().find(|i| {
                let id = i.id.to_lowercase();
                id == session.to_lowercase()
                    || id == identity.to_lowercase()
                    || i.name.to_lowercase() == identity.to_lowercase()
            });
            let display_name = inst
                .map(|i| i.name.clone())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| identity.clone());

            oracles.push(OracleInfo {
                identity,
                session,
                display_name,
                attached,
            });
        }

        oracles.sort_by(|a, b| a.identity.cmp(&b.identity));
        Ok(oracles)
    }

    #[cfg(not(unix))]
    {
        Ok(Vec::new())
    }
}
