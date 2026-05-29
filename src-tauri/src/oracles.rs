//! AIOS oracle roster + CRUD, and all-tmux discovery.
//!
//! Oracles are tmux sessions named `aios-<identity>` on socket `adletic`, kept
//! alive by the bridge (launchd). The cockpit can list, attach, create, rename
//! and delete them — except the MASTER oracle (`firaz`), which is permanent,
//! pinned to the top of the roster, and undeletable.
//!
//! It also enumerates EVERY live tmux session across the known sockets so any
//! terminal (including the one you're typing in right now) can be attached.

use serde::{Deserialize, Serialize};

/// The permanent MASTER (root) session — the mothership running at the root
/// home dir `/Users/firazfhansurie`, on its own socket. Always pinned top,
/// crowned, undeletable. This is NOT an `aios-*` bridge oracle.
const MASTER_SOCKET: &str = "aios";
const MASTER_SESSION: &str = "aios";
const MASTER_LABEL: &str = "master";

/// The tmux socket the bridge runs oracles on.
const ORACLE_SOCKET: &str = "adletic";

/// Sockets we scan for the all-tmux attach surface, in display order.
const KNOWN_SOCKETS: &[&str] = &["adletic", "aios", "default"];

/// One oracle in the roster, surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct OracleInfo {
    /// Identity slug, e.g. `firaz` (from session `aios-firaz`); `root` for master.
    pub identity: String,
    /// Full tmux session name, e.g. `aios-firaz` (or `aios` for master).
    pub session: String,
    /// The tmux socket this session lives on (`adletic`, or `aios` for master).
    pub socket: String,
    /// Human label from instances.json, falling back to the identity.
    pub display_name: String,
    /// Whether a client is currently attached to this session.
    pub attached: bool,
    /// Whether this is the permanent, undeletable master (root) session.
    pub is_master: bool,
    /// Whether the underlying tmux session actually exists right now.
    pub running: bool,
}

