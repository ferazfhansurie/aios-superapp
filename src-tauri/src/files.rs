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

/// Returns the user's home directory.
#[tauri::command]
pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
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
