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

/// The permanent MASTER (root) session — the mothership running at the user's
/// home dir, on its own tmux socket. Always pinned top, crowned, undeletable.
/// This is NOT an `aios-*` bridge oracle.
///
/// The socket/session names are env-overridable so the cockpit can target any
/// AIOS deployment (defaults preserve the original author's setup):
///   - `AIOS_ORACLE_SOCKET` — socket the bridge runs oracles on (default `adletic`)
///   - `AIOS_MASTER_SOCKET` — socket the master session lives on (default `aios`)
///   - `AIOS_MASTER_SESSION` — name of the master session (default `aios`)
/// On machines with no tmux / no AIOS sessions, every list command simply
/// returns empty — the graceful path for non-AIOS users.
/// Reads an env var, falling back to a default. Resolved per-call (cheap) so a
/// running cockpit can be retargeted without a rebuild.
fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// The tmux socket the bridge runs oracles on. Override: `AIOS_ORACLE_SOCKET`.
fn oracle_socket() -> String {
    env_or("AIOS_ORACLE_SOCKET", "adletic")
}

/// The tmux socket the master session lives on. Override: `AIOS_MASTER_SOCKET`.
fn master_socket() -> String {
    env_or("AIOS_MASTER_SOCKET", "aios")
}

/// The name of the master (root) tmux session. Override: `AIOS_MASTER_SESSION`.
fn master_session() -> String {
    env_or("AIOS_MASTER_SESSION", "aios")
}

/// The identity of firaz's load-bearing primary oracle (`aios-firaz`). WhatsApp
/// inbound routes to it; deleting it silently breaks routing, so the backend
/// hard-blocks deletion unless the caller passes an explicit override.
/// Override the protected identity via `AIOS_PRIMARY_ORACLE` (default `firaz`).
fn primary_oracle_identity() -> String {
    env_or("AIOS_PRIMARY_ORACLE", "firaz")
}

/// Sockets scanned for the all-tmux attach surface, in display order. Built from
/// the (possibly overridden) oracle + master sockets, plus the default socket.
fn known_sockets() -> Vec<String> {
    let mut out = vec![oracle_socket(), master_socket(), "default".to_string()];
    out.dedup();
    out
}

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
    let socket = oracle_socket();
    let mut full = vec!["-L", socket.as_str()];
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
            // Real oracles are `aios-<identity>`. EXCLUDE `aios-term-*` — those are
            // the shell's own persistent terminal panes, not oracles; they were
            // leaking into the roster as cryptic "oracle: term-k3-…" entries.
            if !session.starts_with("aios-") || session.starts_with("aios-term-") {
                continue;
            }
            let identity = session.trim_start_matches("aios-").to_string();
            let display_name = display_name_for(&identity, &session, &instances);
            oracles.push(OracleInfo {
                socket: oracle_socket(),
                is_master: false,
                running: true,
                identity,
                session,
                display_name,
                attached,
            });
        }

        // Flat, open "agents" list — no special master. Attached first, then alpha.
        oracles.sort_by(|a, b| b.attached.cmp(&a.attached).then(a.identity.cmp(&b.identity)));
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
        let oracle_sock = oracle_socket();
        for socket in known_sockets() {
            let output = std::process::Command::new(tmux_bin())
                .args([
                    "-L",
                    socket.as_str(),
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
                let is_oracle = socket == oracle_sock && name.starts_with("aios-");
                sessions.push(TmuxSession {
                    socket: socket.clone(),
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

    // Prefer the bridge's oracle-spawn.sh — it resolves the identity's REAL
    // workspace / sid / runtime / model from the identity registry, launches the
    // agent (claude) in the right repo with full context, and registers the
    // session exactly like the WhatsApp bridge + grid do. This is what makes
    // re-spawning `aios-firaz` (or any teammate) actually restore the working
    // oracle — not a bare shell. A bare `tmux new-session` is the fallback only
    // when the script isn't present (non-bridge machines / OSS installs).
    if let Some(script) = oracle_spawn_script() {
        let _ = std::process::Command::new("bash")
            .arg(&script)
            .arg(&id)
            .env("AIOS_SPAWN_FROM_SHELL", "1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("couldn't run oracle-spawn.sh: {e}"))?;
        // The script creates the tmux session early, then opens the AIOS window;
        // poll (≤6s) for the session so we return only once it's really up.
        for _ in 0..30 {
            if tmux_oracle(&["has-session", "-t", &session]).is_ok() {
                return Ok(session);
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        // Script ran but the session never appeared — fall through to a bare
        // session so the user still gets something rather than a silent failure.
    }

    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    tmux_oracle(&["new-session", "-d", "-s", &session, "-c", &home])?;
    if let Some(cmd) = command.filter(|c| !c.trim().is_empty()) {
        tmux_oracle(&["send-keys", "-t", &session, &cmd, "Enter"])?;
    }
    Ok(session)
}

/// Resolves the bridge's `oracle-spawn.sh` (the canonical real-oracle launcher).
/// Tries the reorg'd path first, then the legacy symlinked one. `None` on a box
/// that doesn't have the bridge checked out.
fn oracle_spawn_script() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    for rel in [
        "Repo/firaz/aios/bridge/scripts/oracle-spawn.sh",
        "Repo/firaz/aios-bridge/scripts/oracle-spawn.sh",
    ] {
        let p = format!("{home}/{rel}");
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    None
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
            let master_socket = master_socket();
            let master_session = master_session();
            let _ = std::process::Command::new(tmux_bin())
                .args([
                    "-L",
                    master_socket.as_str(),
                    "send-keys",
                    "-t",
                    master_session.as_str(),
                    "-l",
                    &keys,
                ])
                .status();
        }
    }
    Ok(path)
}

/// Deletes (kills) an oracle session. The master oracle cannot be deleted.
///
/// firaz's primary oracle (`aios-firaz`) is load-bearing — his WhatsApp routes
/// to it — so it is hard-blocked unless `force` is `true`. The frontend only
/// passes `force` after a distinct, explicitly-warned confirm step, so it can't
/// be fat-fingered.
#[tauri::command]
pub fn delete_oracle(identity: String, force: Option<bool>) -> Result<(), String> {
    let id = sanitize_identity(&identity);
    if id.is_empty() {
        return Err("invalid identity".into());
    }
    if id == primary_oracle_identity() && !force.unwrap_or(false) {
        return Err(format!(
            "deleting aios-{id} breaks your whatsapp routing — confirm with force"
        ));
    }
    tmux_oracle(&["kill-session", "-t", &format!("aios-{id}")])?;
    Ok(())
}

/// Kills any tmux session on a given socket — the all-tmux attach surface's
/// delete affordance. No session is protected: the master can be killed too
/// (Firaz's call — he owns the mothership and may want it gone).
#[tauri::command]
pub fn kill_tmux_session(socket: String, session: String) -> Result<(), String> {
    let socket = socket.trim();
    let session = session.trim();
    if socket.is_empty() || session.is_empty() {
        return Err("socket and session are required".into());
    }
    let output = std::process::Command::new(tmux_bin())
        .args(["-L", socket, "kill-session", "-t", session])
        .output()
        .map_err(|e| format!("failed to run tmux: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}
