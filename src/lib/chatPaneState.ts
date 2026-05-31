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
  queuedCount: number;
  imageCount: number;
  planMode: boolean;
  hasGoal: boolean;
}

export interface ComposerContextChip {
  id: string;
  label: string;
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

/** Compact chips shown above the composer, ordered by operational importance. */
export function composerContextChips(input: ComposerContextInput): ComposerContextChip[] {
  const chips: ComposerContextChip[] = [];
  if (input.cwd) chips.push({ id: "cwd", label: basename(input.cwd) });
  chips.push({ id: "engine", label: input.engine });
  chips.push({ id: "model", label: input.modelLabel });
  chips.push({ id: "effort", label: input.effortLabel });
  chips.push({ id: "permission", label: input.permissionLabel });
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
