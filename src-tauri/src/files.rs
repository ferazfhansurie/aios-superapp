//! Minimal filesystem commands for the Files pane.

use serde::Serialize;

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    /// Last-modified time in unix seconds (0 if unavailable) — lets callers find
    /// the freshest file (e.g. the idle focus tile's newest memory note).
    mtime: f64,
}

/// Lists a directory (dirs first, alphabetical, dotfiles hidden). Empty path → $HOME.
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let p = if path.is_empty() {
        home_dir()
    } else {
        path
    };
    let mut entries: Vec<DirEntry> = Vec::new();
    for e in std::fs::read_dir(&p).map_err(|e| e.to_string())? {
        let e = match e {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let meta = e.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let mtime = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        entries.push(DirEntry {
            name,
            path: e.path().to_string_lossy().to_string(),
            is_dir,
            mtime,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Like `read_dir` but for the VS Code-style explorer tree. Two filter knobs:
///  - `show_hidden` (default false): when false, dotfiles (`.env`, `.claude`, …)
///    are hidden like VS Code's default; when true they show. `.git`/`.DS_Store`
///    are ALWAYS hidden (pure noise).
///  - `show_all` (default false): when false, heavy build/dep dirs (node_modules,
///    target, dist, .next, …) are pruned the same way the search backend prunes
///    them (`is_search_pruned_dir`); when true they show.
/// Same sort (dirs first, alphabetical). Params are `Option` so old callers that
/// pass neither get the VS Code-ish default (hidden dotfiles, pruned junk).
#[tauri::command]
pub fn read_dir_tree(
    path: String,
    show_hidden: Option<bool>,
    show_all: Option<bool>,
) -> Result<Vec<DirEntry>, String> {
    let show_hidden = show_hidden.unwrap_or(false);
    let show_all = show_all.unwrap_or(false);
    let p = if path.is_empty() {
        home_dir()
    } else {
        path
    };
    let mut entries: Vec<DirEntry> = Vec::new();
    for e in std::fs::read_dir(&p).map_err(|e| e.to_string())? {
        let e = match e {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = e.file_name().to_string_lossy().to_string();
        // Always-noise: never surface these.
        if name == ".git" || name == ".DS_Store" {
            continue;
        }
        // Dotfiles hidden by default (VS Code-style); shown only with show_hidden.
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        // Heavy build/dep dirs pruned by default; shown only with show_all. Same
        // set the file finder / content search prunes, so the tree matches ⌘P.
        if !show_all && is_search_pruned_dir(&name) {
            continue;
        }
        let meta = e.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let mtime = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        entries.push(DirEntry {
            name,
            path: e.path().to_string_lossy().to_string(),
            is_dir,
            mtime,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[derive(Serialize)]
pub struct GitEntry {
    /// Absolute path of the changed file.
    path: String,
    /// Single-letter status: M(odified) A(dded) D(eleted) R(enamed) U(ntracked).
    status: String,
}

#[derive(Serialize)]
pub struct GitStatus {
    /// Repo toplevel, or null if `path` isn't inside a git repo.
    root: Option<String>,
    entries: Vec<GitEntry>,
}

#[derive(Serialize)]
pub struct ShellSourceStatus {
    root: Option<String>,
    branch: String,
    dirty: u32,
    changed: Vec<GitEntry>,
}

/// Git status for the repo containing `path`, as absolute-path → status-letter,
/// so the Files tree can decorate changed files + their parent folders. Returns
/// `{ root: null, entries: [] }` (never errors) when not in a repo.
#[tauri::command]
pub fn git_status(path: String) -> Result<GitStatus, String> {
    let root = match std::process::Command::new("git")
        .args(["-C", &path, "rev-parse", "--show-toplevel"])
        .output()
    {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }
        _ => return Ok(GitStatus { root: None, entries: Vec::new() }),
    };
    let out = std::process::Command::new("git")
        .args(["-C", &root, "status", "--porcelain", "--ignored=no"])
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut entries = Vec::new();
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let xy = &line[..2];
        let mut rest = line[3..].to_string();
        // renames come as "old -> new" — decorate the new path
        if let Some(idx) = rest.find(" -> ") {
            rest = rest[idx + 4..].to_string();
        }
        let rel = rest.trim().trim_matches('"');
        let abs = std::path::Path::new(&root)
            .join(rel)
            .to_string_lossy()
            .to_string();
        let status = simplify_status(xy).to_string();
        entries.push(GitEntry { path: abs, status });
    }
    Ok(GitStatus { root: Some(root), entries })
}

#[tauri::command]
pub fn shell_source_status() -> Result<ShellSourceStatus, String> {
    let Some(root) = find_shell_source_root() else {
        return Ok(ShellSourceStatus {
            root: None,
            branch: String::new(),
            dirty: 0,
            changed: Vec::new(),
        });
    };

    let branch = std::process::Command::new("git")
        .args(["-C", &root, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    let status = git_status(root.clone())?;
    let dirty = status.entries.len() as u32;
    let changed = status.entries.into_iter().take(18).collect();

    Ok(ShellSourceStatus {
        root: Some(root),
        branch,
        dirty,
        changed,
    })
}

fn find_shell_source_root() -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("AIOS_SHELL_SOURCE_ROOT") {
        candidates.push(path);
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.to_string_lossy().to_string());
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!("{home}/Repo/firaz/aios/shell"));
        candidates.push(format!("{home}/Repo/firaz/adletic/aios/shell"));
    }

    candidates.into_iter().find_map(|path| {
        let root = std::process::Command::new("git")
            .args(["-C", &path, "rev-parse", "--show-toplevel"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())?;
        let has_tauri = std::path::Path::new(&root)
            .join("src-tauri/tauri.conf.json")
            .exists();
        let has_package = std::path::Path::new(&root).join("package.json").exists();
        if has_tauri && has_package {
            Some(root)
        } else {
            None
        }
    })
}

/// Collapse a 2-char porcelain XY code to one display letter.
fn simplify_status(xy: &str) -> &'static str {
    if xy == "??" {
        return "U";
    }
    if xy.contains('D') {
        "D"
    } else if xy.contains('A') {
        "A"
    } else if xy.contains('R') {
        "R"
    } else if xy.contains('M') {
        "M"
    } else {
        "M"
    }
}

#[derive(Serialize)]
pub struct RepoPulse {
    /// The input path, echoed back so the frontend can map results.
    root: String,
    /// Final path component of root.
    name: String,
    /// Current branch; "" if detached / not a repo.
    branch: String,
    /// Count of porcelain status lines (working-tree changes).
    dirty: u32,
    /// Commits ahead of upstream; 0 if no upstream / error.
    ahead: u32,
    /// Commits behind upstream; 0 if no upstream / error.
    behind: u32,
}

/// Best-effort dev-pulse for a set of repo paths (the "dev pulse" dashboard tile).
/// For each path: current branch, working-tree dirty count, and ahead/behind vs
/// upstream. Never errors — a non-repo (or any git failure) yields a zeroed
/// RepoPulse for that path. Results preserve input order, one per path. Frontend
/// passes only a handful of paths so the git calls run sequentially.
#[tauri::command]
pub fn git_pulse(paths: Vec<String>) -> Vec<RepoPulse> {
    let mut out: Vec<RepoPulse> = Vec::with_capacity(paths.len());
    for path in paths {
        let name = std::path::Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());

        // branch — "" if detached / not a repo
        let branch = match std::process::Command::new("git")
            .args(["-C", &path, "rev-parse", "--abbrev-ref", "HEAD"])
            .output()
        {
            Ok(o) if o.status.success() => {
                String::from_utf8_lossy(&o.stdout).trim().to_string()
            }
            _ => String::new(),
        };

        // dirty — count of porcelain status lines
        let dirty = match std::process::Command::new("git")
            .args(["-C", &path, "status", "--porcelain", "--ignored=no"])
            .output()
        {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.is_empty())
                .count() as u32,
            _ => 0,
        };

        // ahead/behind vs upstream — output is "<behind>\t<ahead>"
        let (mut ahead, mut behind) = (0u32, 0u32);
        if let Ok(o) = std::process::Command::new("git")
            .args([
                "-C",
                &path,
                "rev-list",
                "--count",
                "--left-right",
                "@{upstream}...HEAD",
            ])
            .output()
        {
            if o.status.success() {
                let text = String::from_utf8_lossy(&o.stdout);
                let mut parts = text.split_whitespace();
                if let Some(b) = parts.next() {
                    behind = b.parse().unwrap_or(0);
                }
                if let Some(a) = parts.next() {
                    ahead = a.parse().unwrap_or(0);
                }
            }
        }

        out.push(RepoPulse {
            root: path,
            name,
            branch,
            dirty,
            ahead,
            behind,
        });
    }
    out
}

#[derive(Serialize)]
pub struct RunCommand {
    label: String,
    cmd: String,
}

#[derive(Serialize)]
pub struct ProjectRun {
    /// "flutter" | "node" | "rust" | "go" | "python" | "make" | "unknown"
    kind: String,
    /// Directory the project marker was found in (where the command should run).
    root: Option<String>,
    /// Candidate run commands; the first is the default for F5.
    commands: Vec<RunCommand>,
}

/// If `dir` is itself a runnable project root (has a known marker), returns its
/// `(kind, commands)`. This is the single source of truth for marker detection +
/// command derivation, shared by `detect_project` (walks up) and `list_projects`
/// (scans down). Returns `None` when `dir` has no recognized marker.
fn project_at(dir: &std::path::Path) -> Option<(String, Vec<RunCommand>)> {
    let has = |f: &str| dir.join(f).is_file();

    if has("pubspec.yaml") {
        return Some((
            "flutter".into(),
            vec![
                RunCommand { label: "flutter run".into(), cmd: "flutter run".into() },
                RunCommand { label: "flutter run --release".into(), cmd: "flutter run --release".into() },
                RunCommand { label: "flutter test".into(), cmd: "flutter test".into() },
            ],
        ));
    }
    if has("package.json") {
        return Some(("node".into(), node_scripts(dir)));
    }
    if has("Cargo.toml") {
        return Some((
            "rust".into(),
            vec![
                RunCommand { label: "cargo run".into(), cmd: "cargo run".into() },
                RunCommand { label: "cargo test".into(), cmd: "cargo test".into() },
                RunCommand { label: "cargo build".into(), cmd: "cargo build".into() },
            ],
        ));
    }
    if has("go.mod") {
        return Some((
            "go".into(),
            vec![
                RunCommand { label: "go run .".into(), cmd: "go run .".into() },
                RunCommand { label: "go test ./...".into(), cmd: "go test ./...".into() },
            ],
        ));
    }
    if has("pyproject.toml") || has("requirements.txt") || has("manage.py") {
        let cmd = if has("manage.py") {
            "python manage.py runserver"
        } else {
            "python main.py"
        };
        return Some((
            "python".into(),
            vec![RunCommand { label: cmd.into(), cmd: cmd.into() }],
        ));
    }
    if has("Makefile") {
        return Some((
            "make".into(),
            vec![RunCommand { label: "make".into(), cmd: "make".into() }],
        ));
    }
    None
}

/// Detects the runnable project containing `path` (walks up to find a marker)
/// and returns the F5-style run commands. Used by the Run pane / F5 to spawn a
/// terminal running the right thing in the right directory.
#[tauri::command]
pub fn detect_project(path: String) -> ProjectRun {
    let mut dir = std::path::PathBuf::from(&path);
    if dir.is_file() {
        if let Some(p) = dir.parent() {
            dir = p.to_path_buf();
        }
    }
    for _ in 0..12 {
        if let Some((kind, commands)) = project_at(&dir) {
            return ProjectRun {
                kind,
                root: Some(dir.to_string_lossy().to_string()),
                commands,
            };
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
    ProjectRun { kind: "unknown".into(), root: None, commands: Vec::new() }
}

#[derive(Serialize)]
pub struct ProjectInfo {
    /// Directory name of the project root (display title).
    name: String,
    /// Absolute path of the project root.
    root: String,
    /// "flutter" | "node" | "rust" | "go" | "python" | "make"
    kind: String,
    /// Candidate run commands; the first is the primary (default for the palette).
    commands: Vec<RunCommand>,
    /// Unix epoch seconds of the project dir's last modification.
    mtime: u64,
}

/// Directory names we never descend into — heavy build/dep/vcs dirs that would
/// blow up the scan and never contain a project root worth running on its own.
fn is_pruned_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | "build"
            | "target"
            | "dist"
            | ".next"
            | "Pods"
            | ".dart_tool"
            | "vendor"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".turbo"
            | ".cache"
    )
}

/// Scans `~/Repo` (bounded depth ~4) for runnable project roots. A directory is
/// a project if `project_at` recognizes a marker in it; once found we record it
/// and STOP descending (the marker dir is the project — nested sub-packages are
/// not surfaced as separate run targets here). Heavy dirs (node_modules, target,
/// .git, …) are pruned. Results are capped, deduped by root, and sorted by name.
/// Reuses `project_at` so command derivation is identical to F5 / `detect_project`.
#[tauri::command]
pub fn list_projects() -> Vec<ProjectInfo> {
    const MAX_DEPTH: usize = 4;
    const CAP: usize = 200;

    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let repo_root = std::path::Path::new(&home).join("Repo");

    let mut out: Vec<ProjectInfo> = Vec::new();
    // (dir, depth) stack — iterative to bound recursion + allow early cap.
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(repo_root, 0)];

    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= CAP {
            break;
        }
        // If this dir is a project root, record it. Still descend afterward:
        // many AIOS workspaces are monorepos with runnable nested apps, and the
        // command palette must surface the actual app, not only the parent.
        if let Some((kind, commands)) = project_at(&dir) {
            let name = dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| dir.to_string_lossy().to_string());
            let mtime = std::fs::metadata(&dir)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(ProjectInfo {
                name,
                root: dir.to_string_lossy().to_string(),
                kind,
                commands,
                mtime,
            });
        }
        if depth >= MAX_DEPTH {
            continue;
        }
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || is_pruned_dir(&name) {
                continue;
            }
            let is_dir = e
                .file_type()
                .map(|t| t.is_dir())
                .unwrap_or_else(|_| e.path().is_dir());
            if is_dir {
                stack.push((e.path(), depth + 1));
            }
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out.truncate(CAP);
    out
}

/// Reads package.json `scripts` and turns them into `<pm> run <name>` commands,
/// dev/start/serve first. Picks the package manager from the lockfile present.
fn node_scripts(dir: &std::path::Path) -> Vec<RunCommand> {
    let pm = if dir.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if dir.join("yarn.lock").is_file() {
        "yarn"
    } else if dir.join("bun.lockb").is_file() {
        "bun"
    } else {
        "npm"
    };
    let mut out = Vec::new();
    if let Ok(text) = std::fs::read_to_string(dir.join("package.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            let is_react_native = json
                .get("dependencies")
                .and_then(|d| d.as_object())
                .is_some_and(|d| d.contains_key("react-native"));
            if let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) {
                let mut names: Vec<&String> = scripts.keys().collect();
                // priority order first, then the rest alphabetically
                let prio: &[&str] = if is_react_native {
                    &["android", "ios", "start", "test", "lint"]
                } else {
                    &["dev", "start", "serve", "build", "test"]
                };
                names.sort_by_key(|n| {
                    prio.iter().position(|p| *p == n.as_str()).unwrap_or(prio.len() + 1)
                });
                for name in names {
                    let run = if pm == "npm" {
                        format!("npm run {name}")
                    } else {
                        format!("{pm} {name}")
                    };
                    out.push(RunCommand { label: run.clone(), cmd: run });
                }
            }
        }
    }
    if out.is_empty() {
        out.push(RunCommand {
            label: format!("{pm} start"),
            cmd: format!("{pm} start"),
        });
    }
    out
}

/// Returns the user's home directory (HOME, then USERPROFILE on Windows).
#[tauri::command]
pub fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| if cfg!(windows) { "C:\\".into() } else { "/".into() })
}

