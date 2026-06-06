//! Persistent browser state — history, bookmarks, downloads — for the AIOS
//! browser pane. The store mechanism MIRRORS `diag.rs`: a local-first, zero-
//! network JSON store under the Tauri **app-data dir** (per-bundle, portable — a
//! fork gets its own dir, no dependency on firaz's `~/.aios`).
//!
//! WHY JSON, not SQLite: `sqlx` IS a dep but is compiled with only the
//! `postgres` + `mysql` features (see Cargo.toml) — there is NO `sqlite` feature
//! and no bundled SQLite engine. Turning one on would pull a meaningful new
//! dependency surface (libsqlite3 / the bundled engine + a migration story) just
//! to store a few thousand history rows. The diag store already proves a small,
//! size-capped JSON file is the right weight here. So: one JSON file per concern
//! (`history.json`, `bookmarks.json`, `downloads.json`), each guarded by a
//! `Mutex` so concurrent navigations don't race the read-modify-write.
//!
//! Everything is best-effort: a store write must NEVER panic or surface an error
//! that breaks navigation — same "soft-fail, never panic" convention as diag.rs.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Resolved at startup (in `init`) so commands can find the store dir without an
/// AppHandle round-trip on every call.
static STORE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Serialize all read-modify-write cycles per file. Cheap (browsing is not a hot
/// path) and prevents two simultaneous navigations from clobbering each other.
static HISTORY_LOCK: Mutex<()> = Mutex::new(());
static BOOKMARKS_LOCK: Mutex<()> = Mutex::new(());
static DOWNLOADS_LOCK: Mutex<()> = Mutex::new(());

/// Caps so the files can't grow without bound on a long-lived install.
const HISTORY_MAX: usize = 5000;
const DOWNLOADS_MAX: usize = 200;

/// Called once from `lib.rs` setup with the resolved app-data dir. Creates the
/// `browser` subdir. Idempotent (OnceLock guards the global).
pub fn init(app_data_dir: PathBuf) {
    let dir = app_data_dir.join("browser");
    let _ = std::fs::create_dir_all(&dir);
    let _ = STORE_DIR.set(dir);
}

fn store_dir() -> Option<PathBuf> {
    STORE_DIR.get().cloned()
}

fn history_path() -> Option<PathBuf> {
    store_dir().map(|d| d.join("history.json"))
}
fn bookmarks_path() -> Option<PathBuf> {
    store_dir().map(|d| d.join("bookmarks.json"))
}
fn downloads_path() -> Option<PathBuf> {
    store_dir().map(|d| d.join("downloads.json"))
}

/// Read a JSON file into a typed value, soft-failing to the default on any error
/// (missing file, corrupt JSON, etc.).
fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Option<PathBuf>) -> T {
    let Some(p) = path else {
        return T::default();
    };
    match std::fs::read_to_string(p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => T::default(),
    }
}

/// Write a JSON value atomically-ish (write to a temp then rename) so a crash
/// mid-write can't leave a half-written file that fails to parse next launch.
fn write_json<T: Serialize>(path: &Option<PathBuf>, value: &T) {
    let Some(p) = path else {
        return;
    };
    let Ok(serialized) = serde_json::to_string(value) else {
        return;
    };
    let tmp = p.with_extension("json.tmp");
    if std::fs::write(&tmp, serialized.as_bytes()).is_ok() {
        let _ = std::fs::rename(&tmp, p);
    }
}

fn now_unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ─── History ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    /// Last-visited timestamp (unix ms).
    pub ts: u64,
    /// How many times this url has been committed-to.
    pub visit_count: u32,
}

/// Record (or bump) a committed navigation. Dedupes by url: an existing url has
/// its visit_count incremented and ts refreshed; a new url is appended. Keeps the
/// most-recently-visited HISTORY_MAX entries. `title` is best-effort (empty when
/// the page hasn't reported one yet — a later visit can fill it in).
#[tauri::command]
pub fn browser_history_record(url: String, title: Option<String>) -> Result<(), String> {
    // Ignore non-page urls — about:blank and the like aren't worth remembering.
    let url = url.trim().to_string();
    if url.is_empty() || url == "about:blank" || url.starts_with("about:") {
        return Ok(());
    }
    let _guard = HISTORY_LOCK.lock();
    let path = history_path();
    let mut entries: Vec<HistoryEntry> = read_json(&path);
    let title = title.unwrap_or_default();
    let now = now_unix_ms();
    if let Some(existing) = entries.iter_mut().find(|e| e.url == url) {
        existing.visit_count = existing.visit_count.saturating_add(1);
        existing.ts = now;
        // Only overwrite the title with a non-empty newer one (don't clobber a
        // good title with an empty later visit before the page set document.title).
        if !title.is_empty() {
            existing.title = title;
        }
    } else {
        entries.push(HistoryEntry {
            url,
            title,
            ts: now,
            visit_count: 1,
        });
    }
    // Keep newest-by-ts, capped.
    if entries.len() > HISTORY_MAX {
        entries.sort_by(|a, b| b.ts.cmp(&a.ts));
        entries.truncate(HISTORY_MAX);
    }
    write_json(&path, &entries);
    Ok(())
}

