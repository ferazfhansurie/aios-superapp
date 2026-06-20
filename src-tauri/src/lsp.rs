//! LSP process supervisor + dumb framed pipe (TRACK B).
//!
//! Rust's ONLY jobs here: spawn a language server per (workspaceRoot, language)
//! on stdio, do `Content-Length` framing on its stdout, and shovel the raw JSON
//! message strings to the frontend over a per-server Tauri `Channel<String>` —
//! the exact pattern `chat.rs` / `pty.rs` use. ALL protocol intelligence
//! (initialize handshake, request correlation, capability negotiation) lives in
//! TypeScript (`src/lib/lsp/`), so the wire schema can evolve without touching
//! this file.
//!
//! BINARY DISCOVERY IS GUI-PATH-SAFE. A GUI-launched Tauri app has no node on
//! PATH (known bug class in this repo — see `monitor::node_bin`), so we NEVER
//! spawn a node-shebang script directly. typescript-language-server resolution:
//!   ① `<root>/node_modules/typescript-language-server/lib/cli.mjs` (project
//!      install; also reached by canonicalizing the `.bin` symlink) → spawned
//!      as `"<abs node>" "<abs cli.mjs>" --stdio`.
//!   ② global install next to the resolved node (`dirname(node)/typescript-
//!      language-server`, canonicalized to its real cli.mjs).
//!   ③ not found → `lsp_start` errors with a human-readable reason; the
//!      frontend degrades gracefully (monaco's built-in TS worker stays on).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::ipc::Channel;

/// One live language-server process.
struct LspChild {
    child: Mutex<Child>,
    /// Server stdin; framed writes go through `lsp_send`. Taken (None) once the
    /// shutdown sequence has run so late sends fail cleanly instead of EPIPE.
    stdin: Mutex<Option<ChildStdin>>,
    root: String,
    lang: String,
    /// Resolved program + args, kept for `lsp_status` so the frontend can show
    /// WHERE the server actually came from (project-local vs global).
    command: String,
}

/// Registry of live servers keyed by an incrementing id. Module-level `static`
/// (mirrors `chat.rs::SESSIONS`) so no Tauri `State` wiring is needed in lib.rs.
static SERVERS: Mutex<Option<HashMap<u32, Arc<LspChild>>>> = Mutex::new(None);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn with_servers<T>(f: impl FnOnce(&mut HashMap<u32, Arc<LspChild>>) -> T) -> T {
    let mut guard = SERVERS.lock();
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

// ════════════════════════════════════════════════════════════════════════
// Binary resolution (GUI-path-safe — never via shebang/PATH)
// ════════════════════════════════════════════════════════════════════════

struct ResolvedServer {
    program: String,
    args: Vec<String>,
}

impl ResolvedServer {
    fn describe(&self) -> String {
        let mut s = self.program.clone();
        for a in &self.args {
            s.push(' ');
            s.push_str(a);
        }
        s
    }
}

/// True for files node can execute directly (`node <file> --stdio`).
fn is_js_entry(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()),
        Some("mjs") | Some("cjs") | Some("js")
    )
}

