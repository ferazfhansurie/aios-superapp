//! Memory vault graph — read-only parser for the obsidian-shaped memory store.
//!
//! The vault is a flat directory of markdown files. Each file has YAML
//! frontmatter (`name`, `description`, `metadata.type`) followed by a body that
//! may reference other notes via `[[wikilink]]` syntax. This module reads every
//! `*.md` in the vault, extracts node metadata + outbound links, and returns a
//! graph (`nodes` + `edges`) the cockpit renders as a force-directed view.
//!
//! Vault path resolves from `$HOME` + a fixed suffix (Firaz's auto-memory dir),
//! with an env-independent absolute fallback so the command still works when a
//! GUI app launches with a stripped environment.

use serde::Serialize;
use serde_json::{json, Value};
use walkdir::WalkDir;

/// Fixed suffix under `$HOME` where the auto-memory vault lives.
const VAULT_SUFFIX: &str = ".claude/projects/-Users-firazfhansurie/memory";
/// Env-independent fallback (used when `$HOME` is unset or wrong).
const VAULT_FALLBACK: &str = "/Users/firazfhansurie/.claude/projects/-Users-firazfhansurie/memory";

/// A single memory note surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
struct MemoryNode {
    /// Filename without extension, e.g. `feedback_wa_must_go_through_push`.
    id: String,
    /// Frontmatter `name`, falling back to the id.
    title: String,
    /// Category from `metadata.type` (user/feedback/project/reference/…).
    #[serde(rename = "type")]
    node_type: String,
    /// Frontmatter `description`, empty when absent.
    description: String,
    /// Absolute path to the source file.
    path: String,
    /// Outbound `[[wikilink]]` targets that resolve to a known node.
    links: Vec<String>,
}

/// Resolves the vault directory, preferring `$HOME` then the absolute fallback.
fn vault_dir() -> std::path::PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        let p = std::path::PathBuf::from(home).join(VAULT_SUFFIX);
        if p.is_dir() {
            return p;
        }
    }
    std::path::PathBuf::from(VAULT_FALLBACK)
}

/// Extracts a top-level scalar frontmatter field (`name:`/`description:`) from a
/// YAML frontmatter block. Strips surrounding quotes. Returns `None` if absent.
fn frontmatter_field(fm: &str, key: &str) -> Option<String> {
    for line in fm.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix(key) {
            let rest = rest.trim_start();
            if let Some(val) = rest.strip_prefix(':') {
                let val = val.trim().trim_matches('"').trim_matches('\'').trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

/// Reads the `metadata.type` field (a nested key under `metadata:`). The vault
/// nests `type:` two-space-indented beneath a `metadata:` line.
fn metadata_type(fm: &str) -> Option<String> {
    let mut in_metadata = false;
    for line in fm.lines() {
        if line.trim_start().starts_with("metadata") && line.trim_end().ends_with(':') {
            in_metadata = true;
            continue;
        }
        if in_metadata {
            // Leave the block once a non-indented (top-level) key appears.
            if !line.starts_with(' ') && !line.starts_with('\t') && !line.trim().is_empty() {
                break;
            }
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("type:") {
                let val = rest.trim().trim_matches('"').trim_matches('\'').trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

/// Splits a markdown file into (frontmatter, body). When the file does not open
/// with a `---` fence, frontmatter is empty and the whole text is the body.
fn split_frontmatter(text: &str) -> (&str, &str) {
    let t = text.trim_start_matches('\u{feff}');
    if let Some(rest) = t.strip_prefix("---") {
        // Find the closing fence.
        if let Some(end) = rest.find("\n---") {
            let fm = &rest[..end];
            let body_start = end + 4; // skip "\n---"
            let body = rest[body_start..].trim_start_matches('\n');
            return (fm, body);
        }
    }
    ("", t)
}

/// Pulls every `[[target]]` link target from a body. Duplicates are de-duped,
/// insertion order preserved.
fn extract_links(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(close) = body[i + 2..].find("]]") {
                let raw = &body[i + 2..i + 2 + close];
                // Wikilinks may carry an alias (`target|alias`) or anchor
                // (`target#heading`) — keep only the bare target.
                let target = raw
                    .split('|')
                    .next()
                    .unwrap_or(raw)
                    .split('#')
                    .next()
                    .unwrap_or(raw)
                    .trim();
                if !target.is_empty() && !out.iter().any(|x| x == target) {
                    out.push(target.to_string());
                }
                i += 2 + close + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Infers a node type from its id prefix when frontmatter omits one
/// (e.g. `feedback_*`, `project_*`, `reference_*`, `MEMORY` → user).
fn type_from_id(id: &str) -> String {
    let lower = id.to_lowercase();
    if lower == "memory" {
        return "user".to_string();
    }
    for prefix in ["feedback", "project", "reference", "user"] {
        if lower.starts_with(&format!("{prefix}_")) {
            return prefix.to_string();
        }
    }
    "reference".to_string()
}

/// Builds the full memory graph: nodes (one per `*.md`) and edges (one per
/// resolvable `[[link]]`). Returns `{ nodes, edges, vault_path, count }`.
/// Always succeeds — an unreadable/empty vault yields an empty graph.
#[tauri::command]
pub fn memory_graph() -> Value {
    let dir = vault_dir();
    let mut nodes: Vec<MemoryNode> = Vec::new();

    // Walk only the top level (the vault is flat) but be tolerant of nesting.
    for entry in WalkDir::new(&dir)
        .max_depth(2)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(_) => continue,
        };

        let (fm, body) = split_frontmatter(&text);
        let title = frontmatter_field(fm, "name").unwrap_or_else(|| id.clone());
        let description = frontmatter_field(fm, "description").unwrap_or_default();
        let node_type = metadata_type(fm).unwrap_or_else(|| type_from_id(&id));
        let links = extract_links(body);

        nodes.push(MemoryNode {
            id,
            title,
            node_type,
            description,
            path: path.to_string_lossy().to_string(),
            links,
        });
    }

    nodes.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));

    // Edges only connect to nodes that actually exist in the vault.
    let known: std::collections::HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    let mut edges: Vec<Value> = Vec::new();
    for n in &nodes {
        for target in &n.links {
            if known.contains(target.as_str()) {
                edges.push(json!({ "source": n.id, "target": target }));
            }
        }
    }

    let count = nodes.len();
    json!({
        "nodes": nodes,
        "edges": edges,
        "vault_path": dir.to_string_lossy(),
        "count": count,
    })
}

/// Returns the raw contents of a memory file. Guarded: `path` must resolve to a
/// location inside the vault directory, otherwise the read is rejected.
#[tauri::command]
pub fn memory_file(path: String) -> Result<String, String> {
    let dir = vault_dir();
    let canon_dir = std::fs::canonicalize(&dir).unwrap_or(dir);
    let target = std::path::PathBuf::from(&path);
    let canon_target = std::fs::canonicalize(&target).map_err(|e| e.to_string())?;

    if !canon_target.starts_with(&canon_dir) {
        return Err("path is outside the memory vault".into());
    }
    if canon_target.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("not a markdown file".into());
    }
    std::fs::read_to_string(&canon_target).map_err(|e| e.to_string())
}