/// Builds a `file://` URL from an absolute path, cross-platform. On Windows
/// `C:\Users\…` → `file:///C:/Users/…`; on unix `/tmp/…` → `file:///tmp/…`.
fn url_from_path(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

/// Cap on editable text files: 8 MB. Larger files are refused (the editor isn't
/// meant for huge blobs — guards against loading a gigabyte into the webview).
const EDIT_TEXT_CAP: u64 = 8 * 1024 * 1024;

/// Reads a file's full UTF-8 contents for the editor pane. Refuses files over
/// the cap or that aren't valid UTF-8 (binary). Errors are returned as strings.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("{e}"))?;
    if meta.len() > EDIT_TEXT_CAP {
        return Err(format!(
            "file too large to edit ({} MB > 8 MB)",
            meta.len() / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{e}"))?;
    String::from_utf8(bytes).map_err(|_| "not a UTF-8 text file".to_string())
}

/// File modification time in unix MILLISECONDS (0 if unavailable). Higher
/// precision than the seconds used in directory listings, so the editor's
/// save-conflict guard can tell two saves a fraction of a second apart apart.
fn file_mtime_ms(path: &std::path::Path) -> f64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Returns a file's last-modified time in unix milliseconds (0 if missing /
/// unavailable). The editor pane captures this on load so it can detect a
/// conflicting on-disk change before overwriting (AI + human editing the same
/// file). Cheap stat — safe to call on every open/save.
#[tauri::command]
pub fn file_mtime(path: String) -> f64 {
    file_mtime_ms(std::path::Path::new(&path))
}

/// Writes UTF-8 contents back to a file (editor save). Writes to a temp file in
/// the same dir then renames, so a crash mid-write can't truncate the original.
///
/// SAVE-CONFLICT GUARD: when `expected_mtime` is provided (the mtime the editor
/// captured when it loaded the file), the on-disk mtime is re-checked just
/// before the rename. If it changed, the file was modified by someone else (a
/// human, or the AI) since load — we abort with a `conflict:<current_mtime>`
/// error rather than silently clobbering their work. The frontend parses the
/// `conflict:` prefix to show a reload/overwrite prompt. A bare overwrite (no
/// guard) is still possible by passing `expected_mtime = None`.
#[tauri::command]
pub fn write_text_file(
    path: String,
    content: String,
    expected_mtime: Option<f64>,
) -> Result<f64, String> {
    let p = std::path::Path::new(&path);
    // Conflict check: tolerate sub-millisecond float jitter. A real external
    // write moves the mtime by far more than 1ms, so a >1ms delta = conflict.
    if let Some(expected) = expected_mtime {
        if expected > 0.0 {
            let current = file_mtime_ms(p);
            if current > 0.0 && (current - expected).abs() > 1.0 {
                return Err(format!("conflict:{current}"));
            }
        }
    }
    let dir = p.parent().ok_or_else(|| "invalid path".to_string())?;
    let tmp = dir.join(format!(
        ".{}.aios-tmp",
        p.file_name().and_then(|s| s.to_str()).unwrap_or("file")
    ));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("{e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| format!("{e}"))?;
    // Hand the new mtime back so the editor re-bases its conflict guard without a
    // second stat round-trip.
    Ok(file_mtime_ms(p))
}

/// Delete a single file (used by the notes pane — full CRUD). Refuses to touch
/// directories so a bad path can't nuke a tree; a missing file is a no-op (the
/// note is already gone, which is the caller's intent).
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        return Err("refusing to delete a directory".into());
    }
    std::fs::remove_file(p).map_err(|e| format!("{e}"))?;
    Ok(())
}

/// Cap on inline text payloads: ~256 KB.
const PREVIEW_TEXT_CAP: usize = 256 * 1024;

/// Reads a file for preview. Returns a JSON value:
/// `{ kind: "text"|"image"|"pdf"|"binary", text: string|null, size: number,
///    name: string, truncated: bool }`.
/// Defensive — never panics; bad paths return an `Err` string.
#[tauri::command]
pub fn read_file_preview(path: String) -> Result<serde_json::Value, String> {
    use serde_json::json;

    let p = std::path::Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    let size = meta.len();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    // Images — frontend renders via the asset protocol, no inline payload.
    if matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico"
    ) {
        return Ok(json!({
            "kind": "image",
            "text": serde_json::Value::Null,
            "size": size,
            "name": name,
            "truncated": false,
        }));
    }

    // PDFs — frontend renders via the asset protocol.
    if ext == "pdf" {
        return Ok(json!({
            "kind": "pdf",
            "text": serde_json::Value::Null,
            "size": size,
            "name": name,
            "truncated": false,
        }));
    }

    // Office docs (word/excel/powerpoint + OpenDocument + rtf) — frontend asks
    // for an on-demand LibreOffice → PDF conversion and then renders that PDF.
    if is_office_ext(&ext) {
        return Ok(json!({
            "kind": "office",
            "text": serde_json::Value::Null,
            "size": size,
            "name": name,
            "truncated": false,
        }));
    }

    // Read up to the cap (plus a byte to detect truncation).
    let to_read = (size as usize).min(PREVIEW_TEXT_CAP) + 1;
    let mut bytes = Vec::with_capacity(to_read.min(PREVIEW_TEXT_CAP + 1));
    {
        use std::io::Read;
        let f = std::fs::File::open(p).map_err(|e| e.to_string())?;
        let mut handle = f.take((PREVIEW_TEXT_CAP + 1) as u64);
        handle.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    }

    let truncated = bytes.len() > PREVIEW_TEXT_CAP;
    if truncated {
        bytes.truncate(PREVIEW_TEXT_CAP);
    }

    // Quick media detection: route common video formats directly into the in-pane
    // player instead of generic binary rendering.
    if matches!(ext.as_str(), "mp4" | "mov" | "webm" | "m4v" | "avi" | "mkv") {
        return Ok(json!({
            "kind": "video",
            "text": serde_json::Value::Null,
            "size": size,
            "name": name,
            "truncated": false,
        }));
    }

    // Known text/code extensions, OR anything that decodes cleanly as UTF-8.
    let texty = matches!(
        ext.as_str(),
        "txt" | "md" | "markdown" | "json" | "jsonl" | "csv" | "tsv" | "yaml" | "yml"
            | "toml" | "log" | "ini" | "cfg" | "conf" | "env" | "xml" | "html" | "htm"
            | "css" | "scss" | "less" | "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs"
            | "rs" | "py" | "rb" | "go" | "java" | "kt" | "kts" | "swift" | "c" | "h"
            | "cpp" | "cc" | "hpp" | "cs" | "php" | "sh" | "bash" | "zsh" | "fish"
            | "sql" | "dart" | "lua" | "pl" | "r" | "scala" | "clj" | "ex" | "exs"
            | "elm" | "vue" | "svelte" | "graphql" | "gql" | "proto" | "dockerfile"
            | "makefile" | "gradle" | "properties" | "diff" | "patch" | "lock" | "gitignore"
    );

    match std::str::from_utf8(&bytes) {
        Ok(s) if texty || !bytes.is_empty() => Ok(json!({
            "kind": "text",
            "text": s,
            "size": size,
            "name": name,
            "truncated": truncated,
        })),
        // Empty file → treat as empty text.
        Ok(_) => Ok(json!({
            "kind": "text",
            "text": "",
            "size": size,
            "name": name,
            "truncated": false,
        })),
        Err(_) => Ok(json!({
            "kind": "binary",
            "text": serde_json::Value::Null,
            "size": size,
            "name": name,
            "truncated": false,
        })),
    }
}

/// Office / document formats LibreOffice can render to PDF.
fn is_office_ext(ext: &str) -> bool {
    matches!(
        ext,
        "doc" | "docx" | "docm" | "dot" | "dotx" | "rtf" | "odt" | "ott" | "fodt"
            | "xls" | "xlsx" | "xlsm" | "xlsb" | "ods" | "ots" | "fods"
            | "ppt" | "pptx" | "pptm" | "pps" | "ppsx" | "odp" | "otp" | "fodp"
    )
}

/// Locates the LibreOffice headless binary across the common install spots.
fn soffice_bin() -> Option<String> {
    #[cfg(windows)]
    {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(pf) = std::env::var(var) {
                let p = format!(r"{pf}\LibreOffice\program\soffice.exe");
                if std::path::Path::new(&p).exists() {
                    return Some(p);
                }
            }
        }
        return Some("soffice.exe".to_string());
    }
    #[cfg(not(windows))]
    {
        let candidates = [
            "/opt/homebrew/bin/soffice",
            "/usr/local/bin/soffice",
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
            "/usr/bin/soffice",
            "/usr/bin/libreoffice",
        ];
        for c in candidates {
            if std::path::Path::new(c).exists() {
                return Some(c.to_string());
            }
        }
        // Last resort: rely on PATH resolution.
        Some("soffice".to_string())
    }
}

