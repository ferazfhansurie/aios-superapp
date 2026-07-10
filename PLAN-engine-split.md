# PLAN — engine split (claude → Agent SDK sidecar, codex → app-server)

_status: REVISED 2026-06-20 — Agent SDK rejected, see Decision Record · advances goal "both engines work separately, better separation"_

## DECISION RECORD — Agent SDK rejected (2026-06-20)

Investigated `@anthropic-ai/claude-agent-sdk` as the claude backend (verify-first agent,
live docs). **Rejected on two grounds:**
1. **No mid-turn steering.** SDK supports interrupt (stop a turn) but NOT injecting a
   message into the in-flight turn — only queuing the next turn (official docs + SDK issue
   #120). The current rust `claude -p` path does stdin-inject mid-turn steering today →
   SDK is a regression.
2. **Subscription auth.** SDK requires `ANTHROPIC_API_KEY` (metered); Anthropic moved
   Agent-SDK usage off the subscription pool (separate paused/in-flux "agent credit" plan).
   The shell already runs claude on Firaz's **subscription for free** via `claude -p`
   (verified: live claude chat pid had no API key, enriched PATH, working). SDK risks
   turning on metered billing or breaking on the sub.

**→ Keep rust `claude -p` for the claude backend** (already env-fixed via `enriched_path()`).
Scrap the sidecar (old Phase 1). The real separation win — the per-engine controller split
(Phase 2) — needs none of the SDK and is now the unblocked core of this plan.

## Why

One `ChatPane` drives two fundamentally different backends (claude `-p` persistent stdin
process; codex app-server JSON-RPC) through one shared state machine
(`streaming` / `backendBusy` / `activeRunRef` / resume). That shared state is where the
"send → stop button → nothing, both engines" wedge is born: a single hung turn poisons
the pane and every later send gets steered/enqueued into a phantom turn. The fix is to
**separate the engines** — give each its own controller owning its own run lifecycle —
and, for claude, move off fragile stdin/stdout pipe-parsing onto the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`), which runs on Firaz's **subscription** auth (not API
billing — same as the CLI it wraps).

## Guiding constraints (decided)

- **Claude backend = Agent SDK node sidecar**, modeled on the existing codex app-server
  sidecar (`start_codex_appserver` in `chat.rs`). NOT a rust rewrite, NOT `claude -p`.
- **Codex backend = unchanged** (codex app-server).
- **Wire format stays the canonical claude stream-json shape.** The SDK already emits
  stream-json-shaped messages, so the sidecar→rust adapter is thin and the frontend
  reducer (`chatStream.ts`) is reused as-is.
- **Auth = subscription.** Sidecar runs with `ANTHROPIC_API_KEY` unset so the SDK falls
  back to the CLI's stored OAuth login (Max sub). Confirmed model: SDK `query()` spawns
  the same claude runtime the CLI uses and inherits its auth.
- **PATH discipline carries forward.** The bare-GUI-PATH bug (fixed in `enriched_path()`)
  applies to the sidecar too — it spawns the claude runtime + MCP servers + hooks. Set the
  enriched PATH on the sidecar process AND pass it into the SDK `query()` env option.

## Architecture target

```
                         ┌───────────────── frontend (React) ─────────────────┐
                         │  ChatPane (thin shell: layout + composer)           │
                         │    ├─ useClaudeController ─┐                        │
                         │    ├─ useCodexController  ─┤ each owns its own       │
                         │    └─ useWebController    ─┘ run state + lifecycle   │
                         │  shared (pure): chatStream reducer, bubbles,        │
                         │                 markdown, tool cards, transcript    │
                         └───────────────┬─────────────────────────────────────┘
                                         │ Tauri Channel<String> (claude wire shape)
                         ┌───────────────┴───────────── rust (chat.rs) ────────┐
                         │  ChatSession + sink + replay buffer (aios-chat-core) │
                         │    ├─ claude  → start_claude_agent_sidecar  (NEW)    │
                         │    │             JSON-RPC ↔ node Agent SDK wrapper   │
                         │    │             adapt_claude_agent_frame → wire     │
                         │    └─ codex   → start_codex_appserver (unchanged)    │
                         └───────────────┬─────────────────────────────────────┘
                                         │ stdio JSON-RPC
                         ┌───────────────┴── node sidecar (NEW) ───────────────┐
                         │  @anthropic-ai/claude-agent-sdk  query()            │
                         │    streaming-input session: turns, steer, interrupt │
                         │    options: cwd, model, permissionMode, effort,     │
                         │             env (enriched PATH), mcp, resume         │
                         │  auth: subscription (ANTHROPIC_API_KEY unset)       │
                         └─────────────────────────────────────────────────────┘
```

## Phases

### Phase 0 — stabilize (DONE, shipped 2026-06-20)
- Frontend over-prune fix: `aios_resume_pruned` is sole pruning authority.
- `enriched_path()` on the claude spawn (fixes bare-GUI-PATH MCP/hook deadlock).
- Clean rebuild + correct install verified, single instance.

### Phase 1 — claude Agent SDK sidecar (behind a flag, parallel to `-p`)
**Verify-first (blocking unknowns):**
1. Agent SDK supports a **persistent streaming-input session** with mid-turn
   **interrupt** and **steer** (TS `query()` with async-iterable prompt + `interrupt()`;
   Python `ClaudeSDKClient`). The shell needs real-time steer + stop — confirm before building.
2. SDK message stream → confirm it carries: `system/init` (session id), `assistant`
   (text + tool_use blocks), `user` (tool_result), `result` (usage/cost/duration). Map
   each to the existing wire shape the reducer expects.
3. `--resume`/session-fork semantics through the SDK (does it expose the resumed session id
   the way the `-p` path's `system.session_id` does, for re-keying history?).

**Build:**
- New sidecar package `sidecars/claude-agent/` (TS): a thin stdio JSON-RPC wrapper around
  `query()`. Methods: `start(opts)`, `send(text, images)`, `steer(text)`, `interrupt()`,
  `stop()`. Emits frames: one per SDK message.
- Vendor it like codex: bundle node + the package with the app
  (precedent: `~/.codex-chat/packages/standalone/current/codex app-server`). Resolve the
  node binary via the existing `resolve_bin`/nvm logic; set enriched PATH.
- Rust: `start_claude_agent_sidecar()` mirroring `start_codex_appserver()` —
  spawn, JSON-RPC reader thread, `adapt_claude_agent_frame(sess, line) → Vec<wire lines>`.
  Reuse `ChatSession`, `fan_out`, `ChannelSink`, replay buffer untouched.
- Gate behind `AIOS_CLAUDE_AGENT_SDK=1` (or a cockpit toggle). Default OFF; `-p` stays the
  default path so nothing regresses while we validate parity.

**Exit criteria:** with the flag on, a fresh claude chat streams a reply, steer + stop work,
resume repaints history, usage ticks — at parity with `-p`, on the subscription.

### Phase 2 — frontend per-engine controllers (refactor, no behavior change)
- Extract the shared state machine out of the `ChatPane` monolith into per-engine hooks:
  `useClaudeController`, `useCodexController`, `useWebController`. Each owns its own
  `streaming`/`backendBusy`/`activeRun`/`resumeId`/spawn-effect — **no cross-engine shared
  run state** (this is what kills the wedge class).
- `ChatPane` becomes a thin shell: layout, composer, transcript render, and it mounts the
  controller for the active engine.
- Shared (unchanged, pure): `chatStream.ts` reducer, `chat/ChatMarkdown`,
  `chat/ApprovalCards`, `chat/toolPresentation`, transcript model.
- Add a guard regardless of engine: a hung turn must be recoverable — `stop` always clears
  `streaming`+`backendBusy` (works today via `finalizeStreaming`, but make it robust when
  `sessionIdRef` is null), and consider a watchdog that surfaces "turn stalled — restart?"
  after N seconds of no events.
- Land behind the existing test suite (`npm run test:chatpane`, 194 tests) + the
  `bundleBoundaries.test.ts` structural assertions; update those assertions to match the
  new controller boundaries.

**Phase 2 UI changes (Firaz, 2026-06-20):**
- **Clear transcript on model switch.** Switching engine (claude↔codex↔web) — and, per
  Firaz, switching model within an engine — must **clear the transcript + run-events and
  start a fresh session**, the way `/clear` does (`clearSession`), instead of repainting
  the prior conversation under a new backend (today's confusing behavior). Wire this into
  each controller's model-change path so the spawn restart and the transcript reset happen
  together. Keep a visible affordance (a "switched to <model> — fresh chat" result line)
  so the clear isn't silent. Edge case to settle: a deliberate "continue this convo on a
  different model" gesture — default per Firaz is clear-on-switch; if we want
  continue-without-clear later, make it an explicit action, not the default.
- **Per-model SVG icons.** Add brand/logo SVGs per model (Claude/Anthropic, codex/OpenAI,
  etc.) in the model picker and on assistant bubbles / the pane header, so the active
  engine reads at a glance. Inline the SVGs (CSP + offline — no remote fetch), keep them in
  a new `chat/modelIcons.tsx` mapping model id/engine → icon. Pair each icon with the
  existing label; don't replace text with icon-only. Tie the icon to the same
  `CHAT_MODELS` entry that drives the picker so adding a model adds its icon in one place.

### Phase 3 — cut claude over to the sidecar by default
- Flip default to the Agent SDK path; keep `-p` reachable via flag as a fallback for one
  release.
- Update the resume/transcript reader: SDK sessions still write `~/.claude/projects/*.jsonl`
  (same store) so `read_chat_transcript` / `find_claude_transcript_in_home` keep working —
  verify, don't assume.

### Phase 4 — hardening
- Sidecar supervision: crash → auto-restart, surface `aios_stderr` on failure, never leave a
  pane stuck "Working" (synthesize an error `result`, same as the `-p` reader's EOF path).
- Version-pin the bundled SDK + node; document the vendoring/update path.
- Telemetry: log sidecar spawn/exit to the diag log.

## Asset system (premium-minimalist) — Firaz, 2026-06-20

Ships alongside Phase 2 (presentation is already being touched). Through-line:
**monochrome + one accent, one 1.5px stroke weight, inline SVG (CSP/offline-safe),
whitespace over ornament, motion only to communicate state.** Ranked by leverage:

1. **Empty / idle states (highest leverage).** Every pane's blank screen → faint line-art
   AIOS glyph + one calm line of copy. Covers chat, files, terminal, browser, history,
   mission, loops, tickets. Biggest premium lever — blank screens are where it reads cheap.
2. **One coherent icon system.** Single stroke, monochrome, `currentColor`, one accent on
   active. Unify: sidebar rail, tool-call cards (bash/read/edit/grep/web/glob/write),
   composer actions. New `chat/modelIcons.tsx` extends to a broader `ui/icons.tsx` set.
3. **Model/engine glyphs.** Monochrome marks tinted with the accent — NOT full-color brand
   logos (full-color reads "integration"; monochrome reads "premium native"). Picker +
   bubbles + header, keyed off `CHAT_MODELS`.
4. **Agent-state indicator.** Replace plain "Working… m:ss" with a breathing dot / thin
   arc; distinct restrained states for thinking vs tool-running vs streaming.
5. **AIOS identity mark.** Refined monogram → app/dock/favicon/window chrome; faint
   watermark on idle screens (replaces busy backdrop with calm brand texture).
6. Usage meters: thin rounded bars, accent only on fill, muted track.
7. Copy/confirm micro-states (checkmark morph), send-button state transitions.
8. Identity avatars: consistent ring + monochrome initial fallback.
9. ~2% noise/grain on dark surfaces for depth.
10. Hairline dividers + generous pane-header padding.

Load the `artifact-design` skill's taste guidance when building these; keep all SVG inline.

## Risks / open questions
- **Sidecar = new supervised process.** Crash handling, restart, version pinning — real
  surface area. Mitigated by reusing the codex app-server's proven supervision shape.
- **Bundling node + SDK** into the signed Tauri app (size, notarization). Codex precedent
  exists; follow it.
- **Steer/interrupt fidelity.** If the Agent SDK can't interrupt mid-turn as cleanly as
  stdin-inject does, the steer UX regresses — this is the #1 verify-first item.
- **Extra hop latency.** rust → node sidecar → claude runtime vs rust → claude directly.
  Likely negligible (codex already does this) but measure.
- **Not a capability win, an ergonomics win.** The SDK gives typed events + programmatic
  option control; it does NOT change auth (already sub) or wire shape (already stream-json)
  or fix PATH (already fixed). Worth it for the clean controller boundary + option control,
  not for raw capability.

## Sequencing note
Phases 1 and 2 are independent and can run in parallel worktrees (1 = backend sidecar,
2 = frontend controller split). Phase 3 depends on both. Do Phase 1's verify-first items
BEFORE committing build effort — if the SDK can't do persistent-session steer/interrupt,
revisit (fall back to keeping rust `-p` for claude and doing only the Phase 2 controller
split, which already kills the wedge class).
