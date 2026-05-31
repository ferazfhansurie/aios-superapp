# PLAN — make ChatPane the best daily-driver chat UI

Synthesis of two deep dives (2026-05-31): (A) our ChatPane/TerminalPane/chat.rs
gap analysis, (B) openai/codex Rust source (`codex-rs/`) stealable patterns.

## The unifying insight (from codex source)
Codex models everything as a flat, typed **event stream** —
`thread.started → turn.started → item.started/updated/completed → turn.completed`
— where each `item` (agent_message · reasoning · command_execution · file_change
· mcp_tool_call · todo_list · web_search · error) is a keyed render unit patched
in place by `id`. The SAME events are persisted as **JSONL-per-session**, so
**resume = replay the file through the same reducer the live stream uses.** One
code path for live + history. Our chat.rs already normalizes engines into a
claude-shaped stream + ChatPane already renders tool/activity/diff/todo — so we're
architecturally close; the wins are additive.

Codex source refs (confirmed): events `codex-rs/exec/src/exec_events.rs`;
composer `tui/src/bottom_pane/chat_composer.rs` (+ `_history.rs`, `paste_burst.rs`);
sessions `rollout/src/recorder.rs`; status `tui/src/status/`; approvals
`bottom_pane/approval_overlay.rs`.

## Ranked build order (value/effort; files in ChatPane.tsx unless noted)

### HIGH — do first
1. **Image/file attach + paste + drag in ChatPane** (M). The clearest gap — the
   terminal composer already has it (`TerminalComposer.tsx` ImageChip/addImage/
   onPaste/onDrop/+menu); ChatPane has none. Port it; prepend quoted temp paths in
   `dispatch`. Reuse `saveImageTemp` (lib/fs). Steal codex's **large-paste→chip**
   (>1000 chars becomes `[Pasted N chars]`, real text stored, expanded on submit).
2. **Draft persistence per pane** (S). `input` is lost on remount/`/clear`/restart.
   Persist to `localStorage[aios-chat-draft:${paneKey}]`; restore in the
   `useState(seed ?? "")` init; clear on send.
3. **Autoscroll pause + jump-to-latest pill** (S). Autoscroll force-pins every
   token (`useEffect` on `turns`) so you can't read backlog mid-stream. Track
   `atBottom`; guard the scroll; floating "↓ latest" when scrolled up.
4. **Edit a prior user message → resend** (M). `UserBubble` only has copy+regen.
   Add inline edit → repopulate composer (optionally truncate `turns` after it).
5. **Full ↑/↓ history stack in chat** (S). Chat's ↑ recalls only `lastSentRef`.
   Port `history[]`+`histIdxRef` from TerminalComposer. Steal codex's **edge-gate**:
   recall only when text empty OR (text==last recalled AND caret at line boundary)
   — lets multiline + history coexist without fighting arrows.

### MED
6. **Cumulative cost + true context HUD** (S). Sum `costNum` across results into a
   session total; show `$total` by the ctx chip; ctx % visible from start. Steal
   codex `format_tokens_compact` rules (12.3K) + the status-card layout.
7. **Retry-with-different-model without nuking the session** (M). Model change is
   a session-restart effect dep → drops the thread. Route retry through `resumeId`.
8. **In-transcript find (⌘F)** (M) over `turns`.
9. **Approval UX upgrade** (M). Steal codex's **scope tiers**: once /
   for-this-session / for-this-prefix / deny / abort-with-feedback. The
   "approve this prefix for the session" tier kills 90% of repeat prompts.
10. **Recursive/fuzzy @ mentions** (M). `loadMentions` reads one dir level only.

### LOW
11. Markdown: tables + blockquotes + task-list checkboxes (extend MarkdownBlocks).
12. Syntax highlighting in CodeBlock.
13. `/cost` `/compact` slash commands; rename/delete in /resume picker.
14. Fullscreen/expand composer for long prompts.

