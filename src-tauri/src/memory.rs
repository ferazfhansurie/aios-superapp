//! Memory vault graph — read-only parser for the obsidian-shaped memory store.
//!
//! The vault is a flat directory of markdown files. Each file has YAML
//! frontmatter (`name`, `description`, `metadata.type`) followed by a body that
//! may reference other notes via `[[wikilink]]` syntax. This module reads every
//! `*.md` in the vault, extracts node metadata + outbound links, and returns a
//! graph (`nodes` + `edges`) the cockpit renders as a force-directed view.
//!
//! Vault path resolves portably so the cockpit works for ANY user, not just the
//! original author. Save/create still target the primary vault, but search and
//! file reads scan every known vault:
//!   1. `$AIOS_MEMORY_VAULT` — explicit override, used verbatim if it's a dir.
//!   2. `$HOME/.claude/projects/<encoded-$HOME>/memory` — Claude Code encodes a
//!      project's cwd by replacing `/` with `-`; for the user's home dir this is
//!      their canonical per-project auto-memory vault.
//!   3. `$HOME/.claude/projects/*/memory` — first existing per-project memory
//!      dir for whatever user (sorted for determinism).
//!   4. `$HOME/.claude/memory` — a flat top-level vault, if present.
//!   5. `$HOME/.aios/state/memory` — AIOS-local memory, if present.
//! When none exist the graph command returns an empty (but valid) graph rather
//! than panicking — graceful degradation on machines without AIOS memory.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
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
    /// Human-readable source vault label.
    vault: String,
    /// Absolute path to the source vault.
    vault_path: String,
    /// File modified time, unix seconds.
    mtime: i64,
    /// Outbound `[[wikilink]]` targets that resolve to a known node.
    links: Vec<String>,
    /// Inbound links from notes that reference this node.
    backlinks: Vec<String>,
    /// Unlinked notes mentioned by id/title in this note body.
    suggested_links: Vec<String>,
    /// Link count used by the graph to size important memories.
    degree: usize,
    /// Stable graph cluster label.
    cluster: String,
    /// True when the node has no committed inbound/outbound edges.
    orphan: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryHit {
    id: String,
    title: String,
    #[serde(rename = "type")]
    node_type: String,
    description: String,
    path: String,
    vault: String,
    mtime: i64,
    score: i32,
    reasons: Vec<String>,
    preview: String,
}

#[derive(Debug, Clone)]
struct VaultDir {
    path: std::path::PathBuf,
    label: String,
    primary: bool,
}

fn push_vault(out: &mut Vec<VaultDir>, path: std::path::PathBuf, label: String, primary: bool) {
    if !path.is_dir() {
        return;
    }
    let canon = std::fs::canonicalize(&path).unwrap_or(path.clone());
    if out
        .iter()
        .any(|v| std::fs::canonicalize(&v.path).unwrap_or_else(|_| v.path.clone()) == canon)
    {
        return;
    }
    out.push(VaultDir {
        path,
        label,
        primary,
    });
}

/// Resolves every known memory vault. The first entry is the primary write
/// target; reads/searches can safely scan all entries.
fn vault_dirs() -> Vec<VaultDir> {
    let mut out = Vec::new();

    // 1. Explicit override wins and intentionally narrows the universe.
    if let Some(v) = std::env::var_os("AIOS_MEMORY_VAULT") {
        let p = std::path::PathBuf::from(v);
        if p.is_dir() {
            push_vault(&mut out, p, "override".to_string(), true);
            return out;
        }
    }

    let home = match std::env::var_os("HOME") {
        Some(h) => std::path::PathBuf::from(h),
        // No $HOME (rare for a GUI app) — nothing portable to resolve.
        None => return out,
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
            .map(|c| {
                if matches!(c, '/' | '\\' | ':' | '.') {
                    '-'
                } else {
                    c
                }
            })
            .collect();
        let p = projects.join(&encoded).join("memory");
        if p.is_dir() {
            push_vault(&mut out, p, "home".to_string(), true);
        }
    }

    // 3. Add every existing per-project memory vault, sorted for stable output.
    if let Ok(rd) = std::fs::read_dir(&projects) {
        let mut candidates: Vec<std::path::PathBuf> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.path().join("memory"))
            .filter(|p| p.is_dir())
            .collect();
        candidates.sort();
        for path in candidates {
            let label = path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("project")
                .trim_start_matches('-')
                .replace('-', "/");
            let primary = out.is_empty();
            push_vault(&mut out, path, label, primary);
        }
    }

    // 4. A flat top-level vault, if the user keeps one there.
    let flat = home.join(".claude").join("memory");
    let primary = out.is_empty();
    push_vault(&mut out, flat, "claude".to_string(), primary);

    // 5. AIOS-local memory stream/materialized notes.
    let aios = home.join(".aios").join("state").join("memory");
    let primary = out.is_empty();
    push_vault(&mut out, aios, "aios".to_string(), primary);

    out
}

