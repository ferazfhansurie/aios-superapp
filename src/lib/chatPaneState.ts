export interface QueuedMessage {
  id: string;
  text: string;
  /** Temp-file paths of images attached when the message was queued — they
   *  ride the queue entry (not composer state) so a queued image can't be
   *  dropped or stolen by a later draft. */
  images?: string[];
}

export interface QueueState {
  items: QueuedMessage[];
  selected: number;
}

export interface UsageStack {
  baseline: number;
  session: number;
  total: number;
}

export interface ResumeTitle {
  title: string;
  meaningful: boolean;
}

export function shouldApplyResumeProp(
  resumeId: string | null | undefined,
  ownSessionIds: ReadonlySet<string>,
): boolean {
  const clean = resumeId?.trim();
  return Boolean(clean && !ownSessionIds.has(clean));
}

export type ComposerSendMode = "send" | "steer" | "queue" | "waiting";
export type ChatStopStrategy = "interrupt" | "kill-and-restart";
export type ContextBudgetMode = "lean" | "agent" | "ultracode";

/** Keep background panes responsive without asking React to repaint every
 * streamed token. Structural events still bypass this delay and flush at once. */
export function chatStreamFlushDelay(hidden: boolean): number | null {
  return hidden ? 240 : null;
}

// ── wire-message assembly ────────────────────────────────────────────────────
// `display` is what the user typed (and what the transcript shows). `wire` is
// what the engine actually receives — display plus any AIOS-only mode prefixes
// (plan / goal / agent / ultracode). These prefixes are UX state, NOT part of
// the user's message, so they must never leak into a place that treats the
// first user turn as durable identity.
//
// CODEX titles each thread from its FIRST user message and shares ~/.codex with
// the real Codex desktop app. If we staple a mode banner onto that turn, every
// AIOS-originated codex thread shows up titled "Agent mode is ON…" and codex is
// pushed into a fake "external orchestrator / execution bridge" mental model
// (it has no subagent tooling to fan out to). So codex receives the typed text
// VERBATIM — zero AIOS prefixes. See ChatPane dispatch.
const PLAN_PREFIX =
  "Plan first: lay out a concise step-by-step plan and wait for my go-ahead before writing any code or running mutating commands.\n\n";
const GOAL_PREFIX = (goal: string) =>
  `Ongoing goal (keep pursuing this across turns until I say it's done): ${goal}\n\n`;
// Agent/ultra prefixes are CAPABILITY-aware, not engine-labelled. Only an engine
// that actually exposes native fan-out tooling gets a "fan out to subagents"
// directive — telling an engine to orchestrate subagents it doesn't have makes
// it invent an external orchestrator / "execution bridge" and stall waiting on
// infra that doesn't exist (the codex chat-pane hallucinated-bridge bug). In the
// chat pane only claude ships the Task tool; opencode/spark have direct file +
// shell tools but no subagent spawn, so they're told to DO THE WORK inline.
const AGENT_PREFIX_ORCHESTRATE =
  "Agent mode is ON. For any task with 2+ independent tracks, fan out with the native Agent tool using only the `aios-worker` subagent type. Keep each worker's purpose specific so the chatpane can show what it's doing. Workers execute their bounded task directly and must not delegate further.\n\n";
const AGENT_PREFIX_DIRECT =
  "Agent mode is ON. You have direct file-edit and shell tools — use them to do the work yourself in THIS session. There is no external orchestrator, task queue, or execution bridge to hand work to; do not wait for one. For a task with independent parts, sequence them yourself. Only open a visible `aios-agent` worker pane if Firaz explicitly asks.\n\n";
// ultracode = xhigh effort + workflows. Headless `claude -p` has no ultracode
// flag, so we run xhigh and replicate the "workflows" half with this directive:
// orchestrate, fan out, verify — be maximally thorough.
const ULTRA_PREFIX_ORCHESTRATE =
  "Ultracode mode is ON. Maximize thoroughness and correctness — token cost is not a constraint. For any substantial task, decompose it and fan out parallel `aios-worker` subagents via your native Agent tool, then adversarially verify findings before concluding. Workers execute their bounded task directly and must not delegate further. Prefer one orchestration layer over a single pass; only handle trivially small tasks inline.\n\n";
