//! Local CRM persistence for the CRM pane — a tiny, agency-grade contacts +
//! deal-pipeline store. No database, no network: the whole thing is one JSON
//! file at `~/.aios/state/crm.json` (the AIOS state dir other features already
//! use). The frontend owns the record shape; this module just keeps a flexible
//! `{ contacts: [...], deals: [...] }` blob on disk and upserts by `id`.
//!
//! Defensive by design — mirroring `files.rs` / `oracles.rs`:
//!   - missing file / dir       → start from an empty store, create on first save
//!   - corrupt / unparseable     → start empty, never panic
//!   - writes are atomic         → serialise to `crm.json.tmp`, then rename over
//!
//! IDs are generated WITHOUT `rand`/`Date`: a process-monotonic `AtomicU64`
//! counter combined with the wall-clock epoch in millis, so collisions can't
//! happen within a run and stay stable across the JSON round-trip.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

/// Per-process counter that guarantees uniqueness even when two records are
/// created in the same millisecond. Combined with the epoch in `next_id`.
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// `$HOME`, or `/` as a last resort (matches `automations.rs`).
fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// The AIOS state directory — `~/.aios/state`. Created on demand by `save`.
fn state_dir() -> PathBuf {
    PathBuf::from(home()).join(".aios").join("state")
}

/// The CRM store path — `~/.aios/state/crm.json`.
fn crm_path() -> PathBuf {
    state_dir().join("crm.json")
}

/// Generates a sortable, collision-free id, e.g. `1716950400123-7`.
/// Epoch-millis gives chronological ordering; the atomic suffix disambiguates
/// same-millisecond creation. No `rand`, no `Date` — std only.
fn next_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{millis}-{n}")
}

/// Reads + parses the store. Missing or corrupt → a fresh empty store. Always
/// returns an object with `contacts` + `deals` arrays so callers can index
/// them without re-checking.
fn read_store() -> Value {
    let empty = json!({ "contacts": [], "deals": [] });
    let Ok(text) = std::fs::read_to_string(crm_path()) else {
        return empty;
    };
    let mut v = match serde_json::from_str::<Value>(&text) {
        Ok(v) if v.is_object() => v,
        // Corrupt or non-object payload → start clean rather than panicking.
        _ => return empty,
    };
    // Heal a partial/legacy file: guarantee both arrays exist + are arrays.
    let obj = v.as_object_mut().expect("checked is_object above");
    if !obj.get("contacts").map(Value::is_array).unwrap_or(false) {
        obj.insert("contacts".into(), json!([]));
    }
    if !obj.get("deals").map(Value::is_array).unwrap_or(false) {
        obj.insert("deals".into(), json!([]));
    }
    v
}

/// Writes the store atomically: serialise → `crm.json.tmp` → rename over the
/// real file (rename is atomic on the same filesystem). Creates the state dir
/// on first write. Any IO error is surfaced as a `String`.
fn write_store(store: &Value) -> Result<(), String> {
    let dir = state_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let pretty = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let final_path = crm_path();
    let tmp_path = dir.join("crm.json.tmp");

    std::fs::write(&tmp_path, pretty).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        // Best-effort cleanup so a failed rename doesn't leave a stray tmp file.
        let _ = std::fs::remove_file(&tmp_path);
        format!("rename into place: {e}")
    })?;
    Ok(())
}

/// Upserts `record` into the `key` array of the store by its `id` field.
/// Generates an id when absent. Existing record (same id) is replaced in place;
/// otherwise the record is appended. Returns the id written.
fn upsert(key: &str, mut record: Value) -> Result<String, String> {
    if !record.is_object() {
        return Err(format!("{key} record must be a JSON object"));
    }

    // Resolve / mint the id, and write it back onto the record.
    let id = match record.get("id").and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => {
            let fresh = next_id();
            record["id"] = json!(fresh);
            fresh
        }
    };

    let mut store = read_store();
    let arr = store[key]
        .as_array_mut()
        .ok_or_else(|| format!("store '{key}' is not an array"))?;

    if let Some(slot) = arr.iter_mut().find(|r| r.get("id").and_then(Value::as_str) == Some(id.as_str())) {
        *slot = record;
    } else {
        arr.push(record);
    }

    write_store(&store)?;
    Ok(id)
}

/// Removes every record with the given `id` from the `key` array. A no-op (Ok)
/// if nothing matched — deleting an unknown id is not an error.
fn delete_by_id(key: &str, id: &str) -> Result<(), String> {
    let mut store = read_store();
    let arr = store[key]
        .as_array_mut()
        .ok_or_else(|| format!("store '{key}' is not an array"))?;
    arr.retain(|r| r.get("id").and_then(Value::as_str) != Some(id));
    write_store(&store)
}

// ════════════════════════════════════════════════════════════════════════
// Tauri commands
// ════════════════════════════════════════════════════════════════════════

/// Returns the whole store: `{ contacts: [...], deals: [...] }`. Never errors —
/// a missing or corrupt file yields an empty store.
#[tauri::command]
pub fn crm_load() -> Value {
    read_store()
}

/// Upserts a contact by `id` (minted if absent). Returns the id written so the
/// frontend can reconcile a freshly-created record.
#[tauri::command]
pub fn crm_save_contact(contact: Value) -> Result<String, String> {
    upsert("contacts", contact)
}

/// Deletes a contact by id (no-op if absent).
#[tauri::command]
pub fn crm_delete_contact(id: String) -> Result<(), String> {
    delete_by_id("contacts", &id)
}

/// Upserts a deal by `id` (minted if absent). Returns the id written.
#[tauri::command]
pub fn crm_save_deal(deal: Value) -> Result<String, String> {
    upsert("deals", deal)
}

/// Deletes a deal by id (no-op if absent).
#[tauri::command]
pub fn crm_delete_deal(id: String) -> Result<(), String> {
    delete_by_id("deals", &id)
}
