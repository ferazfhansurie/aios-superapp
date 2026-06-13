//! Bearer-token auth for the node daemon. The daemon binds the tailscale IP and
//! is RCE-by-design, so the token is the only thing between the tailnet and a
//! shell on the box: it must be a real CSPRNG secret, stored `0600`, and compared
//! in constant time (a timing oracle on a 64-hex-char token is a real leak vector
//! once this is reachable from another host, unlike the loopback control plane).

use std::io::Write;
use std::path::PathBuf;

/// `~/.aios/state/node-secret` — same file the laptop control plane reads, so a
/// single token pairs the two machines.
fn secret_path() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    Some(PathBuf::from(home).join(".aios/state/node-secret"))
}

/// Loads the bearer token, creating a fresh 32-byte CSPRNG token (64 hex chars,
/// `0600`) if absent. Returns the trimmed token. A pre-existing token is kept (so
/// it stays stable across restarts and the Mac side can cache it).
pub fn load_or_create() -> Result<String, String> {
    let path = secret_path().ok_or("no HOME for node-secret path")?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let t = existing.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw).map_err(|e| format!("CSPRNG failed: {e}"))?;
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();

    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    // 0600 BEFORE writing the secret so it's never briefly world-readable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    f.write_all(token.as_bytes()).map_err(|e| e.to_string())?;
    Ok(token)
}

/// Constant-time equality — no early return on first mismatched byte. Lengths are
/// compared first (their difference isn't secret), then every byte is XOR-folded.
pub fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Extracts the bearer token from an `Authorization: Bearer <tok>` header value.
pub fn bearer(header: Option<&str>) -> Option<&str> {
    header?.strip_prefix("Bearer ").map(|s| s.trim())
}
