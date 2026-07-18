# AIOS Shell — 4-Pane First-Class Polish Plan

> Scope locked by firaz (2026-06-06): only **4 panes are first-class** — chat · terminal · files · browser — made best-in-class AND working together seamlessly. Everything else (notes/codex/pet/status/gui/tui/crm) is optional, hidden by default. CrmPane/whatsapp-drag dropped.
> Hard requirement: the chat AI must behave **EXACTLY the same on codex and claude** (no engine feels second-class), and must be **lean — no context bloat** that dumbs the model.
> Driven autonomously from the terminal (NOT inside the app — building inside the app's own chatpane kills the session on every rebuild). Loop: study → review → plan → fix → build → test → repeat.

Full audit transcripts: `/private/tmp/claude-501/-Users-firazfhansurie/354d3665…/tasks/` (per-bug) and `…/ad1bedc7…/tasks/` (5 deep per-pane audits). This doc = the consolidated ranked plan.

---

## DONE (committed)
- Took over tree from in-app chatpane session; checkpoint @ `a6c7e10` (cargo+tsc clean).
- effort selector now drives codex turn/start reasoning (max/ultracode→xhigh).
- default context budget lean→agent (codex boots full-MCP, not blind).
- cost display removed (sub = no per-turn $).
- cmd+K perf: useDeferredValue + result cap + run-based highlight.
- pane-close crash fixes: browser_close stops media + about:blank before wv.close() (youtube leak); closePane drops OS fullscreen + clears stale refs; BrowserPane unmount hides before close.
- resume: chat panes persist+restore cwd.
- backend find_files + search_in_files (ignore + base64) — UI still unwired.
- **per-turn preamble KILLED** (`buildAiosShellContext` removed): it re-injected 4 lines every turn bragging about "native ops" the chat session has NO tools to perform → induced hallucinated tool-talk + context bloat on both engines. Session identity belongs in CLAUDE.md/AGENTS.md (read once via cwd). aiosContext.ts + test deleted.

---

## ROUND 1 — ChatPane parity (the "exact same codex/claude" core) · ONE rebuild · all in ChatPane.tsx + chat.rs (single-author, sequential)
1. **Codex Stop = process-kill, not interrupt** (audit 5.1). `stopStrategy("codex")` returns `kill-and-restart` → kills the app-server + loses the buffered partial answer + handshake. Backend already has `turn/interrupt` wired (`chat_interrupt`→`codex_interrupt`). Flip to `"interrupt"`. Claude already interrupts. → parity.
2. **Reattach treats codex as claude** (5.2). `chat_reattach` returns only `{busy}`; frontend `model.engine` stays claude → wrong stop-strategy, steer hidden, wrong usage provider. Return engine+model+claude_id, re-sync `model` state.
3. **Codex "ask each time" approvals silently auto-acked `{}`** (2.2). default mode = `on-request`; codex approval requests get blanket `{result:{}}`, no ApprovalCard. Adapt codex approval requests into the same `can_use_tool`/ApprovalCard shape claude uses; route decision back as the RPC reply.
4. **Codex token/ctx usage shows blank** (3.3). `tokensFromUsage` reads claude field names; codex `turn.usage` uses `cached_input_tokens`/different envelope → ctx pill + footer zero for codex. Map codex usage fields.
5. **Codex answer double-render / mis-route** (1.1). answer streams via deltas AND re-emits full text on item/completed; only a frontend null-check prevents a doubled bubble, defeated when delta itemId≠answer_item. Make item/completed authoritative (single source of truth).
6. **Effort chip lies for codex** (3.2). UI shows max/ultracode but codex caps at xhigh silently. Show the effective cap.
7. **claude crash/EOF leaves composer stuck streaming forever** (5.3). claude reader emits `chat-exit` but nothing listens + no synthetic result. Listen for `chat-exit`/emit synthetic result on EOF.
8. **Seed auto-send can vanish into a restarting session** (6.1). gate seed send on post-restart session id.

## ROUND 1.5 — ChatPane UX (run immediately after R1; same files: ChatPane.tsx + chat.rs)
1. **Auto-focus composer** on entering/activating a chat pane (focus on mount + on becoming active; don't steal focus mid-action).
2. **Double-tap ↓ → scroll to bottom** (two ArrowDown <300ms) anywhere in the pane → smooth-scroll + re-latch autoscroll-stick. Pairs w/ autoscroll fix (audit 1.4).
3. **Resume picker rework** — (a) sort by last-edited mtime desc, not created (+ fix record_chat_session stamping mtime on every no-op upsert); (b) preview = latest message sent, not first; (c) show relative timestamp; (d) better color indicator + highlight the currently-open session, show engine + recency.
4. **Pane-native file routing (deterministic, NO AI reliance — same anti-bloat principle as killing the preamble).** Opening files from chat fails because the AI emits a bare name and paneForFile can't resolve it. Fix: (a) HARVEST absolute paths from tool_use inputs (claude Read/Edit/Write/MultiEdit/NotebookEdit file_path, Bash file args, codex apply_patch/exec) in the stream reducer → 'open in pane' on tool cards using the real path; (b) resolve text/code-fence file mentions against the session cwd → backend existence check → clickable only if it resolves (never search-by-name); (c) all → openFileInPane(absPath) → paneForFile, identical to FilesPane open.

## ROUND 2 — Cross-pane seamless foundations (the "work together" centerpiece) · Rust + App.tsx + paneBus (disjoint from ChatPane)
1. **Native menu + `tauri-plugin-global-shortcut`** → emit `pane-nav` events so ⌘1-9/⌘W/⌘F/⌘K/⌘B work while focus is in a terminal or browser webview (currently dead — `window.keydown` never reaches native child webviews). #1 leverage; flagged HIGH by browser + terminal + cross-pane audits.
2. **Canonical `paneRegistry`** (rect-based `paneKeyAtPoint`, `canAccept`/`drop`/`getRect`/`getContext` per pane) — replaces fragile `elementFromPoint` that fails over WKWebView.
3. **Webview-hide-on-drag** — on `onAiosDrag(true)` shrink every browser webview to 0×0 so drops land on React; wrap terminal/browser/editor/viewer in `PaneDropZone` (only chat has it today). Unblocks the 4×4 DnD matrix (only 1/12 pairs work now).
4. **Browser `on_download` → emit → openFileInPane** + dev-server-ready detector (parse PTY stdout `localhost:PORT` → `openUrlInPane`) = "run project → auto-launch in browser pane" (firaz's explicit ask).
5. **Hide optional panes by default** — add `firstClass` flag to `apps.ts` AppDef; `seedDefault` sets `hidden:!firstClass`; bump sidebar SCHEMA_VERSION to re-seed. Keep reachable via ⌘K.
6. **Unify focus** (`focusedPane` ref + `activeKey` state → single source).
7. Browser in-pane menus + closePrompt modal render UNDER the webview (1.1/1.2) — derive overlay-hide from one source.

## ROUND 3 — FilesPane = "check code as good as VS Code"
1. **Cmd+P fuzzy finder** (backend `find_files` ready, ZERO ui) — reuse CommandPalette fuzzy scorer + MRU; basename-weighted.
2. **Cmd+Shift+F global search UI** (backend `search_in_files` ready, ZERO ui) — group by file, jump-to-line (needs new open-at-line param on EditorPane).
3. **Editor tabs + open-file dedup** — every open spawns a new pane today.
4. **Intellisense via real `monaco.Uri.file()` models** (today anonymous models → no go-to-def/hover; also fixes a model leak).
5. **Save-conflict detection** (mtime check in write_text_file) — AI + human editing same file silently clobbers (data-loss).
6. **FS watcher (`notify`)** → live tree + git decorations + editor external-change.
7. Right-click context menu (rename/new/delete/reveal); ⌘S saves ALL panes bug; prune node_modules from tree; real markdown renderer.

## ROUND 4 — TerminalPane first-class
1. **Stable pane keys** (App.tsx:231 `Math.random()` every launch) — flagship "tmux survives restart" is a LIE across relaunch: restore spawns a NEW empty session, orphans your running claude. Persist `key` in saveLayout/loadLayout.
2. **Remove session from registry on reader-thread exit** (pty.rs) — dead PTYs leak + `pty_write` black-holes input silently.
3. **Wire `pty-exit` listener** → inline "process exited, ⏎ restart / ⌘W close".
4. **`aios-term-*` GC** (startup reaper + manager UI) — orphans accumulate forever.
5. **Bracketed paste** for composer-send + clipboard — kills the 40/150/600ms magic-timer races + paste-injection.
6. `@xterm/addon-search` find bar; debounce ResizeObserver; WebglAddon.onContextLoss; codex composer parity; route URL clicks into in-app browser; font zoom + theme settings.

## ROUND 5 — BrowserPane first-class
0. **TAB = PANE (default)** (firaz): every 'new tab' → new browser PANE. ⌘T / target=_blank / window.open / ⌘-click → new pane (on_new_window already does this — make it intentional + easy + add 'open in new pane' affordance). Keep OAuth-popup handling so auth flows don't strand. Debounce spawn spam.
0b. **Exit fullscreen on ANY new-pane spawn** — if maximizedKey!=null when a pane spawns, drop OS fullscreen + clear maximizedKey so the new pane is visible and firaz sees it. (browser-new-pane listener + spawn().)
1. **Native back/forward/reload** via WKWebView (not `eval("history.back()")` which fails cross-origin); canGoBack/Forward button states; "Force reload" actually cache-bypass (reloadFromOrigin).
2. **Enable DevTools** (`devtools` feature + `browser_open_devtools`) — can't replace Chrome for dev without it.
3. **Find-in-page (⌘F)** native; stop hijacking ⌘F for fullscreen on browser panes.
4. **localhost/http dev URLs broken** — `normalizeUrl` sends `localhost:3000` to Google + forces https. Fix bare-host/port + allow http for localhost.
5. **Loading/progress state + error pages** (wire on_navigation/load+error).
6. Real cookie/cache clear (WKWebsiteDataStore); bounds-sync rAF during transitions; on_new_window OAuth-popup handling; per-site zoom; fullscreen via KVO not 350ms poll.

## CROSS-CUTTING (fold into whichever round touches the file)
- Kill the pervasive `.catch(()=>{})` silent failures (draft save, terminal write, approval reply, browser nav) — surface at least once.
- Transcript virtualization + stop per-token full-array copy + scope the 1Hz `now` re-render (ChatPane 4.1/7.4) — janky long chats.
- Resumed history is text-only (loses tool calls/thinking/diffs) — parse them into the same Turn kinds (ChatPane 4.2).
- Reconcile the 4 disagreeing extension lists (editorLanguage/fileIcons/files.rs/App VIEWER_EXT).
