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
        std::env::var("HOME").unwrap_or_else(|_| "/".into())
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

/// Like `read_dir` but for the VS Code-style explorer tree: shows dotfiles
/// (`.claude`, `.vercel`, …) the way VS Code does, hiding only `.git` and
/// `.DS_Store`. Same sort (dirs first, alphabetical).
#[tauri::command]
pub fn read_dir_tree(path: String) -> Result<Vec<DirEntry>, String> {
    let p = if path.is_empty() {
        std::env::var("HOME").unwrap_or_else(|_| "/".into())
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
        if name == ".git" || name == ".DS_Store" {
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
        let here = dir.to_string_lossy().to_string();
        let has = |f: &str| dir.join(f).is_file();

        if has("pubspec.yaml") {
            return ProjectRun {
                kind: "flutter".into(),
                root: Some(here),
                commands: vec![
                    RunCommand { label: "flutter run".into(), cmd: "flutter run".into() },
                    RunCommand { label: "flutter run --release".into(), cmd: "flutter run --release".into() },
                    RunCommand { label: "flutter test".into(), cmd: "flutter test".into() },
                ],
            };
        }
        if has("package.json") {
            return ProjectRun {
                kind: "node".into(),
                root: Some(here.clone()),
                commands: node_scripts(&dir),
            };
        }
        if has("Cargo.toml") {
            return ProjectRun {
                kind: "rust".into(),
                root: Some(here),
                commands: vec![
                    RunCommand { label: "cargo run".into(), cmd: "cargo run".into() },
                    RunCommand { label: "cargo test".into(), cmd: "cargo test".into() },
                    RunCommand { label: "cargo build".into(), cmd: "cargo build".into() },
                ],
            };
        }
        if has("go.mod") {
            return ProjectRun {
                kind: "go".into(),
                root: Some(here),
                commands: vec![
                    RunCommand { label: "go run .".into(), cmd: "go run .".into() },
                    RunCommand { label: "go test ./...".into(), cmd: "go test ./...".into() },
                ],
            };
        }
        if has("pyproject.toml") || has("requirements.txt") || has("manage.py") {
            let cmd = if has("manage.py") {
                "python manage.py runserver"
            } else {
                "python main.py"
            };
            return ProjectRun {
                kind: "python".into(),
                root: Some(here),
                commands: vec![RunCommand { label: cmd.into(), cmd: cmd.into() }],
            };
        }
        if has("Makefile") {
            return ProjectRun {
                kind: "make".into(),
                root: Some(here),
                commands: vec![RunCommand { label: "make".into(), cmd: "make".into() }],
            };
        }

        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
    ProjectRun { kind: "unknown".into(), root: None, commands: Vec::new() }
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
            if let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) {
                let mut names: Vec<&String> = scripts.keys().collect();
                // priority order first, then the rest alphabetically
                let prio = ["dev", "start", "serve", "build", "test"];
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

/// Returns the user's home directory.
#[tauri::command]
pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
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

/// Writes UTF-8 contents back to a file (editor save). Writes to a temp file in
/// the same dir then renames, so a crash mid-write can't truncate the original.
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = p.parent().ok_or_else(|| "invalid path".to_string())?;
    let tmp = dir.join(format!(
        ".{}.aios-tmp",
        p.file_name().and_then(|s| s.to_str()).unwrap_or("file")
    ));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("{e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| format!("{e}"))?;
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

    let out_dir = std::path::Path::new("/tmp/aios-office-preview").join(format!("{key:x}"));
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
    let profile = format!(
        "-env:UserInstallation=file:///tmp/aios-office-preview/.profile-{key:x}"
    );

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
