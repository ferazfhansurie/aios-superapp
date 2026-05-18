# aios-shell — software around our existing terminal

Locked 2026-05-19 00:38 MYT. Per Firaz clarification: we are **not**
forking the alacritty codebase at `~/Repo/firaz/terminal`. We're building
a wrapper app that *hosts* that terminal as a child process and adds the
Antigravity-style sidebar chrome around it.

The existing `~/Repo/firaz/terminal` keeps shipping on `prod` untouched.

## Concept

```
┌──────────────────────────────────────────────────────┐
│ aios-shell window                                    │
│ ┌──────────────┬─────────────────────────────────┐  │
│ │              │                                 │  │
│ │  HUD         │     ← our terminal binary       │  │
│ │  sidebar     │       (alacritty subprocess,    │  │
│ │              │        embedded view)           │  │
│ │  - quota     │                                 │  │
│ │  - heatmap   │                                 │  │
│ │  - stats     │                                 │  │
│ │  - streaks   │                                 │  │
│ │  - mascot    │                                 │  │
│ │              │                                 │  │
│ └──────────────┴─────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Reference (Firaz screenshot 2026-05-19 00:33)

Google Antigravity IDE — left sidebar "Claude Manager":
- Profile card, quota meters (5h / 7d), GitHub-style heatmap,
  stat cards (tokens / sessions / messages / cache hit %), streak counters.
- Pixel mascot on welcome screen.
- Orange-on-dark theme (matches adletic brand).

## Stack options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Tauri 2** (rust + next.js) | tiny binary, web frontend for chrome, native window, can host alacritty as child or use xterm.js inside webview | small ecosystem, rust window management | **default** |
| Electron | huge ecosystem, fast iteration | 200MB+ binary, slower, less native feel | no |
| Native macOS (Swift + AppKit) | feels truly native, can embed alacritty's NSView | macOS-only, swift devtime | maybe later |
| Pure web (Next.js + xterm.js) | reuse aios-terminal-site, no native deps | not a "real" terminal, no GPU rendering, no alacritty | no |

**Pick: Tauri 2.** Sidebar lives in Next.js (we already have shadcn ready
in aios-crm to lift). The terminal pane is either:
  (a) alacritty spawned as a subprocess into the same window (harder), OR
  (b) xterm.js inside the Tauri webview (easier, looks ~identical).

V1 ships with (b). V2 ports to (a) for the real alacritty feel.

## Data sources for the sidebar (we already have these)

Claude Code writes JSONL into `~/.claude/projects/*/jsonl`. Each line is
a session event with token usage, model, cache stats, timestamps.

The `aios-firaz` wakeup-digest already reads this — lift its logic into
`lib/claude-telemetry.ts` here:
- Tokens per session, per day, per project
- Cache hit % per session
- Active days → streak math
- Sessions / messages counts
- Per-model breakdown

Anthropic's API has org-level usage too but we don't need it for v1 —
local JSONL is the truth.

## Layout sketch

- Header bar (32px): aios mascot + workspace name + new-session button
- Left sidebar (260px):
  - Profile card (avatar, name, "Adletic · Owner")
  - Quota: "5h window 14% · 12h left" + bar
  - Quota: "7d window 38% · resets Wed" + bar
  - Stat grid (2x2): tokens · sessions · messages · cache%
  - Heatmap: 7×52 grid, last 12 months activity, orange intensity
  - Streaks list: favorite model, active days (7d / 30d / all), current streak, longest streak
- Main pane: terminal (xterm.js v1)
- Footer (24px): branch · cwd · model · token count tail

## Build steps (for the fresh-session resume)

1. `pnpm create tauri-app@latest aios-shell` → next.js + ts template
2. Copy shadcn config + components from `aios-crm/components/ui`
3. Build `lib/claude-telemetry.ts` — read `~/.claude/projects/*/jsonl`
4. Build sidebar components from the layout sketch above
5. Add xterm.js terminal pane (v1) — spawn a PTY via Tauri's shell API
6. Wire window chrome (frameless, custom traffic lights on macOS)
7. Ship as `aios-shell.app` — DMG or homebrew tap

## Not doing tonight

It's 00:38. Setting up tauri + getting a sidebar painting takes ~2h
properly. Resuming fresh tomorrow.