const ULTRA_PREFIX_DIRECT =
  "Ultracode mode is ON. Maximize thoroughness and correctness — token cost is not a constraint. You have direct file-edit and shell tools; do the work yourself in THIS session — there is no external orchestrator or execution bridge to fan out to. Sequence independent parts yourself, then re-check your work adversarially before concluding.\n\n";

// True only for engines that expose native subagent/fan-out tooling in the chat
// pane. Flip an engine here the day it gains a real subagent tool — the prefixes
// key off this, so gating stays capability-driven, not a scattered engine check.
export function engineHasNativeSubagents(engine: string): boolean {
  return engine === "claude";
}

/** The per-turn "mode" prefix AIOS staples onto agent / ultracode budgets.
 *  Returns "" when no mode prefix applies. CODEX always gets "" — its first
 *  user turn becomes the thread title and it has no fan-out tooling, so it must
 *  receive the typed text clean (no banner, no execution-bridge framing). */
export function modePrefixFor(
  engine: string,
  effectiveBudget: ContextBudgetMode,
): string {
  if (engine === "codex") return "";
  if (effectiveBudget === "ultracode") {
    return engineHasNativeSubagents(engine) ? ULTRA_PREFIX_ORCHESTRATE : ULTRA_PREFIX_DIRECT;
  }
  if (effectiveBudget === "agent") {
    return engineHasNativeSubagents(engine) ? AGENT_PREFIX_ORCHESTRATE : AGENT_PREFIX_DIRECT;
  }
  return "";
}

/** Assemble the exact string an engine receives for a turn. Order (outermost
 *  first): mode prefix (agent/ultracode) → plan → goal → per-call wirePrefix →
 *  the user's typed text. For CODEX every AIOS prefix is dropped, so the wire
 *  equals the typed text verbatim (thread titles stay clean). */
export function composeWireMessage(input: {
  display: string;
  engine: string;
  effectiveBudget: ContextBudgetMode;
  goal?: string;
  planMode?: boolean;
  wirePrefix?: string;
}): string {
  const { display, engine, effectiveBudget } = input;
  // Codex must get the typed message untouched — no plan/goal/agent framing AND
  // no injected AIOS preambles (e.g. the "Relevant AIOS memory context:" block
  // that rides `wirePrefix`) in the thread text. Codex titles the thread from
  // this exact string, so it is the DISPLAY text verbatim. Every other engine
  // keeps the wirePrefix + full mode-prefix stack.
  if (engine === "codex") return display;
  let wire = (input.wirePrefix ?? "") + display;
  const goal = input.goal?.trim();
  if (goal) wire = GOAL_PREFIX(goal) + wire;
  if (input.planMode) wire = PLAN_PREFIX + wire;
  const mode = modePrefixFor(engine, effectiveBudget);
  if (mode) wire = mode + wire;
  return wire;
}

export interface ModelEffortProfile {
  supportedEfforts?: readonly string[];
  defaultEffort?: string;
}

/** Resolve a model switch deterministically: its saved tier wins, then the
 *  current tier, then its advertised default, then the first supported tier. */
export function resolveModelEffort(
  model: ModelEffortProfile,
  currentEffort?: string | null,
  savedEffort?: string | null,
): string {
  const supported = model.supportedEfforts?.length
    ? model.supportedEfforts
    : ["low", "medium", "high", "xhigh", "max", "ultra"];
  if (savedEffort && supported.includes(savedEffort)) return savedEffort;
  if (currentEffort && supported.includes(currentEffort)) return currentEffort;
  if (model.defaultEffort && supported.includes(model.defaultEffort)) return model.defaultEffort;
  return supported[0] ?? "medium";
}

/** Nearest discrete stop for a normalized pointer position. */
export function nearestEffortIndex(progress: number, count: number): number {
  if (count <= 1) return 0;
  const clamped = Math.min(Math.max(progress, 0), 1);
  return Math.round(clamped * (count - 1));
}