/// FNV-1a — small, dependency-free hash for cache-key derivation.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Converts an office document to PDF via headless LibreOffice and returns the
/// resulting PDF path. Output lands under `/tmp/aios-office-preview/` (in the
/// asset-protocol scope) and is cached by source path + mtime + size, so
/// re-opening an unchanged file is instant. A per-call user profile dir lets
/// this run even while the LibreOffice GUI is open.
#[tauri::command]
pub fn convert_office_to_pdf(path: String) -> Result<String, String> {
    let src = std::path::Path::new(&path);
    let meta = std::fs::metadata(src).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }

    // Cache key: source path + mtime + size → stable while the file is unchanged.
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = fnv1a(&format!("{}|{}|{}", path, mtime, meta.len()));

    let preview_root = std::env::temp_dir().join("aios-office-preview");
    let out_dir = preview_root.join(format!("{key:x}"));
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".into());
    let out_pdf = out_dir.join(format!("{stem}.pdf"));

    // Cached hit — return immediately.
    if out_pdf.exists() {
        return Ok(out_pdf.to_string_lossy().to_string());
    }

    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let bin = soffice_bin().ok_or("LibreOffice (soffice) not found")?;
    // Isolated profile so we don't clash with a running LibreOffice instance.
    // Build the file:// URL from the platform temp dir (valid on Windows too).
    let profile_url = url_from_path(&preview_root.join(format!(".profile-{key:x}")));
    let profile = format!("-env:UserInstallation={profile_url}");

    let output = std::process::Command::new(&bin)
        .arg("--headless")
        .arg(&profile)
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(&out_dir)
        .arg(src)
        .output()
        .map_err(|e| format!("failed to launch soffice: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("conversion failed: {}", err.trim()));
    }

    if out_pdf.exists() {
        return Ok(out_pdf.to_string_lossy().to_string());
    }

    // soffice occasionally sanitizes the output stem — fall back to whatever
    // single PDF it dropped in the (otherwise empty) output dir.
    if let Ok(rd) = std::fs::read_dir(&out_dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "pdf").unwrap_or(false) {
                return Ok(p.to_string_lossy().to_string());
            }
        }
    }

    Err("conversion produced no PDF".into())
}