fn resolve_typescript_server(root: &Path) -> Result<ResolvedServer, String> {
    let node = crate::monitor::node_bin().ok_or_else(|| {
        "node not found (checked homebrew, /usr/local, /usr/bin, nvm) — cannot run typescript-language-server".to_string()
    })?;

    // ① project-local install. The package's bin entry is `lib/cli.mjs` (stable
    // across typescript-language-server v3/v4/v5); checking the package dir
    // directly works for npm/yarn (symlinked package dirs resolve through
    // `is_file`) AND pnpm (whose `.bin` entries are sh shims that need PATH
    // node — exactly what a GUI app lacks, so we bypass them).
    let pkg_cli = root.join("node_modules/typescript-language-server/lib/cli.mjs");
    if pkg_cli.is_file() {
        return Ok(ResolvedServer {
            program: node,
            args: vec![pkg_cli.to_string_lossy().into_owned(), "--stdio".into()],
        });
    }
    // ①b unusual layouts: canonicalize the `.bin` symlink to its real JS entry.
    let bin = root.join("node_modules/.bin/typescript-language-server");
    if bin.exists() {
        if let Ok(real) = std::fs::canonicalize(&bin) {
            if is_js_entry(&real) {
                return Ok(ResolvedServer {
                    program: node,
                    args: vec![real.to_string_lossy().into_owned(), "--stdio".into()],
                });
            }
        }
    }

    // ② global install next to the resolved node (`npm i -g` drops a symlink to
    // `../lib/node_modules/.../cli.mjs` beside the node binary).
    if let Some(dir) = Path::new(&node).parent() {
        let global = dir.join("typescript-language-server");
        if global.exists() {
            if let Ok(real) = std::fs::canonicalize(&global) {
                if is_js_entry(&real) {
                    return Ok(ResolvedServer {
                        program: node,
                        args: vec![real.to_string_lossy().into_owned(), "--stdio".into()],
                    });
                }
            }
        }
    }

    // ③ not found — report, don't crash. Frontend keeps monaco's TS worker.
    Err(format!(
        "typescript-language-server not found (looked in {}/node_modules and next to {})",
        root.display(),
        node
    ))
}

/// rust-analyzer: a native binary, so plain fixed-location probing suffices.
/// Wired now (the pipe + transport are language-agnostic) even though the
/// TS-side manager only drives typescript in B1/B2 — B4 just flips it on.
fn resolve_rust_analyzer() -> Result<ResolvedServer, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.cargo/bin/rust-analyzer"),
        "/opt/homebrew/bin/rust-analyzer".to_string(),
        "/usr/local/bin/rust-analyzer".to_string(),
    ];
    for c in candidates {
        if Path::new(&c).is_file() {
            return Ok(ResolvedServer {
                program: c,
                args: vec![],
            });
        }
    }
    Err("rust-analyzer not found (checked ~/.cargo/bin, homebrew, /usr/local)".to_string())
}

fn resolve_server(root: &Path, lang: &str) -> Result<ResolvedServer, String> {
    match lang {
        "typescript" => resolve_typescript_server(root),
        "rust" => resolve_rust_analyzer(),
        other => Err(format!("no language server registered for '{other}'")),
    }
}

// ════════════════════════════════════════════════════════════════════════
// Commands
// ════════════════════════════════════════════════════════════════════════

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LspStartInfo {
    pub id: u32,
    /// The resolved spawn line — surfaced in the status pill tooltip so "where
    /// did this server come from" is answerable without a terminal.
    pub command: String,
}

