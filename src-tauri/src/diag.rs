//! Error/diagnostics telemetry — the LOCAL-FIRST, ZERO-NETWORK store for the
//! AIOS shell (Phase 0 + Phase 1 of TELEMETRY-PLAN.md).
//!
//! NOT to be confused with `telemetry.rs` (that's read-only Claude Code JSONL
//! *usage* aggregation for the sidebar — a name collision only). This module
//! owns *error* telemetry: it collects DiagEvents from the JS side (the 91
//! formerly-silent `.catch(() => {})` sites, the React error boundary, global
//! window handlers) plus Rust-side panics, and persists them to an append-only,
//! size-capped JSONL under the Tauri **app-data dir** — never `~/.aios` (a fork
//! has none of firaz's infra; app-data is per-bundle-id and portable).
//!
//! Everything here is best-effort: a diag write must NEVER panic or surface an
//! error to the caller. The whole point is observability without new failure
//! modes — it mirrors the existing "soft-fail, never panic" backend convention.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

/// The shared event contract — must agree byte-for-byte with `src/lib/diag.ts`.
/// `schema` is bumped if the shape changes.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DiagEvent {
    pub ts: String,
    pub kind: String, // "error" | "usage" | "perf"
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub action: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub stack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frames: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub duration_ms: Option<u64>,
    pub app_version: String,
    pub os: String,
    pub anon_install_id: String,
    pub schema: u8,
}

/// Rotation policy: cap the live file at 5 MB, keep exactly one rollover
/// (`events.1.jsonl`), so the diag dir never exceeds ~10 MB on disk.
const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Resolved at startup so the panic hook (which can't cleanly grab an AppHandle
/// inside its closure) still has a path to write to. Set once in `init()`.
static DIAG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Cache the app version + install id for the panic hook (no AppHandle in scope).
static APP_VERSION: OnceLock<String> = OnceLock::new();

/// Resolve `<app_data_dir>/diag`, creating it if needed. Returns None on failure
/// (we soft-fail — no diag dir just means events are dropped, never a crash).
fn diag_dir() -> Option<PathBuf> {
    DIAG_DIR.get().cloned()
}

fn events_path(dir: &PathBuf) -> PathBuf {
    dir.join("events.jsonl")
}

fn rollover_path(dir: &PathBuf) -> PathBuf {
    dir.join("events.1.jsonl")
}

fn install_id_path(dir: &PathBuf) -> PathBuf {
    dir.join("install_id")
}

/// Read-or-create the anonymous install id (uuid-v4-shaped). No machine
/// fingerprint — a random id is the *entire* identity. Stored once, reused.
fn ensure_install_id(dir: &PathBuf) -> String {
    let p = install_id_path(dir);
    if let Ok(s) = std::fs::read_to_string(&p) {
        let t = s.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    let id = gen_uuid_v4();
    let _ = std::fs::write(&p, &id);
    id
}

/// Tiny uuid-v4 generator using a couple of OS/time entropy sources — avoids
/// pulling a new crate just for an anonymous id. Good enough for a random,
/// non-identifying tag (the value never needs to be cryptographically unique).
fn gen_uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Mix in the address of a stack local + pid for a bit more entropy.
    let pid = std::process::id() as u128;
    let stack_marker = &nanos as *const _ as u128;
    let mut x = nanos ^ (pid << 64) ^ stack_marker;
    let mut bytes = [0u8; 16];
    for b in bytes.iter_mut() {
        // xorshift-ish step
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *b = (x & 0xff) as u8;
    }
    // Set version (4) and variant (10xx) bits per RFC 4122.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

/// Append one event line, rotating first if over cap. Best-effort: any error is
/// swallowed (a failed diag write must never break the app).
fn append_local(ev: &DiagEvent) {
    let Some(dir) = diag_dir() else {
        return;
    };
    let path = events_path(&dir);

    // Rotate if the live file is over cap. Cheap metadata check before open.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() >= MAX_BYTES {
            // Replace the single rollover slot with the current file.
            let _ = std::fs::rename(&path, rollover_path(&dir));
        }
    }

    let Ok(mut line) = serde_json::to_string(ev) else {
        return;
    };
    line.push('\n');
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Initialize the diag store. Called once from `lib.rs` setup with the resolved
/// app-data dir + app version. Creates the diag dir, seeds the install id, and
/// installs the panic hook. Idempotent-ish (OnceLock guards the globals).
pub fn init(app_data_dir: PathBuf, app_version: String) {
    let dir = app_data_dir.join("diag");
    let _ = std::fs::create_dir_all(&dir);
    // Make sure an install id exists on disk before any event is written.
    let _ = ensure_install_id(&dir);
    let _ = DIAG_DIR.set(dir);
    let _ = APP_VERSION.set(app_version);
    install_panic_hook();
}

/// Catch Rust panics and persist them as DiagEvents instead of letting them die
/// silently. Chains the previous hook so default behavior (abort/unwind logging)
/// is preserved. Must not re-panic.
fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        let payload = info.to_string();
        let ev = DiagEvent {
            ts: now_iso(),
            kind: "error".to_string(),
            source: "rust:panic".to_string(),
            action: if loc.is_empty() { None } else { Some(loc) },
            message: cap(&payload, 500),
            stack: None,
            frames: None,
            duration_ms: None,
            app_version: APP_VERSION.get().cloned().unwrap_or_default(),
            os: std::env::consts::OS.to_string(),
            anon_install_id: current_install_id(),
            schema: 1,
        };
        append_local(&ev);
        // Preserve existing behavior (the "soft-fail never panic" convention
        // still logs to stderr in dev / CI).
        prev(info);
    }));
}

