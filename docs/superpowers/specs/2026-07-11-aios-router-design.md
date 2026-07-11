# aios virtual model + router — design (2026-07-11)

firaz-approved design. phase 1 shipped same day; phases 2-3 pending.

## economics (why this router is upside-down vs the usual)

- gpt-5.6 is smarter AND cheaper than fable-5 → it wins by default, always.
- the claude max sub is prepaid → claude is the **burn tier**, not the smart
  tier. unused claude quota is waste; the router drains it on work where the
  model gap matters least.
- codex's 5h window is soft (can work past it); the **7d window is the scarce
  resource**. the router watches 7d *pace* (usage % vs % of week elapsed).

## phase 1 — shipped

- `aios` virtual entry pinned at top of `CHAT_MODELS`, default selection
  (settings migration v2), inline svg orbit mark (`AiosMark`).
- resolution is TS-only (`src/lib/aiosRouter.ts`): the pane's `model` state
  always holds a CONCRETE model; rust never sees "aios". `aiosRouted` (reason
  string | null) drives display: composer pill "aios → 5.6 sol", pane header,
  result-line notices with the route reason.
- **role architecture** (`aiosRouterRoles`, firaz 2026-07-11 — replaced the
  flat target/burn pair): main = gpt-5.6-sol (everything by default) · deep =
  fable-5 (judgment, summon-only via "use deep"/"use fable", never auto) ·
  bulk = opus-4.8 (heavy lifting AND the burn tier — draining the claude sub
  through opus burns less quota than fable). route logic: main unless codex 7d
  capped (≥97%) or ahead of pace by `aiosRouterPaceMargin` (15) pct-pts AND
  claude has headroom → bulk. failover both directions. meters unavailable →
  main, never block.
- side panel (TaskSummary) leads with the router view: current route + reason,
  the role map, live codex/claude 5h/7d meters with a pace badge.
- sticky per session: boot resolves sync from cached route + async re-check
  corrects a pristine pane; mid-thread never re-routes.
- in-chat directives: "use fable 5 to check X" / "switch to sol" parsed before
  send (`parseModelDirective`); switches with a compact transcript-tail
  handoff seed (`buildHandoffSeed`) auto-sent when the fresh session is ready.
- settings → model & ai → "aios router": target / burn / pace margin.
- sidebar drag-resize + drag-collapse shipped alongside (App.tsx +
  lib/sidebarWidth.ts, localStorage "aios.sidebarWidth").

## phase 2 — eternal pane, rolling segments (pending)

pane never closes; sessions roll at a context threshold (~150k): outgoing
segment writes a handoff digest (automated runHandoff), fresh session seeded
with it, thread continues. every roll = fresh route decision (solves quota
efficiency without mid-thread context breaks).

## phase 3 — memory system (pending)

four layers: roll digest (working) · full segment transcripts archived +
sqlite-FTS indexed, nothing deleted (episodic) · facts flushed to memory files
(semantic) · pins = always-in-digest verbatim (deliberate). recall =
auto-inject per send (relevance threshold, ~1-2k token cap, deduped vs digest,
labeled as background) + `aios-recall` CLI both engines can shell to (pane
strips MCP, so recall must be CLI-based). firaz chose auto-inject.

## decisions log

- 2026-07-11 firaz: default target = **sol** not terra; auto-inject recall;
  rolls-are-lossy accepted with pin mechanic demoted to complement.
- 2026-07-11 firaz: binary target/burn too flat → role architecture
  (main/deep/bulk); aios logo (orange terminal-folder) as the picker mark;
  side panel = model-architecture view; sidebar drag-resize.
- 2026-07-11 live incident: codex 5h hit a HARD wall ("0% left" + refusal) —
  the 5h window is soft only until overage credits run out. router now treats
  5h ≥99% as a divert signal, and a routed session that receives a usage-limit
  error auto re-resolves → bulk and resends the last message with a handoff.
  manual sessions are never auto-switched.
- 2026-07-11 review fixes: pendingAutoSend stranded on dormant panes (force
  session start after directive switch); burn fallback could leak the virtual
  entry; directive parser tightened to model/role-word tokens only; boot
  re-check guarded against mid-send + eager panes.
