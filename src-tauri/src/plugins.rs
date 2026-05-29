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

/// Candidate locations for the AIOS skill index (first that exists wins).
fn index_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let candidates = [
        "Repo/firaz/adletic/aios-firaz/.claude/skills/_INDEX.md",
        ".claude/skills/_INDEX.md",
    ];
    for c in candidates {
        let p = std::path::PathBuf::from(&home).join(c);
        if p.exists() {
            return Some(p);
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