/// Decodes standard base64 (no whitespace/newlines tolerated beyond what we
/// strip) into bytes. Dependency-free so we don't pull a crate just for paste.
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for c in input.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' || c == b'\t' {
            continue;
        }
        let v = val(c).ok_or("invalid base64 character")?;
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

/// Persists a clipboard / dropped image to a temp file and returns its path, so
/// the terminal can hand the path to a CLI AI (claude code) for vision.
///
/// `data` is the raw base64 of the image bytes (NOT a data-URL — the frontend
/// strips the `data:image/png;base64,` prefix). `ext` is the desired file
/// extension (e.g. "png", "jpg"). The file lands under `/tmp/aios-paste/` with
/// a content-hashed name so repeated pastes of the same image dedupe.
#[tauri::command]
pub fn save_image_temp(data: String, ext: String) -> Result<String, String> {
    let bytes = base64_decode(&data)?;
    if bytes.is_empty() {
        return Err("empty image data".into());
    }
    let safe_ext: String = ext
        .trim_start_matches('.')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let safe_ext = if safe_ext.is_empty() { "png".into() } else { safe_ext };

    let dir = std::env::temp_dir().join("aios-paste");
    let dir = dir.as_path();
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let key = fnv1a(&format!("{}|{}", bytes.len(), bytes.iter().take(4096).fold(0u64, |a, &b| a.wrapping_add(b as u64))));
    let path = dir.join(format!("paste-{key:x}.{safe_ext}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// ── Cmd+P file finder + Cmd+Shift+F content search ──────────────────────────

/// Directory names always skipped by the file finder + content search, on top
/// of whatever `.gitignore` excludes. These are heavy build/dep/vcs dirs the
/// `ignore` walker doesn't drop by default (it only knows .git).
fn is_search_pruned_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".turbo"
            | ".cache"
            | ".dart_tool"
            | "Pods"
            | "vendor"
            | ".venv"
            | "venv"
            | "__pycache__"
    )
}

/// Builds an `ignore`-crate walker rooted at `root` that honors `.gitignore`
/// (and global/parent gitignores) and also prunes our extra junk dirs. Shared
/// by `find_files` and the search fallback so both respect identical rules.
fn search_walk_builder(root: &str) -> ignore::WalkBuilder {
    let mut b = ignore::WalkBuilder::new(root);
    b.hidden(false) // show dotfiles (.claude, .env) like VS Code; we prune junk explicitly
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .filter_entry(|e| {
            // Prune our extra heavy dirs by name (applies to directories only).
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(name) = e.file_name().to_str() {
                    return !is_search_pruned_dir(name);
                }
            }
            // Always drop .DS_Store noise.
            e.file_name().to_str() != Some(".DS_Store")
        });
    b
}

