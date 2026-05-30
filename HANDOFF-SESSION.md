# AIOS shell — session handoff
2026-05-31 · focus: multi-engine chat + making ChatPane the best daily driver

> **Next session: read THIS, then `git -C ~/Repo/firaz/aios/shell log --oneline -16`.**
> Repo `~/Repo/firaz/aios/shell`, branch `master`, head `287f261`, ~40 commits
> ahead of origin, **NOT pushed** (don't push unprompted).

## WORKING RULES (firaz, load-bearing)
- **Build loop (NO `cd` — triggers prompts):** `pnpm --dir ~/Repo/firaz/aios/shell tauri build` → `pkill -9 -f "AIOS.app/Contents/MacOS"; rm -rf /Applications/AIOS.app; cp -R <repo>/src-tauri/target/release/bundle/macos/AIOS.app /Applications/AIOS.app; open /Applications/AIOS.app`. ALWAYS `npx tsc --noEmit` == 0 first.
- The DMG bundle step sometimes fails (leftover mount) — **the `.app` is built before it, so ignore the dmg error**; install the `.app`.
- **Edit freely → only build/install when at a checkpoint or handoff.** Commit per logical win.
- **TerminalComposer.tsx is DONE — do NOT touch it.** firaz: "it's amazing already." It's the reference; port FROM it, never edit it.
- **ChatPane history (↑ recall) — leave as is**, firaz loves it.
- No WhatsApp sends. Keep replies in-pane.
- **Multiple oracle sessions edit this same repo concurrently** (aios-shell-3152 etc.). Re-check `git status` / file state before big edits; converge, don't clobber.

## SHIPPED this session (all build-verified, tsc-green, on master)
Multi-engine chat:
- `06d23d6` **multi-engine chat pane** — `chat.rs` now engine-agnostic. claude = persistent stream-json process (unchanged); codex (ChatGPT sub) + opencode = spawn-per-turn (`codex exec --json`+resume / `opencode run --format json -s`), output normalized into claude's event shape via `adapt_codex_line`/`adapt_opencode_line`. `ChatStartOpts.engine`, `ChatModel.engine`.
- `5e7c0b3` **one free model** — `opencode/nemotron-3-super-free` (NVIDIA, US, not Chinese) as the sole free fallback. Dropped model sprawl.
- `43c202b` **render whole-message text blocks** (codex/opencode emit whole msgs, not deltas — the assistant handler now renders a text block when no streaming bubble exists) + codex `-c mcp_servers={}` for speed.

Composer daily-driver work (ChatPane.tsx):
- `c29b353`,`681b0c4` ↑-recall last msg + running context chip; live mode/model/ctx pills in TerminalComposer (parsed from claude-code's PTY in TerminalPane — see `claudeStatus` parser ~line 297).
- `cbbeda4` scroll-aware autoscroll + jump-to-latest pill; draft persistence per pane (`localStorage[aios-chat-draft:${paneKey}]`).
- `981f9b8` **image paste/attach** (⌘V screenshot, attach button, drag) → temp file → quoted path prepended to message; **wrap-aware composer** (flex-wrap + ml-auto action cluster, reflows like TUI).
- `14b7d57` **voice dictation** (ported from TerminalComposer — mic → waveform → transcript, Esc cancels); flash treatment on the box; **/handoff** in slash menu; model pill nowrap; **context readout moved OUT of composer** to a line above it, model-aware window (**opus 4.8 = 1M**, sonnet/haiku 200K, codex 272K, opencode 256K).
- `cd7cbd3` **sleek composer** — plan/goal pills removed from the bar → `/plan` `/goal` slash commands. Row is now: `+ full access · medium · model · attach · mic · send`.
- `9683f76` **fix:** removed `overflow-hidden` from composer box (flash had added it; it clipped the permission/effort/model dropdown menus — "overlay broken").
- `287f261` **slash menu = compact left-anchored dropdown** (OverlayPanel `compact` prop) instead of full-width overlay; @-mention picker keeps full-width.

## DECISIONS locked (firaz)
- ChatPane is the daily driver to perfect; TerminalComposer is untouchable/done.
- ChatGPT sub via **Codex native** (not opencode's ChatGPT auth); opencode = the "everything else / free fallback" engine. ONE free model only, no Chinese models.
- Docker→Colima idea: **PARKED** ("nvm the docker"). Don't action.
- Codex/opencode replies land whole (no token streaming) — accepted; the "Working… m:ss" timer covers it.
- Free-model latency is backend-bound (3–25s, variable) — NOT our wrapper; can't fix locally. codex ~9s floor (17.5K base prompt).

## PENDING (next session)
1. **VERIFY drag files→chat works.** Mechanism is wired (FilesPane rows draggable w/ `AIOS_PATH_MIME`; `PaneDropZone` wraps ChatPane, auto-arms via window dragover in `lib/paneBus.ts`; `extractPath`→`insertPath`). firaz reported it not working but that may have been the now-fixed clipped-overlay. If still broken: chase z-index / event-capture between FilesPane and ChatPane (PaneDropZone overlay is `z-30 absolute inset-0`). FilesPane onDragStart at `FilesPane.tsx:266`.
2. **Confirm slash-dropdown direction.** firaz said "reuse down instead of overlay" — I made it a compact left-anchored dropdown (still opens upward since composer is bottom-docked). Confirm that's what he meant; he may want it to open downward (only fits in the empty hero state where the composer is centered).
3. **Backlog (PLAN-chatpane-daily-driver.md)** still open: edit-a-prior-message→resend, cumulative cost HUD, retry-with-different-model without nuking the thread (route via `resumeId` — model change is a session-restart effect dep, the sharp edge), ⌘F transcript find, codex-style approval scope-tiers, recursive @ mentions, markdown tables/blockquotes/syntax-highlight.

## Key files / anchors
- `src/components/ChatPane.tsx` (~3200 lines) — the daily driver. composer is a `useMemo` (~line 1640+); slashCommands ~1354; handleEvent ~574; session-restart effect deps include model/permission/effort/cwd (changing any restarts the engine — route mid-convo switches via `resumeId`).
- `src-tauri/src/chat.rs` — engines: `start_per_turn`, `run_per_turn`, `adapt_codex_line`, `adapt_opencode_line`.
- `src/components/TerminalPane.tsx` — `claudeStatus` PTY parser (~297) feeding the terminal composer pills. DON'T edit TerminalComposer.
- `src/lib/paneBus.ts` — `AIOS_PATH_MIME`, `onAiosDrag` (drop-overlay arm signal).
- `PLAN-chatpane-daily-driver.md` + `PLAN-chat-engines.md` — the design/backlog (untracked; both deep-dive reports synthesized here).

## Live context
- Verified on this machine: codex-cli 0.135.0 (logged in via ChatGPT Plus), opencode 1.15.12 (`~/.opencode/bin`). `timeout` is NOT installed on this mac (use bg + file).
- Untracked PLAN docs in repo root (leave): PLAN-control-plane, PLAN-customizable-sidebar, PLAN-model-agnostic, PLAN-chat-engines, PLAN-chatpane-daily-driver.
