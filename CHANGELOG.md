# Changelog

AIOS is actively developed — it's the author's daily driver, updated most days.
Newest entries on top. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## 2026-05-31

### Fixed
- **Codex chat engine in the packaged app.** The GUI-launched app has no nvm
  `node` on `PATH`, and `codex` resolved to `codex.js` (a node-shebang launcher) —
  so it died *only* in the built app while working fine in dev / from the CLI.
  `chat.rs` `codex_bin()` now points at the vendored **native Rust binary**
  instead of the node launcher: no node dependency, and a faster cold start.
  Verified both ways — `cargo check` finished clean (zero new warnings/errors),
  and a PATH-stripped run mimicking the GUI (`PATH=/usr/bin:/bin`, no node, exact
  pane args) produced a clean stream: `thread.started → turn.started →
  agent_message → turn.completed`.

### Shipped (this session)
- Multi-engine chat — `claude` (persistent stream-json) + **Codex** (ChatGPT
  subscription) + **Opencode/OpenRouter** with a zero-setup free fallback model.
- Chat composer — per-pane draft autosave, image attach + paste + drag for
  vision, `/` slash menu, `@` file-mention picker, `⌘↑/↓` history recall, voice
  dictation, autoscroll-pause + jump-to-latest pill.
- Live mode / model / context pills parsed straight from the PTY in the terminal
  compose box.