/// Resolves the primary writable memory vault. Returns an empty path when no
/// vault exists; callers that write create it.
fn vault_dir() -> std::path::PathBuf {
    vault_dirs()
        .into_iter()
        .find(|v| v.primary)
        .map(|v| v.path)
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .map(|h| h.join(".claude").join("memory"))
                .unwrap_or_default()
        })
}

fn file_mtime_secs(path: &std::path::Path) -> i64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
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

fn memory_nodes_from_vault(dir: &std::path::Path, vault: &str) -> Vec<(MemoryNode, String)> {
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
                vault: vault.to_string(),
                vault_path: dir.to_string_lossy().to_string(),
                mtime: file_mtime_secs(path),
                links,
                backlinks: Vec::new(),
                suggested_links: Vec::new(),
                degree: 0,
                cluster: String::new(),
                orphan: true,
            },
            body.to_string(),
        ));
    }
    nodes.sort_by(|a, b| a.0.id.to_lowercase().cmp(&b.0.id.to_lowercase()));
    nodes
}

#[cfg(test)]
fn memory_nodes_from_dir(dir: &std::path::Path) -> Vec<(MemoryNode, String)> {
    memory_nodes_from_vault(dir, "primary")
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
    let mut score = if q.is_empty() { 1 } else { 0 };
    let mut reasons = Vec::new();
    // Did the query (or cwd) actually match this node? Baseline bonuses below
    // must NOT qualify a node on their own — otherwise the same well-connected
    // user/feedback notes surface for EVERY query ("always the same 3 auto
    // memories"). A real query requires a real match to be eligible.
    let mut relevance_hit = false;

    if !q.is_empty() {
        for token in q.split_whitespace() {
            if token.len() < 2 {
                continue;
            }
            if id.contains(token) {
                score += 18;
                relevance_hit = true;
                reasons.push(format!("id matches `{token}`"));
            }
            if title.contains(token) {
                score += 24;
                relevance_hit = true;
                reasons.push(format!("title matches `{token}`"));
            }
            if description.contains(token) {
                score += 14;
                relevance_hit = true;
                reasons.push(format!("description matches `{token}`"));
            }
            if body_l.contains(token) {
                score += 6;
                relevance_hit = true;
                reasons.push(format!("body mentions `{token}`"));
            }
        }
    }

    if !cwd.is_empty() && (path.contains(&cwd) || body_l.contains(&cwd)) {
        score += 16;
        relevance_hit = true;
        reasons.push("matches current project path".to_string());
    }

    // Baseline relevance — TIEBREAKERS among already-matched notes only. Kept
    // small (and degree capped low) so query relevance dominates the ranking.
    match node.node_type.as_str() {
        "user" | "identity" | "preference" => score += 4,
        "project" | "plan" | "workflow" | "decision" => score += 3,
        _ => {}
    }
    score += (node.links.len() as i32).min(4);
    if node.mtime > 0 {
        score += 1;
    }

    // With a real query, baseline alone can't surface a memory — it must have
    // hit the query or the cwd. (Empty query → browse mode, baseline ranks.)
    if !q.is_empty() && !relevance_hit {
        return None;
    }
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
        vault: node.vault.clone(),
        mtime: node.mtime,
        score,
        reasons,
        preview: compact_preview(body),
    })
}

#[cfg(test)]
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

