# AIOS superapp — launch assets (Product Hunt + Hacker News)

Repo: https://github.com/ferazfhansurie/aios-superapp
Date prepped: 2026-05-31

---

## HACKER NEWS — "Show HN"

> HN culture: no marketing speak, no hype adjectives, NO microsoft-bashing (it
> gets flagged). Be technical, honest about what's rough, and be around to reply
> for the first few hours. Post weekday morning US-Eastern.

### Title (pick one, ≤80 chars)
- `Show HN: AIOS – a native superapp for driving AI coding agents (Tauri/Rust)`
- `Show HN: One window for your terminals, AI agents, browser, and memory graph`
- `Show HN: AIOS – run Claude Code and Codex side by side on your own sub`

### First comment (post immediately after submitting)

Hi HN, I'm Firaz. I live in AI coding agents all day and got tired of bouncing
between a terminal (Claude Code), a separate editor, a browser, and a pile of
one-off scripts. So I built one native window where every pane is a tool.

Stack: Tauri v2 / Rust backend, React + xterm.js frontend. ~47 Rust commands;
PTYs and the chat stream push to the frontend over per-session Tauri Channels so
terminals and chat render token-by-token.

What's in it:

- real PTY terminals (xterm.js + WebGL), persistent via tmux
- a chat pane that shells out to your LOCAL CLI — `claude` (stream-json), `codex`,
  or a free `opencode` fallback — so it runs on your own subscription, no API
  keys baked in
- an embedded native WebKit browser (real sessions/logins persist, per-profile
  cookie jars)
- a file explorer + Monaco editor
- a 3D force-directed graph of a markdown "memory" vault (every `[[wikilink]]`
  is an edge)
- a Postgres/MySQL query pane, an automations board, and a few messaging
  integrations

Design goal was "calm, chat-first," and it degrades gracefully: no tmux, no
`claude` CLI, no vault → those panes just go empty instead of erroring.

Honest status: it's my daily driver, but it's early and has rough edges —
especially the conversational layer. macOS is the primary target (Tauri is
cross-platform but the agent bits assume a Unix host; a Windows ConPTY port is on
the roadmap). MIT licensed.

Repo: https://github.com/ferazfhansurie/aios-superapp

Would love feedback — especially on the multi-engine chat approach and which
pane you'd want next.

---

## PRODUCT HUNT

> PH culture: founder story works great (the vscode→cursor→agents journey is
> perfect here). Launch 12:01am PT. Have gallery images ready (cover +
> screenshots in docs/). Reply to every comment in the first hours.

### Name
AIOS

### Tagline (≤60 chars — pick one)
- `One native window to drive your AI coding agents`
- `Your terminals, AI agents, and tools in one window`
- `The open-source superapp for AI coding agents`

### Topics
Developer Tools · Artificial Intelligence · Open Source · Productivity

### Description (~260 chars)
AIOS is an open-source native superapp for people who live in AI coding agents.
One window: real terminals, a chat that runs on your own Claude/Codex sub (no API
keys), an embedded browser, files, a 3D memory graph, a SQL pane, and
automations. macOS · Tauri · MIT.

### Maker's first comment

hey hunters 👋

i build with AI coding agents all day. claude code is incredible but i hated
being trapped in a terminal. codex is beautiful but i wanted to use claude. and i
was sick of juggling an editor + a browser + five scripts on the side.

so i built the app i actually wanted: one native window where every pane is a
tool, all running on the subscriptions i already pay for — no api keys, no
per-token markup.

what's inside:
• terminals + claude/codex agents running side by side
• multi-engine chat (claude, codex, or a free fallback)
• embedded browser, file explorer, Monaco editor
• a 3D graph of your whole memory vault
• Postgres/MySQL workbench + automations
• open source (MIT)

it's my daily driver. it's also early and a little buggy — i ship fixes most
days. would genuinely love your feedback on what to build next.

github: https://github.com/ferazfhansurie/aios-superapp

### Gallery assets (already built)
- docs/cover/cover.png  ← hero
- docs/screenshots/deck.png · grid.png · light.png · browser.png

---

## Cross-post sequencing (suggested)
1. HN "Show HN" first (weekday ~8–10am ET) — the technical crowd; engage in
   comments.
2. Product Hunt same day or next (12:01am PT) — story-led, rally support.
3. Threads post (already drafted, microsoft-hook version) — point to whichever
   has traction; "we're #1 on Show HN" / "live on Product Hunt" makes a good
   second-day thread.
