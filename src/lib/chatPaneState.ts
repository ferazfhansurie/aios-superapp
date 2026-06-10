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

export type ComposerSendMode = "send" | "steer" | "queue" | "waiting";
export type ChatStopStrategy = "interrupt" | "kill-and-restart";
export type ContextBudgetMode = "lean" | "agent" | "ultracode";

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
 * The effort label to SHOW for the given engine. Codex's `ReasoningEffort` enum
 * tops out at `xhigh` — the backend (chat.rs codex_effort) silently folds
 * `max`/`ultracode` → `xhigh`. Showing the raw picker label would lie ("max"
 * when codex actually runs xhigh), so for codex we surface the effective cap as
 * `xhigh (max)` / `xhigh (ultracode)`. Claude accepts these tiers natively, so
 * it keeps its real label unchanged. Keep the source-of-truth fold here in sync
 * with codex_effort in chat.rs.
 */
export function effortChipLabel(
  effortId: string,
  effortLabel: string,
  engine: string,
): string {
  if (engine !== "codex") return effortLabel;
  if (effortId === "max" || effortId === "ultracode") {
    return `xhigh (${effortLabel})`;
  }
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
