//! Memory vault graph — read-only parser for the obsidian-shaped memory store.
//!
//! The vault is a flat directory of markdown files. Each file has YAML
//! frontmatter (`name`, `description`, `metadata.type`) followed by a body that
//! may reference other notes via `[[wikilink]]` syntax. This module reads every
//! `*.md` in the vault, extracts node metadata + outbound links, and returns a
//! graph (`nodes` + `edges`) the cockpit renders as a force-directed view.
//!
//! Vault path resolves portably so the cockpit works for ANY user, not just the
//! original author. Resolution order (first that exists wins):
//!   1. `$AIOS_MEMORY_VAULT` — explicit override, used verbatim if it's a dir.
//!   2. `$HOME/.claude/projects/<encoded-$HOME>/memory` — Claude Code encodes a
//!      project's cwd by replacing `/` with `-`; for the user's home dir this is
//!      their canonical per-project auto-memory vault.
//!   3. `$HOME/.claude/projects/*/memory` — first existing per-project memory
//!      dir for whatever user (sorted for determinism).
//!   4. `$HOME/.claude/memory` — a flat top-level vault, if present.
//! When none exist the graph command returns an empty (but valid) graph rather
//! than panicking — graceful degradation on machines without AIOS memory.

use serde::Serialize;
use serde_json::{json, Value};
use walkdir::WalkDir;

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

#[derive(Debug, Clone, Serialize)]
pub struct MemoryHit {
    id: String,
    title: String,
    #[serde(rename = "type")]
    node_type: String,
    description: String,
    path: String,
    score: i32,
    reasons: Vec<String>,
    preview: String,
}

/// Resolves the memory vault directory in a portable, env-overridable way.
/// See the module header for the full precedence. Returns whatever path we
/// settle on — callers tolerate it being absent (empty graph).
fn vault_dir() -> std::path::PathBuf {
    // 1. Explicit override wins, used verbatim when it points at a real dir.
    if let Some(v) = std::env::var_os("AIOS_MEMORY_VAULT") {
        let p = std::path::PathBuf::from(v);
        if p.is_dir() {
            return p;
        }
    }

    let home = match std::env::var_os("HOME") {
        Some(h) => std::path::PathBuf::from(h),
        // No $HOME (rare for a GUI app) — nothing portable to resolve.
        None => return std::path::PathBuf::new(),
    };

    let projects = home.join(".claude").join("projects");

    // 2. Canonical per-project vault for the user's own home dir. Claude Code
    //    encodes a cwd by swapping every `/` (and `.`) for `-`; for `$HOME` this
    //    yields e.g. `-Users-alice`. Resolves to the author's existing path too.
    if let Some(home_str) = home.to_str() {
        // Claude Code encodes a cwd by replacing path-ish chars with '-'. On unix
        // that's '/' and '.'; on Windows the drive colon and backslashes too, so
        // `C:\Users\user` → `C--Users-user` (matching the real on-disk dir name).
        let encoded: String = home_str
            .chars()
            .map(|c| if matches!(c, '/' | '\\' | ':' | '.') { '-' } else { c })
            .collect();
        let p = projects.join(&encoded).join("memory");
        if p.is_dir() {
            return p;
        }
    }

    // 3. Otherwise pick the first existing `*/memory` under projects/ (sorted so
    //    the choice is stable across runs).
    if let Ok(rd) = std::fs::read_dir(&projects) {
        let mut candidates: Vec<std::path::PathBuf> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.path().join("memory"))
            .filter(|p| p.is_dir())
            .collect();
        candidates.sort();
        if let Some(first) = candidates.into_iter().next() {
            return first;
        }
    }

    // 4. A flat top-level vault, if the user keeps one there.
    let flat = home.join(".claude").join("memory");
    if flat.is_dir() {
        return flat;
    }

    // Nothing found — return an empty path; the walk below yields no nodes.
    std::path::PathBuf::new()
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

fn memory_nodes_from_dir(dir: &std::path::Path) -> Vec<(MemoryNode, String)> {
    let mut nodes: Vec<(MemoryNode, String)> = Vec::new();
    for entry in WalkDir::new(dir)
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
        nodes.push((
            MemoryNode {
                id,
                title,
                node_type,
                description,
                path: path.to_string_lossy().to_string(),
                links,
            },
            body.to_string(),
        ));
    }
    nodes.sort_by(|a, b| a.0.id.to_lowercase().cmp(&b.0.id.to_lowercase()));
    nodes
}

fn compact_preview(body: &str) -> String {
    let text = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if text.chars().count() > 180 {
        format!("{}…", text.chars().take(180).collect::<String>())
    } else {
        text
    }
}