/// Spawns a language server for (root, lang) and wires its stdout to `on_event`
/// as raw JSON message strings (one channel message per LSP message). Framing
/// errors / process exit emit a `$/aios/serverExit` pseudo-notification so the
/// frontend can run crash-restart logic.
#[tauri::command]
pub fn lsp_start(
    root: String,
    lang: String,
    on_event: Channel<String>,
) -> Result<LspStartInfo, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("workspace root is not a directory: {root}"));
    }
    let resolved = resolve_server(&root_path, &lang)?;
    let command = resolved.describe();

    let mut cmd = Command::new(&resolved.program);
    cmd.args(&resolved.args)
        .current_dir(&root_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Insurance for anything the server itself shells out to: put the resolved
    // node's dir on the child's PATH (GUI PATH is minimal — /usr/bin:/bin).
    if let Some(dir) = Path::new(&resolved.program).parent() {
        let base = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
        cmd.env("PATH", format!("{}:{base}", dir.to_string_lossy()));
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {command}: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin on lsp child")?;
    let stdout = child.stdout.take().ok_or("no stdout on lsp child")?;
    let stderr = child.stderr.take();

    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let entry = Arc::new(LspChild {
        child: Mutex::new(child),
        stdin: Mutex::new(Some(stdin)),
        root: root.clone(),
        lang: lang.clone(),
        command: command.clone(),
    });
    with_servers(|m| m.insert(id, Arc::clone(&entry)));

    // stderr → log lines (rust-analyzer is chatty here; tsserver logs errors).
    if let Some(stderr) = stderr {
        let tag = format!("[lsp {id} {lang}]");
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("{tag} {line}");
            }
        });
    }

    // stdout reader: Content-Length framing ONLY, then shovel to the channel.
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_frame(&mut reader) {
                Ok(Some(msg)) => {
                    if on_event.send(msg).is_err() {
                        // Frontend dropped the channel (pane teardown / webview
                        // reload). Nobody can drive this server anymore — kill
                        // it rather than leak an orphan process.
                        break;
                    }
                }
                Ok(None) => break, // clean EOF — server exited
                Err(e) => {
                    eprintln!("[lsp {id}] frame error: {e}");
                    break;
                }
            }
        }
        // Tell the frontend (best-effort — channel may already be gone) so the
        // manager can run its crash-restart / degrade logic.
        let _ = on_event.send(format!(
            "{{\"jsonrpc\":\"2.0\",\"method\":\"$/aios/serverExit\",\"params\":{{\"serverId\":{id}}}}}"
        ));
        // Reap + deregister.
        if let Some(entry) = with_servers(|m| m.remove(&id)) {
            let mut child = entry.child.lock();
            let _ = child.kill();
            let _ = child.wait();
        }
    });

    Ok(LspStartInfo { id, command })
}

/// Reads one `Content-Length`-framed message. `Ok(None)` = clean EOF.
fn read_frame(reader: &mut impl BufRead) -> Result<Option<String>, String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None); // EOF
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break; // blank line = end of headers
        }
        // Header names are case-insensitive per the base protocol spec.
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().ok();
            }
        }
    }
    let len = content_length.ok_or("missing Content-Length header")?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

/// Writes one framed message to the server's stdin. `payload` is a complete
/// JSON-RPC message string built by the frontend.
#[tauri::command]
pub fn lsp_send(server_id: u32, payload: String) -> Result<(), String> {
    let entry = with_servers(|m| m.get(&server_id).cloned()).ok_or("no such lsp server")?;
    let mut stdin = entry.stdin.lock();
    let w = stdin.as_mut().ok_or("lsp server is shutting down")?;
    // Content-Length counts BYTES, not chars — multibyte payloads must use len()
    // of the encoded bytes or the server reads a truncated JSON document.
    write!(w, "Content-Length: {}\r\n\r\n", payload.len()).map_err(|e| e.to_string())?;
    w.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// Stops a server: polite shutdown→exit on stdin, then SIGKILL escalation if it
/// hasn't exited within ~1.5s. Deregisters immediately so a racing `lsp_send`
/// can't write into a dying pipe.
#[tauri::command]
pub fn lsp_stop(server_id: u32) -> Result<(), String> {
    let entry = with_servers(|m| m.remove(&server_id)).ok_or("no such lsp server")?;
    shutdown_entry(&entry, true);
    Ok(())
}

/// shutdown→exit→kill. `wait` = poll up to ~1.5s before the hard kill (used by
/// `lsp_stop`); app-exit uses `wait=false` for an immediate kill after the
/// polite notifications (quit must not block).
fn shutdown_entry(entry: &Arc<LspChild>, wait: bool) {
    // Polite phase: a shutdown request (id chosen high to never collide with
    // the frontend's monotonically-increasing ids) followed by exit.
    if let Some(mut stdin) = entry.stdin.lock().take() {
        let shutdown = r#"{"jsonrpc":"2.0","id":2147483647,"method":"shutdown","params":null}"#;
        let exit = r#"{"jsonrpc":"2.0","method":"exit"}"#;
        for msg in [shutdown, exit] {
            let _ = write!(stdin, "Content-Length: {}\r\n\r\n{msg}", msg.len());
        }
        let _ = stdin.flush();
        // dropping stdin closes the pipe — a second EOF signal for the server
    }
    if wait {
        let entry = Arc::clone(entry);
        thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
            loop {
                {
                    let mut child = entry.child.lock();
                    match child.try_wait() {
                        Ok(Some(_)) => return, // exited politely
                        Ok(None) => {}
                        Err(_) => return,
                    }
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                }
                thread::sleep(std::time::Duration::from_millis(100));
            }
        });
    } else {
        let mut child = entry.child.lock();
        if !matches!(child.try_wait(), Ok(Some(_))) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub id: u32,
    pub root: String,
    pub lang: String,
    pub command: String,
    pub alive: bool,
}