fn search_memory_vaults(
    vaults: &[VaultDir],
    query: String,
    cwd: Option<String>,
    limit: Option<u32>,
) -> Vec<MemoryHit> {
    let q_empty = query.trim().is_empty();
    let mut hits: Vec<MemoryHit> = vaults
        .iter()
        .flat_map(|v| {
            memory_nodes_from_vault(&v.path, &v.label)
                .into_iter()
                .filter_map(|(node, body)| score_memory(&node, &body, &query, cwd.as_deref()))
        })
        .collect();
    if q_empty {
        hits.sort_by(|a, b| {
            b.mtime
                .cmp(&a.mtime)
                .then_with(|| b.score.cmp(&a.score))
                .then_with(|| a.title.cmp(&b.title))
        });
    } else {
        hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| b.mtime.cmp(&a.mtime))
                .then_with(|| a.title.cmp(&b.title))
        });
    }
    hits.truncate(limit.unwrap_or(8).clamp(1, 200) as usize);
    hits
}

fn normalize_link_key(s: &str) -> String {
    s.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

fn searchable_text(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
}

fn cluster_for_type(node_type: &str) -> String {
    match node_type.trim().to_lowercase().as_str() {
        "user" | "identity" | "preference" => "user".to_string(),
        "project" | "plan" | "workflow" | "decision" => "project".to_string(),
        "feedback" | "lesson" => "feedback".to_string(),
        "reference" | "doc" | "docs" => "reference".to_string(),
        other if !other.is_empty() => other.to_string(),
        _ => "reference".to_string(),
    }
}

fn build_memory_graph(items: Vec<(MemoryNode, String)>, vaults: Vec<VaultDir>) -> Value {
    let mut nodes: Vec<MemoryNode> = items.iter().map(|(node, _)| node.clone()).collect();
    let bodies: HashMap<String, String> = items
        .into_iter()
        .map(|(node, body)| (node.id, body))
        .collect();

    let mut aliases: HashMap<String, String> = HashMap::new();
    for node in &nodes {
        aliases.insert(node.id.clone(), node.id.clone());
        aliases.insert(normalize_link_key(&node.id), node.id.clone());
        aliases.insert(normalize_link_key(&node.title), node.id.clone());
    }

    let mut resolved_links: HashMap<String, Vec<String>> = HashMap::new();
    let mut backlinks: HashMap<String, Vec<String>> = HashMap::new();
    let mut edge_pairs: HashSet<(String, String)> = HashSet::new();

    for node in &nodes {
        let mut links = Vec::new();
        for raw_target in &node.links {
            let target = aliases
                .get(raw_target)
                .or_else(|| aliases.get(&normalize_link_key(raw_target)));
            let Some(target_id) = target else {
                continue;
            };
            if target_id == &node.id || links.iter().any(|id| id == target_id) {
                continue;
            }
            links.push(target_id.clone());
            backlinks
                .entry(target_id.clone())
                .or_default()
                .push(node.id.clone());
            edge_pairs.insert((node.id.clone(), target_id.clone()));
        }
        resolved_links.insert(node.id.clone(), links);
    }

    let node_lookup: HashMap<String, MemoryNode> = nodes
        .iter()
        .map(|node| (node.id.clone(), node.clone()))
        .collect();

    for node in &mut nodes {
        let links = resolved_links.remove(&node.id).unwrap_or_default();
        let mut incoming = backlinks.remove(&node.id).unwrap_or_default();
        incoming.sort();
        incoming.dedup();

        let body = searchable_text(bodies.get(&node.id).map(String::as_str).unwrap_or_default());
        let linked: HashSet<&str> = links.iter().map(String::as_str).collect();
        let mut suggested = Vec::new();
        for candidate in node_lookup.values() {
            if candidate.id == node.id || linked.contains(candidate.id.as_str()) {
                continue;
            }
            let id_phrase = normalize_link_key(&candidate.id).replace('_', " ");
            let title_phrase = searchable_text(&candidate.title);
            let id_match = id_phrase.len() >= 4 && body.contains(&id_phrase);
            let title_match = title_phrase.trim().len() >= 4 && body.contains(title_phrase.trim());
            if id_match || title_match {
                suggested.push(candidate.id.clone());
            }
            if suggested.len() >= 8 {
                break;
            }
        }
        suggested.sort();
        suggested.dedup();

        node.links = links;
        node.backlinks = incoming;
        node.degree = node.links.len() + node.backlinks.len();
        node.orphan = node.degree == 0;
        node.suggested_links = suggested;
        node.cluster = cluster_for_type(&node.node_type);
    }

    nodes.sort_by(|a, b| {
        a.cluster
            .cmp(&b.cluster)
            .then_with(|| b.degree.cmp(&a.degree))
            .then_with(|| a.title.cmp(&b.title))
    });

    let mut edges: Vec<Value> = edge_pairs
        .into_iter()
        .map(|(source, target)| {
            json!({
                "source": source,
                "target": target,
                "kind": "wikilink",
                "weight": 1,
            })
        })
        .collect();
    edges.sort_by(|a, b| {
        let a_key = format!(
            "{}:{}",
            a.get("source").and_then(|v| v.as_str()).unwrap_or_default(),
            a.get("target").and_then(|v| v.as_str()).unwrap_or_default()
        );
        let b_key = format!(
            "{}:{}",
            b.get("source").and_then(|v| v.as_str()).unwrap_or_default(),
            b.get("target").and_then(|v| v.as_str()).unwrap_or_default()
        );
        a_key.cmp(&b_key)
    });

    let count = nodes.len();
    json!({
        "nodes": nodes,
        "edges": edges,
        "vault_path": vaults.first().map(|v| v.path.to_string_lossy().to_string()).unwrap_or_default(),
        "vaults": vaults.iter().map(|v| json!({
            "path": v.path.to_string_lossy(),
            "label": v.label.clone(),
            "primary": v.primary,
        })).collect::<Vec<_>>(),
        "count": count,
    })
}

/// Builds the full memory graph: nodes (one per `*.md`) and edges (one per
/// resolvable `[[link]]`). Returns `{ nodes, edges, vault_path, count }`.
/// Always succeeds — an unreadable/empty vault yields an empty graph.
#[tauri::command]
pub fn memory_graph() -> Value {
    let vaults = vault_dirs();
    let items: Vec<(MemoryNode, String)> = vaults
        .iter()
        .flat_map(|v| memory_nodes_from_vault(&v.path, &v.label).into_iter())
        .collect();
    build_memory_graph(items, vaults)
}

#[tauri::command]
pub fn memory_search(query: String, cwd: Option<String>, limit: Option<u32>) -> Vec<MemoryHit> {
    search_memory_vaults(&vault_dirs(), query, cwd, limit)
}

/// Returns the raw contents of a memory file. Guarded: `path` must resolve to a
/// location inside a known memory vault, otherwise the read is rejected.
#[tauri::command]
pub fn memory_file(path: String) -> Result<String, String> {
    let canon_target = canonical_known_memory_file(&path)?;
    if canon_target.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("not a markdown file".into());
    }
    std::fs::read_to_string(&canon_target).map_err(|e| e.to_string())
}

