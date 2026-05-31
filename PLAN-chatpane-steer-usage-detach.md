# ChatPane v2 — live usage bar · codex-style steering · pane-close persistence

> **SHIPPED 2026-05-31** (cargo check + tsc both clean):
> - **Phase 1 — live usage bar:** `chat.rs` emits synthetic `usage` events — codex
>   off its `account/rateLimits/updated` push, claude by re-reading usage.json after
>   each `result`. ChatPane renders a thin 5h bar + 7d% + reset + cumulative session
>   $ under the composer (`UsageStrip`), seeded on mount so it shows before turn 1.
> - **Phase 2 — queueing/steering:** frontend type-ahead queue. Enter (or the new
>   ⏎ button) while streaming queues instead of dropping; queued msgs show as
>   dimmed cancelable chips and auto-fire in order as each turn completes. Works
>   for ALL engines. (codex true mid-turn `turn/steer` inject = documented
>   fast-follow; the queue is the reliable mechanism.)
> - **Phase 3 — survive quit:** all three engine spawns now use `process_group(0)`
>   so a cockpit force-quit no longer aborts an in-flight turn (it finishes + writes
>   its transcript; resume on next launch). Pane-close survival already existed.
>   Cross-restart *reattach* still needs the `aios-chatd` daemon (Phase 4).
>
> Caveat: claude's 5h/7d % comes from usage.json (statusline-written) — it's
> account-wide + accurate but only ticks live when the terminal statusline runs;
> codex ticks fully live via its push. codex push param-shape is handled
> defensively (null-safe) since it wasn't runtime-verified.



> Deep-dive plan. 2026-05-31. Three asks from firaz:
> 1. live progress bar of usage-limit-consumed as you talk
> 2. message steering/queueing exactly like codex desktop
> 3. closing the pane (or quitting the app) doesn't stop the AI
>
> Good news after reading the code: ~60% of the hard plumbing already exists.
> This is mostly finishing + UX, not greenfield.

---

## What already exists (verified on disk)

**Detach/reattach (chat.rs):**
- `ChatSession` already has `sink`, `buffer` (6000-line ring), `detached`, `notify_on_done`, `pending_turn`, `busy`. (chat.rs:84–124)
- `chat_detach(id, notify)` drops the pane's channel but the reader thread keeps running. (chat.rs:1349)
- `chat_reattach(id, chan)` replays the ring buffer then goes live. (chat.rs:1362)
- React mount effect only kills the session on unmount **if not detached**. (ChatPane.tsx:1044–1119)
- → closing a pane mid-turn already keeps the model running **as long as the app stays open**.

**Codex app-server (persistent JSON-RPC over stdio):**
- `start_codex_appserver()` does initialize → initialized → thread/start|resume. (chat.rs:860)
- `turn/interrupt` already wired for true stop. (chat.rs:840, 846)
- `pending_turn` already queues the very first turn during the handshake race. (chat.rs:121–123, 834, 1061)
- PLAN-chatpane-daily-driver.md confirms `turn/steer` and `account/rateLimits/updated` exist in the live protocol (lines 142–148).

**Usage data (usage.rs):**
- `usage_stats` reads `~/.aios/state/usage.json` (claude, refreshed by statusline hook per turn). Shape: `rate_limits.five_hour.{used_percentage,resets_at}` + seven_day + cost + context_window.
- `codex_usage` reads newest `codex.rate_limits` row from `~/.codex/logs_2.sqlite`. Shape: primary(5h)/secondary(7d) `used_percent` + `reset_at`.
- `SidebarUsage.tsx` already renders 5h/7d bars with color thresholds + reset countdown, **polled every 30s**. (SidebarUsage.tsx:29–97)
- `node_bin()` helper exists in monitor.rs:117 for GUI-no-node problem.

So the gaps are: (a) usage isn't *live* and isn't *in the chatpane*; (b) steering past turn-1 isn't wired and there's no queue UI; (c) sessions die on app quit and there's no reattach tray.

---

## Feature 1 — live usage bar in the chatpane