## Sharp architectural edge to respect
`model`/`permission`/`effort`/`cwd` are all in ChatPane's session-restart effect
deps — changing any tears down + re-spins the engine. Any "switch mid-conversation"
work (#7) MUST route through `resumeId` or it loses the thread.

## Bigger future bet (from codex session model)
Adopt JSONL-per-session rollout for chat (date-bucketed, append-only, greppable),
so resume replays through the live reducer + a SQLite/JSON index powers a fast
session switcher. Larger; revisit after the HIGH items land.

---

## CODEX APP-SERVER — VERIFIED PROTOCOL (2026-05-31, reverse-engineered + live-tested)

Goal: replace per-turn `codex exec` spawn with a persistent **daemon** → survives
app quit (turn keeps running), kills cold-start jitter, gives in-app login + live
usage. Protocol captured from `codex app-server generate-ts` + LIVE handshake tests.

### Transport / lifecycle
- `codex app-server daemon start|stop|status` — persistent DETACHED daemon (the
  survive-app-quit mechanism; tmux-equivalent). App connects via
  `codex app-server proxy` (stdio ↔ daemon control socket). Daemon outlives app.
- ⚠️ **CORRECTION (0.135.0, verified 2026-05-31):** the npm-installed `codex`
  CANNOT run the daemon — `daemon start` errors "managed standalone Codex install
  not found at $CODEX_HOME/packages/standalone/current/codex". The daemon launches
  app-server from that FIXED standalone path. Install it (ISOLATED, no PATH-shadow
  of the daily codex):
    `CODEX_INSTALL_DIR=<scratch> CODEX_HOME=~/.codex-chat \
       sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'`
  then DELETE the `/tmp PATH` line the installer appends to `~/.zprofile`
  (it would shadow the nvm daily codex + break when /tmp clears). Standalone lands
  at `~/.codex-chat/packages/standalone/current/codex`.
- ⚠️ `codex app-server --listen unix://PATH` is **GONE in 0.135.0** — raw
  `app-server` only has subcommands {daemon, proxy, generate-ts, generate-json-schema}.
- ✅ **The working direct-stdio entry = run the STANDALONE binary itself with no
  subcommand:** `~/.codex-chat/packages/standalone/current/codex app-server`
  → newline-delimited JSON-RPC stdio app-server (initialize replied clean). This is
  the SAME binary the daemon manages, so its protocol+auth behavior == the daemon's.
  Use THIS for chat.rs (own child for in-app turns) OR the daemon+proxy for
  survive-app-quit. The daemon `proxy` relay closed my sessions repeatedly (control
  socket relay quirk, needs `enable-remote-control`) — driving the standalone binary
  directly is the reliable path; revisit proxy only when wiring survive-app-quit.
- Wire = newline-delimited JSON-RPC 2.0 over stdio. CODEX_HOME=~/.codex-chat (MCP-stripped).
- `initialize` params REQUIRE `capabilities` (omitting → socket closes):
  `{clientInfo:{name,title:null,version}, capabilities:{experimentalApi:false,requestAttestation:false}}`

### ✅ AUTH RESOLVED (verified 2026-05-31) — NO client-side answerer needed
Last session's "auth wall" (turn died on `account/chatgptAuthTokens/refresh`) was a
**MISDIAGNOSIS.** Truth: the standalone app-server **self-manages chatgpt OAuth.**
Proof: `getAuthStatus {includeToken:true, refreshToken:true}` refreshed a 3-day-stale
token to a FRESH valid JWT with ZERO client round-trip, and the server **NEVER sent**
`account/chatgptAuthTokens/refresh` to the client across full handshake+turn. So the
rust build does **NOT** need an auth-refresh answerer — only the approval answerers.
The `responseStreamDisconnected / request timed out` seen here is **environmental**
(headless tool sessions can't hold the long SSE inference stream — `codex exec`
reproduces the identical error in the same context; short HTTPS auth calls succeed).
On the real GUI/terminal (where codex streams daily) the turn completes. Re-confirm
turn-completion once, live, in the GUI app — but auth is settled.

### Turn flow (VERIFIED end-to-end — streamed "yo. what's up.")
1. → `initialize` {clientInfo:{name,version}}  → result (userAgent, codexHome…)
2. → notify `initialized` {}
3. → `thread/start` {}  ← `thread/started` {thread:{id}}   (id = threadId)
4. → `turn/start` {threadId, input:[{type:"text",text}], model:"gpt-5.5"}
5. ← `turn/started`, then stream ← `item/agentMessage/delta` {threadId,turnId,itemId,delta}
6. ← `item/completed` {item:{type:"agentMessage",...}}  ← `turn/completed` {threadId,turn}

### ⚠️ CRITICAL GOTCHA (cost hours if missed)
The server sends CLIENT REQUESTS (have BOTH `method` AND `id`) that the client
MUST answer or the turn STALLS FOREVER (silent — looks like a hang, no error).
Seen: `account/chatgptAuthTokens/refresh`. Also approvals:
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, `execCommandApproval`, `applyPatchApproval`.
Answering with `{jsonrpc,id,result:{}}` unblocked the turn in the live test.

### Resume / interrupt / usage / login (methods confirmed in ClientRequest.ts)
- `thread/resume` {threadId, model?...} — rejoin a running thread (survive-quit
  catch-up) OR load from disk. "If thread_id identifies a running thread,
  app-server rejoins that thread." ← THIS is the survive-app-quit reconnect.
- `turn/interrupt` {…} — stop current turn (real interrupt, not kill).
- `turn/steer` {…} — redirect mid-turn.
- `account/rateLimits/read` → RateLimitSnapshot; push: `account/rateLimits/updated`
  {rateLimits} — feeds the live usage bar (replaces the sqlite poll).
- `account/login/start` {LoginAccountParams} / `account/login/cancel`; push:
  `account/login/completed` — proper in-app login, no terminal.
- `model/list` — the real sub model catalog (could replace hardcoded gpt-5.x list).
- Token usage push: `thread/tokenUsage/updated` {threadId,turnId,tokenUsage}.

### Notification → existing ChatEvent mapping (frontend already renders these)
- item/agentMessage/delta → claude `stream_event` text delta
- item/started + item/completed (type: userMessage|agentMessage|reasoning|
  commandExecution|fileChange|mcpToolCall|webSearch) → tool/activity/diff rows
- turn/completed → claude `result`; error notif → result subtype error
- (reuse the adapt_codex_line normalization pattern already in chat.rs)

### Build shape (chat.rs) — NOT yet written
Persistent JSON-RPC client subsystem: daemon spawn/ensure-running, proxy connect,
id↔pending-oneshot map, server-request answerer (auth refresh + approvals),
notification reader → ChatEvent, thread/start|resume|turn/start|interrupt wired
into the chat command surface, reconnect-on-reattach. ~several hundred lines;
replaces run_per_turn for codex. Generated TS bindings cached at /tmp/cxproto
(regen: `codex app-server generate-ts --out <dir> -p <prettier>`).
