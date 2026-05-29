//! Plugins / skills catalog for the cockpit — "make AIOS work your way".
//! Reads the canonical AIOS skill index (the Level-0 catalog markdown) + the
//! connected MCP servers from `~/.claude.json`, so the cockpit can show what
//! AIOS can actually do.

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
pub struct Skill {
    name: String,
    description: String,
    group: String,
}

#[derive(Serialize)]
pub struct Plugins {
    skills: Vec<Skill>,
    mcps: Vec<String>,
}

/// Resolves the AIOS skill index in a portable, env-overridable way (first that
/// exists wins):
///   1. `$AIOS_SKILL_INDEX` — explicit override, used verbatim if the file exists.
///   2. `$HOME/.claude/skills/_INDEX.md` — the conventional top-level catalog.
///   3. `$HOME/.claude/projects/*/skills/_INDEX.md` — first per-project catalog
///      for whatever user (sorted for determinism).
/// Returns `None` when nothing is found, so the cockpit shows an empty (but
/// valid) plugin list on machines without an AIOS skill index.
fn index_path() -> Option<std::path::PathBuf> {
    // 1. Explicit override.
    if let Some(v) = std::env::var_os("AIOS_SKILL_INDEX") {
        let p = std::path::PathBuf::from(v);
        if p.is_file() {
            return Some(p);
        }
    }

    let home = std::path::PathBuf::from(std::env::var_os("HOME")?);

    // 2. Conventional top-level catalog under `$HOME/.claude`.
    let top = home.join(".claude").join("skills").join("_INDEX.md");
    if top.is_file() {
        return Some(top);
    }

    // 3. First per-project catalog (sorted so the choice is stable).
    let projects = home.join(".claude").join("projects");
    if let Ok(rd) = std::fs::read_dir(&projects) {
        let mut candidates: Vec<std::path::PathBuf> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.path().join("skills").join("_INDEX.md"))
            .filter(|p| p.is_file())
            .collect();
        candidates.sort();
        if let Some(first) = candidates.into_iter().next() {
            return Some(first);
        }
    }

    None
}

/// Parses `- **name** — description` lines, grouping by the preceding `## header`.
fn parse_skills(md: &str) -> Vec<Skill> {
    let mut skills = Vec::new();
    let mut group = String::from("skills");
    for line in md.lines() {
        let t = line.trim();
        if let Some(h) = t.strip_prefix("## ") {
            group = h.trim().to_string();
        } else if let Some(rest) = t.strip_prefix("- **") {
            if let Some((name, tail)) = rest.split_once("**") {
                let description = tail
                    .trim_start_matches([' ', '—', '-', ':'])
                    .trim()
                    .to_string();
                skills.push(Skill {
                    name: name.trim().to_string(),
                    description,
                    group: group.clone(),
                });
            }
        }
    }
    skills
}

/// Reads connected MCP server names from `~/.claude.json`.
fn read_mcps() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let path = std::path::PathBuf::from(home).join(".claude.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    v.get("mcpServers")
        .and_then(|m| m.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn list_plugins() -> Plugins {
    let skills = index_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|md| parse_skills(&md))
        .unwrap_or_default();
    Plugins {
        skills,
        mcps: read_mcps(),
    }
}