**Goal:** a thin bar under the composer (or in the chat header) that ticks up the moment a turn finishes, not on a 30s poll. Shows the active engine's 5h window primarily, 7d as a secondary hairline, with reset countdown + % and color (accent → warn → danger).

**Codex (push-based, the good path):**
- The app-server emits `account/rateLimits/updated` notifications. In `adapt_codex_appserver_frame()` (chat.rs:1024) detect that method and emit a synthetic event line `{"type":"usage","provider":"codex","five_hour":{...},"seven_day":{...}}` straight into the same channel the chat uses. Zero polling — it arrives exactly when the model reports it.

**Claude (file-watch, no push protocol):**
- `~/.aios/state/usage.json` is rewritten by the statusline hook every turn. Add a Tauri-side file watcher (notify crate) on that path; on change, read + emit a `usage` Tauri event. Fallback: on every `result` event in `ingest_line` (chat.rs:1269) for a claude session, re-read usage.json once and emit. That guarantees a tick right after each turn even if the watcher misses.

**Frontend:**
- New `<UsageBar inline>` component (extract the bar from SidebarUsage.tsx so sidebar + chatpane share it).
- In `handleEvent` (ChatPane.tsx:712) add a `case "usage"` that updates a `usage` state → re-renders the inline bar. Animate width with the existing 700ms transition.
- Keep the 30s poll as a floor for when nothing is streaming.

**Nice-to-have (cheap, high signal):** also surface **cumulative session cost** next to the bar. Today cost is per-turn only (ChatPane.tsx:988); add a `sessionCostRef` that sums `total_cost_usd` across results.

**Estimate:** ~0.5 day. The renderer already exists; this is one new event type per engine + one watcher.

---

## Feature 2 — codex-style message steering / queueing

This is the marquee feature. Codex's UX: while the agent is generating you can keep typing; submitting **queues** the message and it's injected at the next model step — no interrupt, no new turn, no lost context. Decompiled codex confirms the mechanism:

- Protocol op `turn/steer { expectedTurnId, input }` appends input to the running turn's `input_queue`, consumed at the next step. (codex-rs `core/src/session/input_queue.rs`)
- Steerable only for **normal** turns. `review` and `compact` turns reject steer (`"cannot steer a review/compact turn"`).
- Errors to handle: `no active turn to steer`, `expectedTurnId must not be empty`, `input must not be empty`.
- It's append-not-restart — that's *why* it feels better than every other tool's "you interrupted, start over".

**Backend (chat.rs):**
1. Add `queued: Mutex<VecDeque<QueuedMsg>>` to `ChatSession` (generalize the existing `pending_turn`).
2. Track `active_turn_id` + `turn_kind` from codex frames so we know steerability.
3. New command `chat_queue(id, text)`:
   - **Codex, turn in flight, steerable:** send `turn/steer { expectedTurnId: active_turn_id, input }` via `codex_rpc_write()` (chat.rs:798). Message lands in the live turn.
   - **Codex, turn in flight, NOT steerable (review/compact):** hold in `queued`, flush on next `turn/start` after completion.
   - **Claude / opencode (no steer protocol):** hold in `queued`; on the `result` event in `ingest_line`, auto-fire the next queued message as a fresh turn. This gives claude *queueing* (type-ahead that auto-sends) even though it can't true-*steer* mid-turn. Honest UX: label it "queued" not "steered".
4. Emit a `queue` event whenever the queue changes so the UI can render pending chips.