/// Autocomplete query: return up to `limit` history entries matching `query`
/// (case-insensitive substring on url OR title), ranked by a recency × frequency
/// score so the most useful suggestions float to the top. An empty query returns
/// the most-recently-visited entries (the "top sites" feel).
#[tauri::command]
pub fn browser_history_query(query: String, limit: Option<usize>) -> Vec<HistoryEntry> {
    let limit = limit.unwrap_or(8).min(50);
    let entries: Vec<HistoryEntry> = read_json(&history_path());
    let q = query.trim().to_lowercase();
    let now = now_unix_ms();

    let mut scored: Vec<(f64, HistoryEntry)> = entries
        .into_iter()
        .filter(|e| {
            if q.is_empty() {
                return true;
            }
            e.url.to_lowercase().contains(&q) || e.title.to_lowercase().contains(&q)
        })
        .map(|e| {
            // Recency: exponential decay over ~7 days. Frequency: log of visits.
            let age_days = (now.saturating_sub(e.ts)) as f64 / (1000.0 * 60.0 * 60.0 * 24.0);
            let recency = (-age_days / 7.0).exp();
            let frequency = ((e.visit_count as f64) + 1.0).ln();
            // A prefix match on the url (sans scheme) is the strongest signal —
            // it's what the user is most likely typing toward.
            let mut score = recency * (1.0 + frequency);
            if !q.is_empty() {
                let bare = e
                    .url
                    .split_once("://")
                    .map(|(_, rest)| rest)
                    .unwrap_or(&e.url)
                    .to_lowercase();
                if bare.starts_with(&q) || e.url.to_lowercase().starts_with(&q) {
                    score *= 5.0;
                }
            }
            (score, e)
        })
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(limit).map(|(_, e)| e).collect()
}

/// Wipe all history (the "clear browsing history" affordance).
#[tauri::command]
pub fn browser_history_clear() -> Result<(), String> {
    let _guard = HISTORY_LOCK.lock();
    write_json(&history_path(), &Vec::<HistoryEntry>::new());
    Ok(())
}

// ─── Bookmarks ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Bookmark {
    /// Stable id (url-derived + ts) so the frontend can key/remove precisely.
    pub id: String,
    pub url: String,
    pub title: String,
    /// Added timestamp (unix ms) — drives the default newest-first ordering.
    pub ts: u64,
}

fn read_bookmarks() -> Vec<Bookmark> {
    read_json(&bookmarks_path())
}

/// Add a bookmark for `url` (title best-effort). Idempotent on url — re-adding an
/// existing url just refreshes its title, so a "star" toggle never duplicates.
/// Returns the full list (newest first) so the toolbar can update in one round-trip.
#[tauri::command]
pub fn browser_bookmark_add(url: String, title: Option<String>) -> Result<Vec<Bookmark>, String> {
    let url = url.trim().to_string();
    if url.is_empty() || url == "about:blank" {
        return Ok(read_bookmarks());
    }
    let _guard = BOOKMARKS_LOCK.lock();
    let mut list = read_bookmarks();
    let title = title.unwrap_or_default();
    if let Some(existing) = list.iter_mut().find(|b| b.url == url) {
        if !title.is_empty() {
            existing.title = title;
        }
    } else {
        let ts = now_unix_ms();
        list.push(Bookmark {
            id: format!("bm-{ts}-{:x}", fnv1a(url.as_bytes())),
            url,
            title,
            ts,
        });
    }
    write_json(&bookmarks_path(), &list);
    list.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(list)
}

/// Remove a bookmark by url (the star-toggle-off path) OR by id. Returns the
/// updated list. Passing the url is the common case from the toolbar star.
#[tauri::command]
pub fn browser_bookmark_remove(
    url: Option<String>,
    id: Option<String>,
) -> Result<Vec<Bookmark>, String> {
    let _guard = BOOKMARKS_LOCK.lock();
    let mut list = read_bookmarks();
    list.retain(|b| {
        let by_url = url.as_deref().map(|u| b.url == u).unwrap_or(false);
        let by_id = id.as_deref().map(|i| b.id == i).unwrap_or(false);
        !(by_url || by_id)
    });
    write_json(&bookmarks_path(), &list);
    list.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(list)
}

/// List all bookmarks, newest first.
#[tauri::command]
pub fn browser_bookmark_list() -> Vec<Bookmark> {
    let mut list = read_bookmarks();
    list.sort_by(|a, b| b.ts.cmp(&a.ts));
    list
}

// ─── Downloads ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct DownloadRecord {
    pub id: String,
    pub path: String,
    pub name: String,
    /// "done" — we only persist successful, completed downloads (the on_download
    /// Finished/success event). Field kept for forward-compat with progress.
    pub state: String,
    pub ts: u64,
}