/// A live tmux session on any socket — the all-tmux attach surface.
#[derive(Debug, Clone, Serialize)]
pub struct TmuxSession {
    pub socket: String,
    pub name: String,
    pub attached: bool,
    pub windows: u32,
    /// True when this session is an AIOS oracle (`aios-*` on the oracle socket).
    pub is_oracle: bool,
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

/// Lowercases + strips anything outside `[a-z0-9_-]` so identities map safely to
/// tmux session names. Empty result is rejected by callers.
fn sanitize_identity(raw: &str) -> String {
    raw.trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
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

/// Runs a tmux command on the oracle socket, returning stdout on success.
fn tmux_oracle(args: &[&str]) -> Result<String, String> {
    let mut full = vec!["-L", ORACLE_SOCKET];
    full.extend_from_slice(args);
    let output = std::process::Command::new(tmux_bin())
        .args(&full)
        .output()
        .map_err(|e| format!("failed to run tmux: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Checks the master session on its socket: `Some(attached)` if it exists,
/// `None` if not running.
fn master_state() -> Option<bool> {
    let out = std::process::Command::new(tmux_bin())
        .args([
            "-L",
            MASTER_SOCKET,
            "list-sessions",
            "-F",
            "#{session_name}|#{session_attached}",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut p = line.splitn(2, '|');
        if p.next().map(|s| s.trim()) == Some(MASTER_SESSION) {
            return Some(p.next().unwrap_or("0").trim() != "0");
        }
    }
    None
}

/// Resolves an `aios-*` session's display name from the instance registry.
fn display_name_for(identity: &str, session: &str, instances: &[Instance]) -> String {
    instances
        .iter()
        .find(|i| {
            let id = i.id.to_lowercase();
            id == session.to_lowercase()
                || id == identity.to_lowercase()
                || i.name.to_lowercase() == identity.to_lowercase()
        })
        .map(|i| i.name.clone())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| identity.to_string())
}

/// Lists oracle sessions (`aios-*` on socket `adletic`), guaranteeing the master
/// oracle is always present (pinned first) even if its session isn't running.
#[tauri::command]
pub fn list_oracles() -> Result<Vec<OracleInfo>, String> {
    #[cfg(unix)]
    {
        let stdout = tmux_oracle(&["list-sessions", "-F", "#{session_name}|#{session_attached}"])
            .unwrap_or_default();
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
            let display_name = display_name_for(&identity, &session, &instances);
            oracles.push(OracleInfo {
                socket: ORACLE_SOCKET.to_string(),
                is_master: false,
                running: true,
                identity,
                session,
                display_name,
                attached,
            });
        }

        // Prepend the MASTER (root) session from its own socket — always present.
        let master_attached = master_state();
        oracles.push(OracleInfo {
            identity: MASTER_LABEL.to_string(),
            session: MASTER_SESSION.to_string(),
            socket: MASTER_SOCKET.to_string(),
            display_name: MASTER_LABEL.to_string(),
            attached: master_attached.unwrap_or(false),
            is_master: true,
            running: master_attached.is_some(),
        });

        // Master first, then running-attached, then alpha.
        oracles.sort_by(|a, b| {
            b.is_master
                .cmp(&a.is_master)
                .then(b.attached.cmp(&a.attached))
                .then(a.identity.cmp(&b.identity))
        });
        Ok(oracles)
    }

    #[cfg(not(unix))]
    {
        Ok(Vec::new())
    }
}

/// Lists EVERY live tmux session across the known sockets — the all-tmux attach
/// surface. Sessions absent → simply skipped (no error).
#[tauri::command]
pub fn list_tmux_sessions() -> Result<Vec<TmuxSession>, String> {
    #[cfg(unix)]
    {
        let mut sessions = Vec::new();
        for &socket in KNOWN_SOCKETS {
            let output = std::process::Command::new(tmux_bin())
                .args([
                    "-L",
                    socket,
                    "list-sessions",
                    "-F",
                    "#{session_name}|#{session_attached}|#{session_windows}",
                ])
                .output();
            let Ok(out) = output else { continue };
            if !out.status.success() {
                continue;
            }
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let mut p = line.splitn(3, '|');
                let name = p.next().unwrap_or("").trim().to_string();
                if name.is_empty() {
                    continue;
                }
                let attached = p.next().unwrap_or("0").trim() != "0";
                let windows = p.next().unwrap_or("1").trim().parse().unwrap_or(1);
                let is_oracle = socket == ORACLE_SOCKET && name.starts_with("aios-");
                sessions.push(TmuxSession {
                    socket: socket.to_string(),
                    name,
                    attached,
                    windows,
                    is_oracle,
                });
            }
        }
        Ok(sessions)
    }

    #[cfg(not(unix))]
    {
        Ok(Vec::new())
    }
}

/// Creates a new oracle: a detached tmux session `aios-<identity>` on the oracle
/// socket. If `command` is given, it's sent to the new session (e.g. `claude`).
#[tauri::command]
pub fn create_oracle(identity: String, command: Option<String>) -> Result<String, String> {
    let id = sanitize_identity(&identity);
    if id.is_empty() {
        return Err("identity must contain letters or digits".into());
    }
    let session = format!("aios-{id}");
    // Refuse if it already exists.
    if tmux_oracle(&["has-session", "-t", &session]).is_ok() {
        return Err(format!("oracle '{id}' already exists"));
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    tmux_oracle(&["new-session", "-d", "-s", &session, "-c", &home])?;
    if let Some(cmd) = command.filter(|c| !c.trim().is_empty()) {
        tmux_oracle(&["send-keys", "-t", &session, &cmd, "Enter"])?;
    }
    Ok(session)
}

/// Renames an oracle session. The master oracle cannot be renamed.
#[tauri::command]
pub fn rename_oracle(from: String, to: String) -> Result<String, String> {
    let from_id = sanitize_identity(&from);
    let to_id = sanitize_identity(&to);
    if to_id.is_empty() {
        return Err("new name must contain letters or digits".into());
    }
    let from_session = format!("aios-{from_id}");
    let to_session = format!("aios-{to_id}");
    if tmux_oracle(&["has-session", "-t", &to_session]).is_ok() {
        return Err(format!("oracle '{to_id}' already exists"));
    }
    tmux_oracle(&["rename-session", "-t", &from_session, &to_session])?;
    Ok(to_session)
}

/// Appshot: captures the screen to a PNG and sends its path into an oracle's
/// tmux session (defaults to master) — the ⌘⌘ "screenshot → aios" flow. Returns
/// the saved path. No Enter is sent, so the user can add context first.
#[tauri::command]
pub fn appshot(identity: Option<String>) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = format!("/tmp/aios-shot-{ts}.png");
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", &path])
        .status()
        .map_err(|e| format!("screencapture failed: {e}"))?;
    if !status.success() {
        return Err("screencapture returned non-zero".into());
    }
    // Route into the chosen oracle, or the master (root) session by default.
    // `-l` sends the path literally (no key interpretation), no Enter.
    let keys = format!("{path} ");
    match identity.map(|i| sanitize_identity(&i)).filter(|i| !i.is_empty()) {
        Some(id) => {
            let session = format!("aios-{id}");
            let _ = tmux_oracle(&["send-keys", "-t", &session, "-l", &keys]);
        }
        None => {
            let _ = std::process::Command::new(tmux_bin())
                .args(["-L", MASTER_SOCKET, "send-keys", "-t", MASTER_SESSION, "-l", &keys])
                .status();
        }
    }
    Ok(path)
}

/// Deletes (kills) an oracle session. The master oracle cannot be deleted.
#[tauri::command]
pub fn delete_oracle(identity: String) -> Result<(), String> {
    let id = sanitize_identity(&identity);
    if id.is_empty() {
        return Err("invalid identity".into());
    }
    tmux_oracle(&["kill-session", "-t", &format!("aios-{id}")])?;
    Ok(())
}