fn canonical_known_memory_file(path: &str) -> Result<std::path::PathBuf, String> {
    let target = std::path::PathBuf::from(path);
    let canon_target = std::fs::canonicalize(&target).map_err(|e| e.to_string())?;
    let vaults = vault_dirs();
    let allowed = vaults.iter().any(|v| {
        let canon_dir = std::fs::canonicalize(&v.path).unwrap_or_else(|_| v.path.clone());
        canon_target.starts_with(canon_dir)
    });
    if !allowed {
        return Err("path is outside the memory vaults".into());
    }
    Ok(canon_target)
}

/// Writes raw markdown back to an existing memory file. Guarded to known vaults.
#[tauri::command]
pub fn memory_save_raw(path: String, body: String) -> Result<(), String> {
    let target = canonical_known_memory_file(&path)?;
    if target.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("not a markdown file".into());
    }
    atomic_write(&target, body.as_bytes()).map_err(|e| e.to_string())
}

/// Deletes a memory file by path. Guarded to known vaults.
#[tauri::command]
pub fn memory_delete_path(path: String) -> Result<(), String> {
    let target = canonical_known_memory_file(&path)?;
    if target.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("not a markdown file".into());
    }
    let name = target
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let dir = target.parent().map(|p| p.to_path_buf());
    std::fs::remove_file(&target).map_err(|e| e.to_string())?;
    if let Some(dir) = dir {
        update_index_remove(&dir, &name);
    }
    Ok(())
}