/// Read the install id from disk (cheap — only called on the panic path / when
/// the UI asks). Returns empty if the store isn't initialized.
fn current_install_id() -> String {
    diag_dir()
        .map(|d| ensure_install_id(&d))
        .unwrap_or_default()
}

/// Best-effort ISO-8601 UTC timestamp without pulling chrono into this hot path
/// (chrono IS a dep, but the panic hook wants the smallest possible surface).
fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // Delegate to chrono for correctness — it's already a dependency.
    let secs = dur.as_secs() as i64;
    let nanos = dur.subsec_nanos();
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, nanos)
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

fn cap(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect()
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — the JS sink + the in-app Diagnostics tab reader/clearer.
// ---------------------------------------------------------------------------

/// The JS-side sink. `reportDiag()` in `diag.ts` calls this for every error,
/// usage, or perf event. Best-effort persistence; always returns Ok so the JS
/// reporter can never reject (it's wrapped, but defense in depth).
#[tauri::command]
pub fn diag_report(mut event: DiagEvent) -> Result<(), String> {
    // Backfill any fields the JS side couldn't know (install id is authoritative
    // on the Rust side; os falls back to the host).
    if event.anon_install_id.is_empty() {
        event.anon_install_id = current_install_id();
    }
    if event.os.is_empty() {
        event.os = std::env::consts::OS.to_string();
    }
    if event.app_version.is_empty() {
        event.app_version = APP_VERSION.get().cloned().unwrap_or_default();
    }
    if event.schema == 0 {
        event.schema = 1;
    }
    event.message = cap(&event.message, 500);
    append_local(&event);
    Ok(())
}

/// Read back the most recent `limit` events (newest first) for the Diagnostics
/// tab. Reads the rollover too so the UI sees a full window. Soft-fails to an
/// empty vec.
#[tauri::command]
pub fn diag_recent(limit: usize) -> Vec<DiagEvent> {
    let Some(dir) = diag_dir() else {
        return Vec::new();
    };
    let mut lines: Vec<String> = Vec::new();
    // Read rollover first (older) then live (newer) so order is chronological.
    for p in [rollover_path(&dir), events_path(&dir)] {
        if let Ok(content) = std::fs::read_to_string(&p) {
            for l in content.lines() {
                if !l.trim().is_empty() {
                    lines.push(l.to_string());
                }
            }
        }
    }
    // Newest first.
    let take = limit.min(lines.len());
    lines
        .iter()
        .rev()
        .take(take)
        .filter_map(|l| serde_json::from_str::<DiagEvent>(l).ok())
        .collect()
}

/// Truncate the diag store (both live + rollover). Used by the "clear" button.
#[tauri::command]
pub fn diag_clear() -> Result<(), String> {
    if let Some(dir) = diag_dir() {
        let _ = std::fs::remove_file(events_path(&dir));
        let _ = std::fs::remove_file(rollover_path(&dir));
    }
    Ok(())
}

/// Surface the anon install id + app version for the Diagnostics tab header.
#[tauri::command]
pub fn diag_info() -> serde_json::Value {
    serde_json::json!({
        "install_id": current_install_id(),
        "app_version": APP_VERSION.get().cloned().unwrap_or_default(),
        "os": std::env::consts::OS,
    })
}
