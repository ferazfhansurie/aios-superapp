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

let queueSeq = 0;

const clampPct = (pct: number): number => Math.min(Math.max(pct, 0), 100);
const clipTitle = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max).trimEnd() : text;

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