/// The idle homescreen's FOCUS tile: the freshest curated note in the vault,
/// surfaced as `{ tag, title }`. Prefers the newest `project_*.md` (the user's
/// current focus); if there are none, falls back to the newest note overall.
/// Always returns a valid object — an empty/absent vault yields nulls.
#[tauri::command]
pub fn memory_focus() -> Value {
    let mut newest_project: Option<(i64, std::path::PathBuf)> = None;
    let mut newest_any: Option<(i64, std::path::PathBuf)> = None;

    for v in vault_dirs() {
        for (node, _) in memory_nodes_from_vault(&v.path, &v.label) {
            let path = std::path::PathBuf::from(&node.path);
            if node.id.eq_ignore_ascii_case("MEMORY") {
                continue;
            }
            if node.id.starts_with("project_")
                && newest_project
                    .as_ref()
                    .map_or(true, |(t, _)| node.mtime > *t)
            {
                newest_project = Some((node.mtime, path.clone()));
            }
            if newest_any.as_ref().map_or(true, |(t, _)| node.mtime > *t) {
                newest_any = Some((node.mtime, path));
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
    atomic_write(&path, out.as_bytes()).map_err(|e| e.to_string())?;

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

/// Atomically writes `data` to `path` via a unique tmp file + rename. firaz runs
/// several oracle sessions against the SAME `~/.aios/state` vault concurrently, so
/// a plain `fs::write` can interleave (partial write seen by a reader) or two
/// writers can clobber. tmp+rename makes the swap atomic on POSIX (rename is a
/// single inode flip), and the pid+nanos suffix keeps two concurrent writers from
/// fighting over one tmp path. The final `rename` is still last-writer-wins at the
/// content level — but the file is NEVER left half-written / truncated.
fn atomic_write(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    let nonce = format!(
        "{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let tmp = path.with_extension(format!("tmp.{nonce}"));
    std::fs::write(&tmp, data)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Don't leak the tmp file if the rename failed.
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
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
    let _ = atomic_write(&index, (lines.join("\n") + "\n").as_bytes());
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
    let _ = atomic_write(&index, (kept.join("\n") + "\n").as_bytes());
}

#[cfg(test)]
mod tests {
    use super::{build_memory_graph, memory_nodes_from_dir, search_memory_dir};

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

repo: /Users/example/Projects/aios/shell
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
            Some("/Users/example/Projects/aios/shell".to_string()),
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

    #[test]
    fn memory_graph_resolves_backlinks_clusters_and_suggested_links() {
        let root = std::env::temp_dir().join(format!("aios-memory-graph-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("project_aios_shell.md"),
            r#"---
name: aios shell
description: superapp cockpit
metadata:
  type: project
---

links to [[feedback-no-context-bloat-ai]] and should suggest the browser pane note.
"#,
        )
        .unwrap();
        std::fs::write(
            root.join("feedback_no_context_bloat_ai.md"),
            r#"---
name: no context bloat
description: keep model context lean
metadata:
  type: feedback
---

use lean context.
"#,
        )
        .unwrap();
        std::fs::write(
            root.join("reference_browser_pane.md"),
            r#"---
name: browser pane
description: native browser work surface
metadata:
  type: reference
---

browser pane can feed context into memory.
"#,
        )
        .unwrap();

        let graph = build_memory_graph(memory_nodes_from_dir(&root), Vec::new());
        let project = graph
            .get("nodes")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .find(|node| node.get("id").and_then(|v| v.as_str()) == Some("project_aios_shell"))
            .unwrap();
        let feedback = graph
            .get("nodes")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .find(|node| {
                node.get("id").and_then(|v| v.as_str()) == Some("feedback_no_context_bloat_ai")
            })
            .unwrap();

        assert_eq!(
            project.get("cluster").and_then(|v| v.as_str()),
            Some("project")
        );
        assert_eq!(project.get("orphan").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(
            feedback
                .get("backlinks")
                .and_then(|v| v.as_array())
                .unwrap()[0],
            "project_aios_shell"
        );
        assert!(project
            .get("suggested_links")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("reference_browser_pane")));
        assert!(graph
            .get("edges")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .any(|edge| edge.get("target").and_then(|v| v.as_str())
                == Some("feedback_no_context_bloat_ai")));

        let _ = std::fs::remove_dir_all(root);
    }
}
