# Running AIOS (Cockpit) on Windows

This is the Windows port of the AIOS shell. The app is **Tauri v2 (Rust) + React/Vite**.
Firaz develops on macOS (`origin/master`); this branch makes it run natively on
Windows. All Windows changes are cross-platform-guarded (`cfg!(windows)` +
`USERPROFILE` fallbacks), so they don't break the Mac build.

---

## One-time setup

Install these once (per machine):

| Tool | How | Why |
| --- | --- | --- |
| **Rust** (MSVC) | <https://rustup.rs> | Tauri backend |
| **VS Build Tools 2022** + "Desktop development with C++" | <https://aka.ms/vs/17/release/vs_BuildTools.exe> | links the Rust binary |
| **Node 18+** | <https://nodejs.org> | frontend (`npm`) |
| **WebView2** | preinstalled on Win 11 | renders the UI |
| **claude CLI** | `claude.exe` on PATH (you have it at `~\.local\bin`) | chat pane (runs on your subscription) |

> We use **npm** on Windows (not pnpm) — pnpm 11's build-approval gate blocks
> esbuild's install. This is the only deliberate divergence from Firaz's setup.

### Optional (only if you want these panes live)
- **LibreOffice** → office-file previews in the Files pane
- **MotionBoards key** → write it to `%USERPROFILE%\.aios\state\motion.key`
  (one line, `mb_...`). Never commit it. The Studio/Motion pane reads it from there.

---

## Run it

```powershell
.\scripts\run.ps1            # install deps (first run) + launch dev app
.\scripts\run.ps1 -Build     # produce an .msi/.exe installer instead
```

Or manually:

```powershell
npm install
npx tauri dev
```

First Rust build takes a few minutes; after that it's cached and fast.

---

## Syncing Firaz's updates

Firaz pushes to `origin/master` constantly. Two ways to stay current:

### Automatic (recommended) — set it once, forget it
```powershell
.\scripts\aios-watch.ps1 -Install     # background task, checks every 15 min
.\scripts\aios-watch.ps1 -Uninstall   # stop it
```
Or watch live in a terminal: `.\scripts\aios-watch.ps1` (5-min loop, Ctrl+C to stop).
It auto-merges his commits, reinstalls deps, and rebuilds — logging to
`scripts\aios-watch.log`. It never pushes, never clobbers uncommitted work, and
on a real conflict it backs out and waits for you (so the tree is never left
half-merged). It does NOT auto-relaunch the app — run `.\scripts\run.ps1` to pick
up an update.

### Manual — one command, on demand
```powershell
.\scripts\aios-sync.ps1 -Preview   # SEE what he changed (no changes made)
.\scripts\aios-sync.ps1            # merge his changes + npm install + rebuild
.\scripts\aios-sync.ps1 -Push      # commit + push our branch for the team
```

What the sync does:
1. `git fetch` and shows you exactly which commits + files Firaz changed.
2. Merges `origin/master` into our branch.
3. Auto-resolves the one expected conflict (`pnpm-lock.yaml` — we use npm).
4. If Firaz changed the *same lines* we did, it **stops and lists the files** for
   a human to resolve (rare — our changes are isolated to `cfg!(windows)` blocks).
5. Reinstalls deps, type-checks the frontend, and compiles the Rust backend — so
   you know immediately if one of his changes needs a Windows tweak.

Teammates get the Windows-ready version with:

```powershell
git pull origin <this-branch>
.\scripts\run.ps1
```

---

## What works on Windows vs. what's inert

**Working:** terminals (PowerShell), chat (`claude.exe`), files + office preview,
browser, memory graph, database, settings, the homescreen dashboard (your real
usage stats), screenshots, clipboard "send to chat", and the device/battery panel.

**Inert** (Unix-only integrations — they show empty, never crash): the oracle
roster + automations (need `tmux`), bridges status (`launchctl`), and
push-to-talk voice. These need a Unix host and aren't part of the Windows daily
driver.

---

## What was changed for Windows (so reviewers know the surface area)

- `src-tauri/src/lib.rs` — alias `HOME`→`%USERPROFILE%` at startup (lights up all
  data sources: usage, memory, files).
- `src-tauri/src/pty.rs` — terminal launches PowerShell (not `/bin/zsh`).
- `src-tauri/src/chat.rs` — resolve `claude.exe`; no console flash (`CREATE_NO_WINDOW`).
- `src-tauri/src/device.rs` — battery via `GetSystemPowerStatus`; home-drive disk.
- `src-tauri/src/stats.rs` — JSONL-telemetry fallback when ccusage/cache absent.
- `src-tauri/src/memory.rs` — Windows path encoding; `memory_focus` command.
- `src-tauri/src/browser.rs` — Windows UA; screenshot + clipboard via PowerShell.
- `src-tauri/src/files.rs` — `soffice.exe`, temp dir, `file://` URLs, USERPROFILE.
- `src/components/TerminalPane.tsx` — focus the terminal so you can type; WebGL
  context-loss fallback.
- `src/lib/settings.ts` + `IdleDashboard`/`AccountMenu`/`Settings` — your name is
  a setting (defaults to "faeez"), shown in the greeting + account row.
- `src-tauri/tauri.conf.json` — `beforeDev/BuildCommand` use `npm`.