**Frontend (ChatPane.tsx):**
- When `streaming === true`, the composer's submit calls `chat_queue` instead of `chat_send`. Show queued messages as dimmed "pending" bubbles above the composer with an ✕ to cancel (remove from queue).
- Distinguish visually: codex steerable turn → "↳ steering into current turn"; claude → "⏳ queued, sends next".
- Keyboard: Enter queues; the existing `stop()` (Esc / interrupt, chat.rs:1424) still hard-stops. Optionally `⌥Enter` = interrupt+send-now for the "actually, stop and do this instead" case.
- Edge: if user queues then the turn errors/interrupts, surface queued items and ask keep/drop (don't silently fire into a failed state).

**Estimate:** ~1.5–2 days. Codex path is a clean protocol call; the claude/opencode auto-flush queue is the fiddly part (ordering, cancel, error recovery).

---

## Feature 3 — sessions survive pane close AND app quit

Pane-close already works in-process. Two real gaps remain:

**Gap A — app quit kills everything.** Claude/opencode children are direct child processes of the Tauri app; quitting the app SIGKILLs them. Codex via direct binary spawn dies too.

Fix path (matches PLAN-chatpane-daily-driver.md:99 "daemon + proxy"):
- **Codex:** run the app-server as a **detached daemon** (own process group, not a child of the app) + a tiny stdio proxy. On app launch, discover running codex threads and `thread/resume` into them → the conversation literally continues across an app restart. This is the cleanest because codex's protocol is already resume-native.
- **Claude:** claude `-p stream-json` is a child. To survive quit, either (a) wrap it in a small persistent **side-daemon** (`aios-chatd`) that owns the children and exposes the same channel over a unix socket, and the Tauri app becomes a thin client that attaches/detaches; or (b) accept that claude turns don't survive full quit but *do* survive pane-close (current behavior), and on relaunch use the existing `--resume <claude_id>` + transcript replay (chat.rs:420, 1588) to rejoin the conversation (loses the in-flight turn only).
  - Recommendation: ship (b) first (near-free, transcript replay already exists), build the `aios-chatd` daemon (a) as the proper fix in a later pass. The daemon is also what unlocks WhatsApp/terminal/cockpit all talking to the *same* live chat — strategically the right spine.

**Gap B — no way to see/rejoin backgrounded chats.** `list_chat_live()` exists (chat.rs:1398) but isn't surfaced.
- Add a "running chats" tray/dropdown in the chat header: each live session shows engine, title, busy/idle, last activity. Click → `chat_reattach` into a pane (buffer replays, then live). (chat.rs:1362)
- Show a badge when a detached session's turn **completes** (you already have `notify_on_done`); turn that into an in-app toast + the tray dot, not just an OS notification.

**Estimate:** Gap B + claude-resume(b) ~1 day. Codex detached daemon ~1–1.5 days. Full `aios-chatd` ~3–4 days (separate epic).

---

## Suggested sequencing

**Phase 1 (1 day) — quick wins, all low-risk:**
- Live usage bar (codex push + claude file-watch) → inline in chatpane.
- Running-chats tray surfacing `list_chat_live` + reattach.
- In-app completion toast from `notify_on_done`.

**Phase 2 (2 days) — the steering epic:**
- Backend queue + codex `turn/steer` + claude/opencode auto-flush.
- Pending-message UI (chips, cancel, steer-vs-queue labels, ⌥Enter interrupt-now).

**Phase 3 (1–1.5 days) — survive app quit:**
- Claude `--resume` rejoin on relaunch (cheap).
- Codex detached daemon + thread/resume on launch.

**Phase 4 (later epic) — `aios-chatd` daemon spine:**
- One persistent process owns all chat sessions; cockpit + WA + terminal all attach. This is the real "AI never stops" + "same context everywhere" foundation, and it lines up with the superapp 3-layer goal.

---

## Key files (cheat sheet)

| What | File:line |
|---|---|
| Chat React component / handleEvent / dispatch | ChatPane.tsx:712, 1232, 1309 |
| Mount/unmount + detach handle publish | ChatPane.tsx:1044–1119 |
| Rust session struct | chat.rs:84–124 |
| send / per-engine dispatch | chat.rs:1329 |
| codex app-server start + frame adapt | chat.rs:860, 1024 |
| codex send/steer/interrupt | chat.rs:813, 840, 798 |
| ingest_line (buffer + forward + result detect) | chat.rs:1269 |
| detach / reattach / list_live | chat.rs:1349, 1362, 1398 |
| claude resume + transcript replay | chat.rs:420, 1583 |
| usage commands | usage.rs:11 (claude), 32 (codex) |
| usage UI + 30s poll | SidebarUsage.tsx:29–97 |
| node_bin helper | monitor.rs:117 |
