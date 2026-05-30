# AIOS Shell — Windows Port Notes

> For a Windows machine / Windows-side Claude pulling this repo: what's cross-platform,
> what's Unix-only, and what to port. The frontend is fully cross-platform; the gaps are
> all in the Rust PTY/session layer. Last updated 2026-05-30.

## How to pull
`git clone https://github.com/ferazfhansurie/aios-shell.git` (private) → `git pull` for updates.
Build on Windows: `pnpm install && pnpm tauri build` → produces `.msi`/`.exe` (CI already builds `windows-latest`).

## Works cross-platform as-is
- React/xterm.js frontend, command palette, composer, sidebar, usage meter.
- **Chat pane** — needs the `claude` CLI on PATH (Windows install of Claude Code).
- **Editor** — Monaco (cross-platform). **Files** pane. **Browser** pane — uses WebView2 (Chromium) on Windows, fine.
- Image paste/drop (`save_image_temp`), copy/paste, drag-drop.

## Unix-only — needs a Windows path (the real port work)
1. **Terminal persistence** — `src-tauri/src/pty.rs` `pty_spawn_terminal` is `#[cfg(unix)]` (uses **tmux** on the `-L adletic` socket for detach/reattach + survive-app-close). Windows has no tmux, so `TerminalPane.tsx` already falls back to the raw, **non-persistent** `pty_spawn` (ConPTY). To get persistence on Windows: either (a) a long-lived PTY-host daemon the app attaches to, (b) bundle/require WSL + tmux, or (c) a Windows session-multiplexer. Until then Windows terminals work but don't survive app close.
2. **Oracle / tmux panes** — `pty_spawn_oracle` / `pty_spawn_tmux` are tmux-based (Unix). The agent/oracle model + the WhatsApp bridge are Unix infra; the Windows port is the **shell app only**, not the bridge.
3. **claude bypass** — the "claude code" pane launches `claude --dangerously-skip-permissions` (cross-platform flag, fine on Windows).
4. **Misc Unix assumptions** — login-shell spawning in `pty_spawn`, the `/tmp/aios-paste/` temp dir for pasted images (use the OS temp dir on Windows), any `~`/POSIX path handling.

## Suggested port approach for a Windows Claude
- Keep all frontend untouched. Focus on `src-tauri/src/pty.rs`: implement a `#[cfg(windows)]` `pty_spawn_terminal` that gives persistence via a PTY-host process (ConPTY) the app can reattach to, mirroring the tmux semantics (create-or-attach by name, detach-on-close).
- Make `/tmp/aios-paste` path resolution use `std::env::temp_dir()`.
- Verify WebView2 is present (Tauri prompts to install if missing).
- Leave oracle/tmux/bridge features degrading gracefully (they already return empty/errors without tmux).
