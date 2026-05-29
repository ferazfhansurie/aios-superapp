//! Minimal filesystem commands for the Files pane.

use serde::Serialize;

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
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
        let is_dir = e.metadata().map(|m| m.is_dir()).unwrap_or(false);
        entries.push(DirEntry {
            name,
            path: e.path().to_string_lossy().to_string(),
            is_dir,
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