/// Record a completed download. Called from the `on_download` Finished handler so
/// the downloads panel survives restart. Dedupe by path (re-downloading the same
/// file refreshes its ts rather than stacking duplicates). Returns the list.
#[tauri::command]
pub fn browser_download_record(
    path: String,
    name: Option<String>,
) -> Result<Vec<DownloadRecord>, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Ok(read_json(&downloads_path()));
    }
    let _guard = DOWNLOADS_LOCK.lock();
    let mut list: Vec<DownloadRecord> = read_json(&downloads_path());
    let name = name.unwrap_or_else(|| {
        std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&path)
            .to_string()
    });
    let now = now_unix_ms();
    if let Some(existing) = list.iter_mut().find(|d| d.path == path) {
        existing.ts = now;
        existing.state = "done".into();
    } else {
        list.push(DownloadRecord {
            id: format!("dl-{now}-{:x}", fnv1a(path.as_bytes())),
            path,
            name,
            state: "done".into(),
            ts: now,
        });
    }
    // newest-first, capped
    list.sort_by(|a, b| b.ts.cmp(&a.ts));
    list.truncate(DOWNLOADS_MAX);
    write_json(&downloads_path(), &list);
    Ok(list)
}

/// List recent downloads, newest first.
#[tauri::command]
pub fn browser_download_list() -> Vec<DownloadRecord> {
    let mut list: Vec<DownloadRecord> = read_json(&downloads_path());
    list.sort_by(|a, b| b.ts.cmp(&a.ts));
    list
}

/// Forget a download from the list by id (doesn't delete the file on disk).
#[tauri::command]
pub fn browser_download_forget(id: String) -> Result<Vec<DownloadRecord>, String> {
    let _guard = DOWNLOADS_LOCK.lock();
    let mut list: Vec<DownloadRecord> = read_json(&downloads_path());
    list.retain(|d| d.id != id);
    write_json(&downloads_path(), &list);
    list.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(list)
}

/// Clear the whole downloads list (files on disk untouched).
#[tauri::command]
pub fn browser_download_clear() -> Result<(), String> {
    let _guard = DOWNLOADS_LOCK.lock();
    write_json(&downloads_path(), &Vec::<DownloadRecord>::new());
    Ok(())
}

/// Reveal a file in the OS file manager (Finder on macOS, Explorer on Windows),
/// selecting it. Used by the downloads panel's "reveal" action. Best-effort: a
/// missing file / failed spawn surfaces as an error string the UI can toast.
#[tauri::command]
pub fn browser_reveal_in_finder(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("empty path".into());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&path)
            .status()
            .map_err(|e| format!("open -R failed: {e}"))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("explorer.exe");
        cmd.arg(format!("/select,{path}"));
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        // explorer /select returns exit code 1 even on success, so don't gate on it.
        cmd.spawn().map_err(|e| format!("explorer failed: {e}"))?;
        Ok(())
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        // Linux: open the containing directory (no universal "select" verb).
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .status()
            .map_err(|e| format!("xdg-open failed: {e}"))?;
        Ok(())
    }
}

/// FNV-1a over bytes — used only to derive a stable, non-cryptographic id suffix
/// for bookmarks/downloads (so the same url/path produces the same id family).
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_is_stable_per_input() {
        assert_eq!(fnv1a(b"https://example.com"), fnv1a(b"https://example.com"));
        assert_ne!(fnv1a(b"a"), fnv1a(b"b"));
    }

    #[test]
    fn history_query_ranks_prefix_matches_first() {
        // Build entries directly (no disk) and exercise the same scoring the
        // command uses by replicating the filter+rank inline isn't possible since
        // the command reads disk; instead assert the scoring intuition holds via
        // a focused recompute. Prefix + frequent should beat a stale substring.
        let now = now_unix_ms();
        let fresh_prefix = HistoryEntry {
            url: "https://github.com/firaz".into(),
            title: "gh".into(),
            ts: now,
            visit_count: 10,
        };
        let stale_substring = HistoryEntry {
            url: "https://example.com/github-mirror".into(),
            title: "".into(),
            ts: now - 30 * 24 * 60 * 60 * 1000,
            visit_count: 1,
        };
        // Recompute scores the way the query does for q = "github".
        let q = "github";
        let score = |e: &HistoryEntry| -> f64 {
            let age_days = (now.saturating_sub(e.ts)) as f64 / (1000.0 * 60.0 * 60.0 * 24.0);
            let recency = (-age_days / 7.0).exp();
            let frequency = ((e.visit_count as f64) + 1.0).ln();
            let mut s = recency * (1.0 + frequency);
            let bare = e.url.split_once("://").map(|(_, r)| r).unwrap_or(&e.url);
            if bare.to_lowercase().starts_with(q) || e.url.to_lowercase().starts_with(q) {
                s *= 5.0;
            }
            s
        };
        assert!(score(&fresh_prefix) > score(&stale_substring));
    }
}
