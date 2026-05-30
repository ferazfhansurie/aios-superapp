# AIOS shell — live session handoff
2026-05-31 ~02:00 MYT

> **Next session: read THIS, then `git -C ~/Repo/firaz/aios/shell log --oneline -12` + TaskList.**
> Repo `~/Repo/firaz/aios/shell`, branch `master`, head `b65da55`, **10 commits ahead of origin, NOT pushed** (don't push unprompted).

## Working rules (firaz, this session — LOAD-BEARING)
- **Build cadence:** edit freely → only `commit → tauri build → install → launch` when the session is bloated or at handoff. Do NOT build per-change.
- **Build/install loop (NO `cd` — triggers permission prompts):**
  `pnpm --dir ~/Repo/firaz/aios/shell tauri build` → `pkill -9 -f "AIOS.app/Contents/MacOS"; rm -rf /Applications/AIOS.app; cp -R ~/Repo/firaz/aios/shell/src-tauri/target/release/bundle/macos/AIOS.app /Applications/AIOS.app; open /Applications/AIOS.app`
- **ALWAYS `npx tsc --noEmit` (must be 0 errors) BEFORE a tauri build** — `pnpm build` runs tsc and a single TS error wastes a full ~60s build.
- **No WhatsApp** unless firaz says — keep replies in-pane.
- App currently installed + running (the flashy-composer build).

## SHIPPED this session (all on master, build-verified, 0 TS errors)
- `dbdbdd1` **notes pane** — apple-notes scratch pane. `src/components/NotesPane.tsx` + `src/lib/notes.ts`. One `.md`/note in `~/.aios/notes/`, title=first line, list + autosave (600ms), search, 5s cross-process poll. Backend `files::delete_path` (file-only, dir-guarded) in `src-tauri/src/files.rs` + `lib.rs`. `notes` app in `src/lib/apps.ts`.
- **/notes skill** — `~/.claude/skills/notes/SKILL.md` (+ in `aios-firaz/.claude/skills/_INDEX.md`). Oracle reads/writes the SAME `~/.aios/notes/*.md`. firaz's one-shot idea inbox.
- `c1f6363` **send-to-AI** — notes "send" routes to `settings.defaultAi` (claude-code|terminal|chat, default claude-code), reuses an alive pane via `paneSubmitters` (`src/lib/paneBus.ts`), spawns only if none, pastes AND submits. + **open-panes "OPEN" rail** (`OpenPanesList` in App.tsx) replacing the floating overlay. + youtube fullscreen rAF sequencing.
- `a3df0fb` **pane navigation** — ⌘F fullscreen selected pane (any type), ⌘W close focused, ⌘`/Ctrl+↑/3-finger-swipe-up → `PaneOverview` mission-control, ⌘1-9 jump, ⌘M minimize / ⇧⌘M restore-all, Esc exit fullscreen. **Startup reopens last layout** (`loadLayout`/`saveLayout`, gated on `reopenLastLayout`; X drops a pane from the set).
- `b65da55` **flashy composer** — `TerminalComposer.tsx`: gradient send (hover lift+glow, active spring), mic accent-glow, box accent halo + top-edge sheen on focus.

## DECISIONS locked (firaz)
- Default AI for "send" = **claude-code** (claude in a terminal), configurable via `settings.defaultAi`.
- Notes = plain `.md` on disk so the oracle shares the files — that's the moat, don't regress to a DB/localStorage.
- Flutter companion app = **parked** (seed note in `~/.aios/notes`), revisit after custom-panes + OSS readiness.
- Send-to-AI must reuse an EXISTING alive pane; spawn only when none active.

## PENDING (firaz asked, NOT started — next session picks one)
1. **Default-AI picker in Settings UI** — data layer done; add toggle in `src/components/Settings.tsx` general section (~line 919, mirror the `defaultPaneType` Row): claude-code / terminal / chat.
2. **Send ALL notes at once** — NotesPane button concatenating every note → same `onSend`.
3. **Per-note todo/done status** — auto-detected (regex `- [ ]` or oracle), shown in the list.
4. **Purge old duplicate AIOS apps** (causes duplicate macOS permission entries). Keep ONLY `/Applications/AIOS.app` (`com.adletic.aios`). Delete after confirming bundle ids: `~/Desktop/AIOS.app`, `~/aios-terminal-prod-snapshot-2026-05-04/applications/AIOS.app`, `~/Repo/firaz/adletic/aios-terminal/release/{mac,mac-arm64}/AIOS.app`, `~/Repo/firaz/terminal/extra/osx/AIOS.app`.
5. **Custom panes** ("make panes as customisable as possible") — user-created/edited panes (command/url/html) + in-app builder + ai-generated. Big, unscoped.
6. **Notes best-in-class** — research done (below).

## Notes research — build-next shortlist (plain-md on disk)
1. **Markdown live preview + code highlight** (L) — swap the raw `<textarea>` for CodeMirror 6 (md + Shiki). Biggest gap vs competitors; foundation for slash/checkboxes.
2. **Ask-AI-across-all-notes w/ citations** (M) — oracle greps `~/.aios/notes`, answers, links source. THE differentiator (fs access + send channel already exist).
3. **Global quick-capture hotkey** (M) — Tauri global shortcut → mini window → save+close. Kills capture-latency, the #1 universal complaint.
4. **Tags `#tag` + daily notes + pin** (S each).
5. **AI auto-tag + auto-status on save** (M).
Don't out-Obsidian Obsidian on plugins — win on "the oracle IS in the notes." Defer backlinks/graph, slash, templates.

## Gotchas
- **Tooling flaked hard** this session: large-file Reads + `cd`-chained Bash intermittently returned "internal error". Use `git -C`/`pnpm --dir`, read ≤120-line windows, python heredocs over sed/awk for big files. A python in-place delete once OVERSHOT and removed `PaneCard`+`Splash` from App.tsx — recovered by splicing from `c1f6363`. Always `npx tsc --noEmit` == 0 before build.
- Untracked in repo root: `PLAN-control-plane.md`, `PLAN-customizable-sidebar.md` (pre-existing, leave).
- Detailed copy also at `~/.aios/state/handoffs/2026-05-31-0200-shell-notes-pane-nav.md`.