fn score_memory(
    node: &MemoryNode,
    body: &str,
    query: &str,
    cwd: Option<&str>,
) -> Option<MemoryHit> {
    let q = query.trim().to_lowercase();
    let cwd = cwd.unwrap_or("").to_lowercase();
    let id = node.id.to_lowercase();
    let title = node.title.to_lowercase();
    let description = node.description.to_lowercase();
    let body_l = body.to_lowercase();
    let path = node.path.to_lowercase();
    let mut score = 0;
    let mut reasons = Vec::new();

    if !q.is_empty() {
        for token in q.split_whitespace() {
            if token.len() < 2 {
                continue;
            }
            if id.contains(token) {
                score += 18;
                reasons.push(format!("id matches `{token}`"));
            }
            if title.contains(token) {
                score += 24;
                reasons.push(format!("title matches `{token}`"));
            }
            if description.contains(token) {
                score += 14;
                reasons.push(format!("description matches `{token}`"));
            }
            if body_l.contains(token) {
                score += 6;
                reasons.push(format!("body mentions `{token}`"));
            }
        }
    }

    if !cwd.is_empty() && (path.contains(&cwd) || body_l.contains(&cwd)) {
        score += 16;
        reasons.push("matches current project path".to_string());
    }

    match node.node_type.as_str() {
        "user" | "identity" | "preference" => score += 5,
        "project" | "plan" | "workflow" => score += 4,
        _ => {}
    }
    score += (node.links.len() as i32).min(8);

    if score <= 0 {
        return None;
    }
    reasons.sort();
    reasons.dedup();
    Some(MemoryHit {
        id: node.id.clone(),
        title: node.title.clone(),
        node_type: node.node_type.clone(),
        description: node.description.clone(),
        path: node.path.clone(),
        score,
        reasons,
        preview: compact_preview(body),
    })
}

fn search_memory_dir(
    dir: &std::path::Path,
    query: String,
    cwd: Option<String>,
    limit: Option<u32>,
) -> Vec<MemoryHit> {
    let mut hits: Vec<MemoryHit> = memory_nodes_from_dir(dir)
        .into_iter()
        .filter_map(|(node, body)| score_memory(&node, &body, &query, cwd.as_deref()))
        .collect();
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.title.cmp(&b.title)));
    hits.truncate(limit.unwrap_or(8).clamp(1, 30) as usize);
    hits
}

/// Builds the full memory graph: nodes (one per `*.md`) and edges (one per
/// resolvable `[[link]]`). Returns `{ nodes, edges, vault_path, count }`.
/// Always succeeds — an unreadable/empty vault yields an empty graph.
#[tauri::command]
pub fn memory_graph() -> Value {
    let dir = vault_dir();
    let nodes: Vec<MemoryNode> = memory_nodes_from_dir(&dir)
        .into_iter()
        .map(|(node, _)| node)
        .collect();

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

#[tauri::command]
pub fn memory_search(query: String, cwd: Option<String>, limit: Option<u32>) -> Vec<MemoryHit> {
    search_memory_dir(&vault_dir(), query, cwd, limit)
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

/// The idle homescreen's FOCUS tile: the freshest curated note in the vault,
/// surfaced as `{ tag, title }`. Prefers the newest `project_*.md` (the user's
/// current focus); if there are none, falls back to the newest note overall.
/// Always returns a valid object — an empty/absent vault yields nulls.
#[tauri::command]
pub fn memory_focus() -> Value {
    use std::time::SystemTime;
    let dir = vault_dir();
    let mut newest_project: Option<(SystemTime, std::path::PathBuf)> = None;
    let mut newest_any: Option<(SystemTime, std::path::PathBuf)> = None;

    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some("md") {
                continue;
            }
            let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if fname.eq_ignore_ascii_case("MEMORY.md") {
                continue;
            }
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            if fname.starts_with("project_")
                && newest_project.as_ref().map_or(true, |(t, _)| mtime > *t)
            {
                newest_project = Some((mtime, path.clone()));
            }
            if newest_any.as_ref().map_or(true, |(t, _)| mtime > *t) {
                newest_any = Some((mtime, path));
            }
        }
    }

    let Some((_, path)) = newest_project.or(newest_any) else {
        return json!({ "tag": Value::Null, "title": Value::Null });
    };

    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let (fm, _body) = split_frontmatter(&text);
    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    let name = frontmatter_field(fm, "name").unwrap_or(id);
    let tag = name.trim_start_matches("project_").replace('_', " ");
    let title = frontmatter_field(fm, "description").unwrap_or_default();

    json!({
        "tag": if tag.trim().is_empty() { Value::Null } else { json!(tag.trim()) },
        "title": if title.trim().is_empty() { Value::Null } else { json!(title.trim()) },
    })
}