/** Keyboard semantics shared by the slider component and unit tests. */
export function moveEffortIndex(index: number, key: string, count: number): number {
  const last = Math.max(0, count - 1);
  if (key === "Home") return 0;
  if (key === "End") return last;
  if (key === "ArrowRight" || key === "ArrowUp") return Math.min(last, index + 1);
  if (key === "ArrowLeft" || key === "ArrowDown") return Math.max(0, index - 1);
  return Math.min(Math.max(index, 0), last);
}

export interface ComposerSendContractInput {
  streaming: boolean;
  hasDraft: boolean;
  hasImages: boolean;
  engine: string;
  started: boolean;
}

export interface ComposerSendContract {
  mode: ComposerSendMode;
  label: string;
  title: string;
  disabled: boolean;
}

export interface ComposerContextInput {
  cwd?: string | null;
  modelLabel: string;
  effortLabel: string;
  permissionLabel: string;
  engine: string;
  contextBudget: ContextBudgetMode;
  queuedCount: number;
  imageCount: number;
  planMode: boolean;
  hasGoal: boolean;
}

export interface ComposerContextChip {
  id: string;
  label: string;
}

export interface ContextLedgerInput {
  draft: string;
  goal: string;
  planMode: boolean;
  memoryCount: number;
  imageCount: number;
  queuedCount: number;
  contextBudget: ContextBudgetMode;
}

export interface ContextLedgerBucket {
  id: string;
  label: string;
  tokens: number;
  level: "quiet" | "normal" | "warning";
}

export interface ChatContextMemory {
  title: string;
  type: string;
  description?: string;
  preview?: string;
  reasons?: string[];
  path?: string;
  vault?: string;
  score?: number;
}

export interface ChatContextTurn {
  kind: "user" | "assistant" | "result";
  text: string;
}

export interface ChatWorkspacePane {
  key: string;
  label: string;
  type: string;
  detail?: string;
  active?: boolean;
}

export interface ChatWorkspaceProject {
  name: string;
  root: string;
  kind?: string;
}

export interface ChatWorkspaceContext {
  activePane?: ChatWorkspacePane | null;
  openPanes?: ChatWorkspacePane[];
  projects?: ChatWorkspaceProject[];
}

export interface ChatContextCapsuleInput {
  cwd?: string | null;
  engine: string;
  modelLabel: string;
  contextBudget: ContextBudgetMode;
  userText: string;
  memories?: ChatContextMemory[];
  attachedMemoryCount?: number;
  recentTurns?: ChatContextTurn[];
  workspace?: ChatWorkspaceContext | null;
  runPhase?: string | null;
  /** Live mission-control board so the chatpane AI always knows firaz's active
   *  mission, each agent's status, and open tasks. Rides the bounded capsule —
   *  NOT a per-turn preamble. Omitted when there's nothing meaningful to show. */
  missionBoard?: {
    mission: string;
    agents: Array<{ label: string; status: string }>;
    openTasks: string[];
  } | null;
}

let queueSeq = 0;