/// Recursively lists file paths under `root`, RELATIVE to `root`, files only.
/// Honors `.gitignore` (+ global/parent) and prunes heavy dirs (node_modules,
/// target, dist, .next, …). Capped at `max` (default 20000) so a giant tree
/// can't run away — returns whatever was found up to the cap. Powers Cmd+P.
#[tauri::command]
pub fn find_files(root: String, max: Option<usize>) -> Result<Vec<String>, String> {
    let cap = max.unwrap_or(20000);
    let root_path = std::path::Path::new(&root);
    if !root_path.is_dir() {
        return Err("root is not a directory".into());
    }

    let mut out: Vec<String> = Vec::new();
    for dent in search_walk_builder(&root).build() {
        if out.len() >= cap {
            break;
        }
        let dent = match dent {
            Ok(d) => d,
            Err(_) => continue,
        };
        // Files only (depth 0 is the root dir itself).
        if dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            let rel = dent
                .path()
                .strip_prefix(root_path)
                .unwrap_or(dent.path());
            out.push(rel.to_string_lossy().to_string());
        }
    }
    Ok(out)
}

/// Deterministically resolves a file `reference` (as emitted by an LLM in chat
/// — a bare name, a relative path, or an absolute/`~` path) against the chat
/// session's working dir. Returns the canonical absolute path ONLY if it points
/// at a file that actually exists; `None` otherwise. This is the gold-source
/// check behind chat's "open in pane" affordance — we never search-by-name and
/// hope. The resolution order mirrors how a human reads a path the model wrote:
///   1. absolute (`/…`) or home (`~/…`) — used as-is;
///   2. exact join against `cwd` (`{cwd}/{ref}`) — the common case;
///   3. nothing matched → `None` (caller may fall back to a bounded fuzzy find).
/// Symlinks/`..` are collapsed via `canonicalize`, which also confirms existence.
#[tauri::command]
pub fn resolve_in_cwd(cwd: String, reference: String) -> Option<String> {
    let r = reference.trim();
    if r.is_empty() {
        return None;
    }
    // strip a trailing :line[:col] suffix (e.g. "src/x.rs:42") the model may add.
    let r = r
        .rsplit_once(':')
        .and_then(|(head, tail)| {
            if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) && !head.is_empty() {
                Some(head)
            } else {
                None
            }
        })
        .unwrap_or(r);

    let candidate: std::path::PathBuf = if let Some(rest) = r.strip_prefix("~/") {
        std::path::Path::new(&home_dir()).join(rest)
    } else if r == "~" {
        std::path::PathBuf::from(home_dir())
    } else if r.starts_with('/') {
        std::path::PathBuf::from(r)
    } else if cwd.trim().is_empty() {
        // no cwd to anchor a relative ref against → can't resolve deterministically.
        return None;
    } else {
        std::path::Path::new(&cwd).join(r)
    };

    let canon = candidate.canonicalize().ok()?;
    if canon.is_file() {
        Some(canon.to_string_lossy().to_string())
    } else {
        None
    }
}

