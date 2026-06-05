export interface QueuedMessage {
  id: string;
  text: string;
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

let queueSeq = 0;

const clampPct = (pct: number): number => Math.min(Math.max(pct, 0), 100);
const clipTitle = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max).trimEnd() : text;
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

/** Append one non-empty pending steer message and highlight the new row. */
export function queueMessage(items: QueuedMessage[], raw: string): QueueState {
  const text = raw.trim();
  if (!text) return { items, selected: Math.max(0, items.length - 1) };
  const next = [...items, { id: `q${++queueSeq}`, text }];
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
    if (input.engine === "codex") {
      return {
        mode: "steer",
        label: "steer",
        title: "inject into the running codex turn",
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

/** Compact chips shown above the composer, ordered by operational importance. */
export function composerContextChips(input: ComposerContextInput): ComposerContextChip[] {
  const chips: ComposerContextChip[] = [];
  if (input.cwd) chips.push({ id: "cwd", label: basename(input.cwd) });
  chips.push({ id: "engine", label: input.engine });
  chips.push({ id: "model", label: input.modelLabel });
  chips.push({ id: "effort", label: input.effortLabel });
  chips.push({ id: "permission", label: input.permissionLabel });
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