const clampPct = (pct: number): number => Math.min(Math.max(pct, 0), 100);
const clipTitle = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max).trimEnd() : text;
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number): string => {
  const flat = oneLine(text);
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…` : flat;
};
const basename = (path: string): string => {
  const clean = path.replace(/\/+$/, "");
  return clean.split(/[\\/]/).filter(Boolean).pop() ?? path;
};

/** Keep Codex resume labels provisional until the first real instruction lands. */
export function resumeTitle(raw: string, engine: string): ResumeTitle {
  const flattened = raw.trim().replace(/\s+/g, " ");
  if (engine !== "codex") {
    return { title: clipTitle(flattened, 120), meaningful: Boolean(flattened) };
  }

  if (
    !flattened ||
    /^(?:hi|hello|hey|yo|sup|ok|okay|okie|thanks|thank you|test|testing|u there|you there)[.!?, ]*$/i.test(
      flattened,
    )
  ) {
    return { title: "new codex chat", meaningful: false };
  }

  const title = flattened
    .replace(/^(?:hi|hello|hey|yo)[.!?, ]+/i, "")
    .replace(/^(?:(?:can|could|would|will)\s+you\s+)(?:please\s+)?/i, "")
    .replace(/^please\s+/i, "")
    .replace(/^help\s+me\s+/i, "")
    .replace(/^i\s+(?:want|need)\s+(?:you\s+)?to\s+/i, "")
    .replace(/[.!?]+$/, "")
    .trim();

  if (!title) return { title: "new codex chat", meaningful: false };
  return { title: clipTitle(title, 72), meaningful: true };
}

/** Split the current account usage into pre-chat baseline + this-chat growth. */
export function usageStack(current: number, initial: number): UsageStack {
  const total = clampPct(current);
  const baseline = Math.min(total, clampPct(initial));
  return { baseline, session: total - baseline, total };
}

/** Append one pending steer message and highlight the new row. Empty text is
 *  allowed when images ride along (image-only queue entry). */
export function queueMessage(
  items: QueuedMessage[],
  raw: string,
  images?: string[],
): QueueState {
  const text = raw.trim();
  if (!text && !images?.length) {
    return { items, selected: Math.max(0, items.length - 1) };
  }
  const next = [
    ...items,
    { id: `q${++queueSeq}`, text, ...(images?.length ? { images } : {}) },
  ];
  return { items: next, selected: next.length - 1 };
}

/** Move the highlighted pending row with slash-menu-style wrapping. */
export function cycleQueueSelection(
  selected: number,
  length: number,
  delta: number,
): number {
  if (length === 0) return 0;
  return (selected + delta + length) % length;
}

/** Remove a pending row while keeping the nearest remaining row highlighted. */
export function removeQueuedMessage(
  state: QueueState,
  id: string,
): QueueState {
  const items = state.items.filter((item) => item.id !== id);
  return {
    items,
    selected: items.length === 0 ? 0 : Math.min(state.selected, items.length - 1),
  };
}

/** Edit one queued follow-up. Blank edits remove the row. */
export function updateQueuedMessage(
  state: QueueState,
  id: string,
  raw: string,
): QueueState {
  const text = raw.trim();
  if (!text) return removeQueuedMessage(state, id);
  const items = state.items.map((item) =>
    item.id === id ? { ...item, text } : item,
  );
  return {
    items,
    selected: Math.min(state.selected, Math.max(0, items.length - 1)),
  };
}

/** Move one queued follow-up up/down by one row. */
export function moveQueuedMessage(
  state: QueueState,
  id: string,
  delta: number,
): QueueState {
  const from = state.items.findIndex((item) => item.id === id);
  if (from < 0 || state.items.length < 2 || delta === 0) return state;
  const to = Math.min(Math.max(from + delta, 0), state.items.length - 1);
  if (to === from) return { ...state, selected: from };
  const items = [...state.items];
  const [item] = items.splice(from, 1);
  items.splice(to, 0, item);
  return { items, selected: to };
}

/** Single source for what the primary composer action means right now. */
export function sendContract(input: ComposerSendContractInput): ComposerSendContract {
  const hasPayload = input.hasDraft || input.hasImages;
  if (!input.started) {
    return {
      mode: "waiting",
      label: "starting",
      title: "chat session is still starting",
      disabled: true,
    };
  }
  if (input.streaming) {
    if (!hasPayload) {
      return {
        mode: "waiting",
        label: "running",
        title: "type a follow-up to queue or steer",
        disabled: true,
      };
    }
    // claude steers mid-turn over stdin (images ride as content blocks, so
    // attachments steer too); codex steers via turn/steer (text-only — an
    // image-carrying draft queues instead). opencode has no live process to
    // steer → queue.
    const steers =
      input.engine === "claude" ||
      (input.engine === "codex" && !input.hasImages);
    if (steers) {
      return {
        mode: "steer",
        label: "steer",
        title: `inject into the running ${input.engine} turn`,
        disabled: false,
      };
    }
    return {
      mode: "queue",
      label: "queue",
      title: "send after the active run finishes",
      disabled: false,
    };
  }
  return {
    mode: "send",
    label: "send",
    title: "send message",
    disabled: !hasPayload,
  };
}

/**
 * Display label for the selected tier. Current codex models advertise their
 * exact effort strings, including max/ultra, so the UI must not down-label them.
 */
export function effortChipLabel(
  effortId: string,
  effortLabel: string,
  engine: string,
): string {
  if (engine === "codex" && effortId === "ultracode") return "ultra";
  return effortLabel;
}

export function stopStrategy(engine: string | null | undefined): ChatStopStrategy {
  // codex now has a real `turn/interrupt` (chat.rs codex_interrupt, wired via
  // chat_interrupt) — stop it like claude: interrupt the turn, keep the
  // persistent app-server + thread + buffered partial answer. Only opencode
  // (no control protocol) still needs a kill-and-restart.
  return engine === "opencode" ? "kill-and-restart" : "interrupt";
}

/** Compact chips shown above the composer, ordered by operational importance.
 *  Engine/model/effort/permission are NOT chips — they have their own
 *  interactive pills in the composer row; repeating them here was noise. */
export function composerContextChips(input: ComposerContextInput): ComposerContextChip[] {
  const chips: ComposerContextChip[] = [];
  if (input.cwd) chips.push({ id: "cwd", label: basename(input.cwd) });
  chips.push({ id: "budget", label: input.contextBudget });
  if (input.imageCount > 0) {
    chips.push({
      id: "attachments",
      label: `${input.imageCount} image${input.imageCount === 1 ? "" : "s"}`,
    });
  }
  if (input.queuedCount > 0) {
    chips.push({
      id: "queue",
      label: `${input.queuedCount} queued`,
    });
  }
  if (input.planMode) chips.push({ id: "plan", label: "plan" });
  if (input.hasGoal) chips.push({ id: "goal", label: "goal" });
  return chips;
}

function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

/** Rough pre-send context ledger. This is a warning system, not billing truth. */
export function contextLedger(input: ContextLedgerInput): ContextLedgerBucket[] {
  const buckets: ContextLedgerBucket[] = [
    {
      id: "budget",
      label: input.contextBudget,
      tokens:
        input.contextBudget === "lean"
          ? 120
          : input.contextBudget === "agent"
            ? 650
            : 1800,
      level: input.contextBudget === "ultracode" ? "warning" : "quiet",
    },
  ];
  const draftTokens = estimateTextTokens(input.draft);
  if (draftTokens > 0) {
    buckets.push({
      id: "draft",
      label: "draft",
      tokens: draftTokens,
      level: draftTokens > 1200 ? "warning" : "normal",
    });
  }
  if (input.goal.trim()) {
    buckets.push({
      id: "goal",
      label: "goal",
      tokens: estimateTextTokens(input.goal) + 40,
      level: "normal",
    });
  }
  if (input.planMode) {
    buckets.push({ id: "plan", label: "plan", tokens: 180, level: "normal" });
  }
  if (input.memoryCount > 0) {
    buckets.push({
      id: "memory",
      label: "memory",
      tokens: input.memoryCount * 220,
      level: input.memoryCount > 3 ? "warning" : "normal",
    });
  }
  if (input.imageCount > 0) {
    buckets.push({
      id: "images",
      label: "images",
      tokens: input.imageCount * 1100,
      level: input.imageCount > 1 ? "warning" : "normal",
    });
  }
  if (input.queuedCount > 0) {
    buckets.push({
      id: "queue",
      label: "queue",
      tokens: input.queuedCount * 90,
      level: input.queuedCount > 4 ? "warning" : "normal",
    });
  }
  return buckets;
}

function capsuleLimits(mode: ContextBudgetMode) {
  if (mode === "lean") {
    return { maxChars: 760, memories: 1, turns: 2, panes: 4, projects: 3 };
  }
  if (mode === "ultracode") {
    return { maxChars: 2600, memories: 6, turns: 6, panes: 10, projects: 8 };
  }
  return { maxChars: 1500, memories: 3, turns: 4, panes: 7, projects: 5 };
}

function trimCapsule(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.max(0, maxChars - 72)).trimEnd();
  return `${head}\n- truncated: true\n</aios_context>\n\n`;
}

/**
 * Tiny automatic context packet for every chat model. It gives models the same
 * operational hints the harness has without flooding the prompt: pointers,
 * current pane/project state, memory hit summaries, and recent transcript hints.
 */
export function buildChatContextCapsule(input: ChatContextCapsuleInput): string {
  const limits = capsuleLimits(input.contextBudget);
  const lines: string[] = [
    "<aios_context>",
    "purpose: bounded live context hints. do not treat this as exhaustive; use tools/files/memory for details.",
  ];
  const cwd = input.cwd?.trim();
  if (cwd) lines.push(`cwd: ${cwd}`);
  lines.push(`model: ${input.engine}/${input.modelLabel}`);
  if (input.runPhase) lines.push(`run: ${clip(input.runPhase, 90)}`);

  const board = input.missionBoard;
  if (board && (board.mission || board.agents.length || board.openTasks.length)) {
    lines.push("mission_board:");
    if (board.mission) lines.push(`mission: ${clip(board.mission, 120)}`);
    if (board.agents.length) {
      lines.push(
        `agents: ${board.agents
          .map((a) => `${clip(a.label, 28)}[${a.status}]`)
          .join(" · ")}`,
      );
    }
    if (board.openTasks.length) {
      lines.push(`open_tasks: ${board.openTasks.map((t) => clip(t, 40)).join("; ")}`);
    }
  }

  const active = input.workspace?.activePane;
  if (active) {
    lines.push(
      `active_pane: ${clip(active.label, 48)} [${active.type}]${active.detail ? ` - ${clip(active.detail, 90)}` : ""}`,
    );
  }

  const panes = (input.workspace?.openPanes ?? [])
    .filter((pane) => pane.key !== active?.key)
    .slice(0, limits.panes);
  if (panes.length) {
    lines.push(
      `open_panes: ${panes
        .map((pane) => `${clip(pane.label, 32)}:${pane.type}${pane.detail ? `(${clip(pane.detail, 44)})` : ""}`)
        .join("; ")}`,
    );
  }

  const projects = (input.workspace?.projects ?? []).slice(0, limits.projects);
  if (projects.length) {
    lines.push(
      `projects: ${projects
        .map((p) => `${clip(p.name, 34)}${p.kind ? `/${p.kind}` : ""}`)
        .join("; ")}`,
    );
  }

  const memories = (input.memories ?? []).slice(0, limits.memories);
  if (memories.length) {
    lines.push("memory_hits:");
    for (const m of memories) {
      const why = m.reasons?.slice(0, 2).join("; ");
      const desc = m.description || m.preview || "";
      lines.push(
        `- ${clip(m.title, 58)} [${m.type}${m.vault ? `/${m.vault}` : ""}] ${clip(desc, 110)}${why ? ` (${clip(why, 90)})` : ""}`,
      );
    }
  }
  if (input.attachedMemoryCount) {
    lines.push(`explicit_memory_attachments: ${input.attachedMemoryCount} full note(s) follow outside this capsule.`);
  }

  const turns = (input.recentTurns ?? [])
    .filter((t) => t.text.trim())
    .slice(-limits.turns);
  if (turns.length) {
    lines.push("recent_thread:");
    for (const t of turns) {
      lines.push(`- ${t.kind}: ${clip(t.text, input.contextBudget === "lean" ? 90 : 150)}`);
    }
  }

  if (input.userText.trim()) {
    lines.push(`user_now: ${clip(input.userText, input.contextBudget === "lean" ? 100 : 180)}`);
  }
  lines.push("</aios_context>", "");
  return trimCapsule(`${lines.join("\n")}\n`, limits.maxChars);
}

// ── model switch ────────────────────────────────────────────────────────────
// Switching the active model (engine or sibling within an engine) must NOT
// repaint the prior conversation under a new backend — that's the confusing
// behavior the engine-split plan calls out. Picking a *different* model clears
// the transcript + run-events and starts a fresh session (like /clear), with a
// visible notice so the reset isn't silent. Re-picking the active model is a
// no-op (no clear, no notice).
export interface ModelSwitchDecision {
  /** clear transcript + run-events and re-spin a fresh session */
  shouldClear: boolean;
  /** one-line result bubble to seed the fresh transcript, or null when no-op */
  notice: string | null;
}

export function describeModelSwitch(
  prevModelId: string,
  next: { id: string; label: string },
): ModelSwitchDecision {
  if (next.id === prevModelId) return { shouldClear: false, notice: null };
  return { shouldClear: true, notice: `switched to ${next.label} — fresh chat` };
}