/// One content-search match. `path` is relative to the search root, `line`/`col`
/// are 1-based, `text` is the matching line trimmed + capped at ~300 chars.
#[derive(Serialize)]
pub struct SearchHit {
    path: String,
    line: u32,
    col: u32,
    text: String,
}

const HIT_TEXT_CAP: usize = 300;

/// Trims a matching line and caps it at `HIT_TEXT_CAP` chars (char-boundary safe).
fn cap_hit_text(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= HIT_TEXT_CAP {
        return t.to_string();
    }
    t.chars().take(HIT_TEXT_CAP).collect()
}

/// Locates a real `rg` (ripgrep) binary on disk. Returns `None` if not found,
/// in which case the Rust fallback scanner is used. (We avoid bare "rg" /
/// PATH lookup because the GUI-launched process has a minimal PATH.)
fn ripgrep_bin() -> Option<String> {
    let candidates = [
        "/opt/homebrew/bin/rg",
        "/usr/local/bin/rg",
        "/usr/bin/rg",
    ];
    for c in candidates {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    None
}

/// Case-insensitive literal substring search of file CONTENTS under `root`.
/// Honors the same ignore rules as `find_files`. Returns up to `max` hits
/// (default 1000). Uses `rg --json` when a ripgrep binary is present (fast +
/// correct, skips binaries); falls back to a Rust line scanner via the
/// `ignore` walker otherwise. Powers Cmd+Shift+F.
#[tauri::command]
pub fn search_in_files(
    root: String,
    query: String,
    max: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let cap = max.unwrap_or(1000);
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let root_path = std::path::Path::new(&root);
    if !root_path.is_dir() {
        return Err("root is not a directory".into());
    }

    if let Some(rg) = ripgrep_bin() {
        return search_with_rg(&rg, root_path, &query, cap);
    }
    search_with_ignore(root_path, &query, cap)
}

/// Runs `rg --json` for a fixed (literal), case-insensitive substring search and
/// parses the streaming JSON match objects into `SearchHit`s.
fn search_with_rg(
    rg: &str,
    root: &std::path::Path,
    query: &str,
    cap: usize,
) -> Result<Vec<SearchHit>, String> {
    let output = std::process::Command::new(rg)
        .arg("--json")
        .arg("--fixed-strings") // literal, not regex
        .arg("--ignore-case")
        .arg("--max-count")
        .arg(cap.to_string()) // per-file cap; total bounded below too
        .arg("--")
        .arg(query)
        .arg(".")
        .current_dir(root)
        .output()
        .map_err(|e| format!("failed to launch rg: {e}"))?;

    // rg exits 1 when there are no matches — that's not an error for us.
    if !output.status.success() && output.status.code() != Some(1) {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rg failed: {}", err.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut hits: Vec<SearchHit> = Vec::new();
    for line in stdout.lines() {
        if hits.len() >= cap {
            break;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("match") {
            continue;
        }
        let data = match v.get("data") {
            Some(d) => d,
            None => continue,
        };
        let path = data
            .get("path")
            .and_then(|p| p.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim_start_matches("./")
            .to_string();
        let line_no = data
            .get("line_number")
            .and_then(|n| n.as_u64())
            .unwrap_or(0) as u32;
        let text = data
            .get("lines")
            .and_then(|l| l.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        // First submatch column (byte offset → 1-based col, best-effort).
        let col = data
            .get("submatches")
            .and_then(|s| s.as_array())
            .and_then(|a| a.first())
            .and_then(|m| m.get("start"))
            .and_then(|n| n.as_u64())
            .map(|n| n as u32 + 1)
            .unwrap_or(1);
        hits.push(SearchHit {
            path,
            line: line_no,
            col,
            text: cap_hit_text(text),
        });
    }
    Ok(hits)
}

/// Pure-Rust fallback: walk via the `ignore` crate and scan each text file line
/// by line for a case-insensitive literal substring. Skips files that aren't
/// valid UTF-8 (binary) and large files.
fn search_with_ignore(
    root: &std::path::Path,
    query: &str,
    cap: usize,
) -> Result<Vec<SearchHit>, String> {
    let needle = query.to_lowercase();
    let mut hits: Vec<SearchHit> = Vec::new();

    for dent in search_walk_builder(&root.to_string_lossy()).build() {
        if hits.len() >= cap {
            break;
        }
        let dent = match dent {
            Ok(d) => d,
            Err(_) => continue,
        };
        if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        // Skip very large files outright (binary or generated blobs).
        if dent.metadata().map(|m| m.len() > EDIT_TEXT_CAP).unwrap_or(false) {
            continue;
        }
        let bytes = match std::fs::read(dent.path()) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Binary heuristic: a NUL byte → skip.
        if bytes.contains(&0) {
            continue;
        }
        let content = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let rel = dent
            .path()
            .strip_prefix(root)
            .unwrap_or(dent.path())
            .to_string_lossy()
            .to_string();
        for (i, line) in content.lines().enumerate() {
            if hits.len() >= cap {
                break;
            }
            let lower = line.to_lowercase();
            if let Some(byte_idx) = lower.find(&needle) {
                // byte index in the lowercased line ≈ col for ascii; good enough.
                let col = line[..byte_idx.min(line.len())].chars().count() as u32 + 1;
                hits.push(SearchHit {
                    path: rel.clone(),
                    line: (i + 1) as u32,
                    col,
                    text: cap_hit_text(line),
                });
            }
        }
    }
    Ok(hits)
}