#[tauri::command]
pub fn lsp_status() -> Vec<LspServerStatus> {
    with_servers(|m| {
        m.iter()
            .map(|(id, e)| LspServerStatus {
                id: *id,
                root: e.root.clone(),
                lang: e.lang.clone(),
                command: e.command.clone(),
                alive: matches!(e.child.lock().try_wait(), Ok(None)),
            })
            .collect()
    })
}

/// Nearest ancestor of `path` containing any of `markers` (e.g. tsconfig.json).
/// Stops at the repo boundary: a directory containing `.git` is the LAST one
/// checked — we never escape into ~/ or / and adopt some unrelated package.json.
#[tauri::command]
pub fn lsp_find_root(path: String, markers: Vec<String>) -> Option<String> {
    find_root_impl(Path::new(&path), &markers).map(|p| p.to_string_lossy().into_owned())
}

fn find_root_impl(path: &Path, markers: &[String]) -> Option<PathBuf> {
    let start = if path.is_dir() { path } else { path.parent()? };
    let mut dir = Some(start);
    while let Some(d) = dir {
        if markers.iter().any(|m| d.join(m).exists()) {
            return Some(d.to_path_buf());
        }
        if d.join(".git").exists() {
            return None; // repo root reached without a marker — don't escape it
        }
        dir = d.parent();
    }
    None
}

/// Kill every live server NOW. Called from lib.rs on app exit so GUI-spawned
/// node processes never outlive the cockpit (they'd be orphans burning CPU).
pub fn kill_all_servers() {
    let entries: Vec<Arc<LspChild>> = with_servers(|m| m.drain().map(|(_, e)| e).collect());
    for entry in entries {
        shutdown_entry(&entry, false);
    }
}

#[cfg(test)]
mod tests {
    use super::find_root_impl;
    use std::fs;

    fn mk(base: &std::path::Path, rel: &str) {
        let p = base.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "").unwrap();
    }

    #[test]
    fn nearest_marker_wins_and_git_bounds() {
        let tmp = std::env::temp_dir().join(format!("aios-lsp-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        // repo/.git, repo/package.json, repo/pkg/tsconfig.json, repo/pkg/src/a.ts
        mk(&tmp, "repo/.git/HEAD");
        mk(&tmp, "repo/package.json");
        mk(&tmp, "repo/pkg/tsconfig.json");
        mk(&tmp, "repo/pkg/src/a.ts");
        mk(&tmp, "repo/other/deep/b.ts");
        let markers = vec!["tsconfig.json".to_string(), "package.json".to_string()];

        // nearest ancestor with a marker
        let r = find_root_impl(&tmp.join("repo/pkg/src/a.ts"), &markers);
        assert_eq!(r, Some(tmp.join("repo/pkg")));
        // falls through to the repo root's package.json
        let r = find_root_impl(&tmp.join("repo/other/deep/b.ts"), &markers);
        assert_eq!(r, Some(tmp.join("repo")));
        // a dir with .git but NO marker bounds the walk
        mk(&tmp, "bare/.git/HEAD");
        mk(&tmp, "bare/src/c.ts");
        mk(&tmp, "package.json"); // would match if we escaped the boundary
        let r = find_root_impl(&tmp.join("bare/src/c.ts"), &markers);
        assert_eq!(r, None);
        let _ = fs::remove_dir_all(&tmp);
    }
}