/// A slug is safe if it's a bare filename — letters, digits, `-`, `_` only.
/// Rejects path separators, dots, and traversal so writes stay in the vault.
fn safe_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 120
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Creates or updates a memory note, writing `<vault>/<name>.md` with standard
/// frontmatter and keeping the `MEMORY.md` index line in sync. When `old_name`
/// differs from `name` the prior file + index line are removed (a rename).
/// Returns the absolute path written.
#[tauri::command]
pub fn memory_save(
    name: String,
    node_type: String,
    description: String,
    body: String,
    old_name: Option<String>,
) -> Result<String, String> {
    if !safe_slug(&name) {
        return Err("name must be a slug: letters, digits, - or _ only".into());
    }
    let dir = vault_dir();
    if !dir.is_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }

    // type defaults to a sane bucket if blank.
    let ntype = if node_type.trim().is_empty() {
        "reference".to_string()
    } else {
        node_type.trim().to_string()
    };

    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("name: {name}\n"));
    out.push_str(&format!(
        "description: {}\n",
        description.replace('\n', " ").trim()
    ));
    out.push_str("metadata:\n");
    out.push_str(&format!("  type: {ntype}\n"));
    out.push_str("---\n\n");
    out.push_str(body.trim_end());
    out.push('\n');

    let path = dir.join(format!("{name}.md"));
    std::fs::write(&path, &out).map_err(|e| e.to_string())?;

    // Rename: drop the previous file + index line if the slug changed.
    if let Some(old) = old_name.as_deref() {
        if old != name && safe_slug(old) {
            let old_path = dir.join(format!("{old}.md"));
            let _ = std::fs::remove_file(&old_path);
            update_index_remove(&dir, old);
        }
    }

    update_index_upsert(&dir, &name, &description);
    Ok(path.to_string_lossy().to_string())
}

/// Deletes a memory note and its `MEMORY.md` index line.
#[tauri::command]
pub fn memory_delete(name: String) -> Result<(), String> {
    if !safe_slug(&name) {
        return Err("invalid name".into());
    }
    let dir = vault_dir();
    let path = dir.join(format!("{name}.md"));
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    update_index_remove(&dir, &name);
    Ok(())
}

/// Inserts or replaces the `MEMORY.md` pointer line for a note. Best-effort —
/// the index is a convenience, so failures here don't fail the save.
fn update_index_upsert(dir: &std::path::Path, name: &str, description: &str) {
    let index = dir.join("MEMORY.md");
    let marker = format!("]({name}.md)");
    let hook = description.replace('\n', " ");
    let hook = hook.trim();
    let line = if hook.is_empty() {
        format!("- [{name}]({name}.md)")
    } else {
        format!("- [{name}]({name}.md) — {hook}")
    };

    let existing = std::fs::read_to_string(&index).unwrap_or_default();
    let mut lines: Vec<String> = existing.lines().map(|l| l.to_string()).collect();
    if let Some(pos) = lines.iter().position(|l| l.contains(&marker)) {
        lines[pos] = line;
    } else {
        if !lines.is_empty() && !existing.ends_with('\n') {
            // keep clean line boundaries
        }
        lines.push(line);
    }
    let _ = std::fs::write(&index, lines.join("\n") + "\n");
}

/// Removes a note's `MEMORY.md` pointer line, if present. Best-effort.
fn update_index_remove(dir: &std::path::Path, name: &str) {
    let index = dir.join("MEMORY.md");
    let marker = format!("]({name}.md)");
    let existing = match std::fs::read_to_string(&index) {
        Ok(s) => s,
        Err(_) => return,
    };
    let kept: Vec<&str> = existing.lines().filter(|l| !l.contains(&marker)).collect();
    let _ = std::fs::write(&index, kept.join("\n") + "\n");
}

#[cfg(test)]
mod tests {
    use super::search_memory_dir;

    #[test]
    fn memory_search_ranks_title_and_project_matches() {
        let root = std::env::temp_dir().join(format!("aios-memory-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("project_aios_shell.md"),
            r#"---
name: aios shell architecture
description: pane-native tauri superapp memory for firaz
metadata:
  type: project
---

repo: /Users/firazfhansurie/Repo/firaz/aios/shell
the shell uses panes, command registry, and memory context.
"#,
        )
        .unwrap();
        std::fs::write(
            root.join("random_reference.md"),
            r#"---
name: unrelated browser note
description: generic reference
metadata:
  type: reference
---

browser note that mentions shell once.
"#,
        )
        .unwrap();

        let hits = search_memory_dir(
            &root,
            "aios shell".to_string(),
            Some("/Users/firazfhansurie/Repo/firaz/aios/shell".to_string()),
            Some(5),
        );

        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "project_aios_shell");
        assert!(hits[0].score > hits[1].score);
        assert!(hits[0].reasons.iter().any(|r| r.contains("title")));
        assert!(hits[0]
            .reasons
            .iter()
            .any(|r| r == "matches current project path"));
        let _ = std::fs::remove_dir_all(root);
    }
}
