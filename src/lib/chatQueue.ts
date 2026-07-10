import type { QueuedMessage } from "./chatPaneState.ts";

/** Pending composer work is pane-owned, not backend-session-owned. A session
 * can restart or reattach without silently dropping the user's next requests. */
export const CHAT_QUEUE_STORAGE_PREFIX = "aios.chat.queue:";
const MAX_QUEUE_ITEMS = 50;
const MAX_TEXT_LENGTH = 20_000;
const MAX_IMAGE_PATHS = 12;

export interface DurableChatQueue {
  items: QueuedMessage[];
  selected: number;
}

/** The renderer can only preserve image bytes for the lifetime of its mounted
 * pane. On restart, AIOS paste files are deliberately treated as unavailable
 * rather than silently sending the queued text without its attachment. */
export interface ChatQueueHydration {
  queue: DurableChatQueue | null;
  droppedMessages: number;
  droppedImages: number;
}

export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const keyFor = (paneKey: string) => `${CHAT_QUEUE_STORAGE_PREFIX}${paneKey}`;

function isNonDurablePastePath(path: string): boolean {
  return /(?:^|\/)aios-paste(?:\/|$)/.test(path.replace(/\\/g, "/"));
}

function validItem(value: unknown): value is QueuedMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<QueuedMessage>;
  if (typeof item.id !== "string" || !item.id || typeof item.text !== "string") return false;
  if (item.text.length > MAX_TEXT_LENGTH) return false;
  if (item.images != null && (!Array.isArray(item.images) || item.images.length > MAX_IMAGE_PATHS)) return false;
  return !item.images || item.images.every((path) => typeof path === "string" && path.length > 0);
}

function normalize(value: unknown): DurableChatQueue | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DurableChatQueue>;
  if (!Array.isArray(candidate.items) || candidate.items.length > MAX_QUEUE_ITEMS) return null;
  if (!candidate.items.every(validItem)) return null;
  if (typeof candidate.selected !== "number" || !Number.isInteger(candidate.selected)) return null;
  return {
    items: candidate.items.map((item) => ({
      id: item.id,
      text: item.text.trim(),
      ...(item.images?.length ? { images: [...item.images] } : {}),
    })),
    selected: candidate.items.length === 0 ? 0 : Math.min(Math.max(candidate.selected, 0), candidate.items.length - 1),
  };
}

export function loadChatQueue(storage: Pick<QueueStorage, "getItem">, paneKey?: string): DurableChatQueue | null {
  if (!paneKey) return null;
  try {
    const raw = storage.getItem(keyFor(paneKey));
    return raw ? normalize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * Load a queue for a new renderer instance without pretending a previous
 * instance's in-memory paste-image pins survived the restart. Any message
 * depending on one is withheld in full, so its text can never run without the
 * image the user queued it with. Ordinary user-selected paths remain intact.
 */
export function hydrateChatQueue(
  storage: Pick<QueueStorage, "getItem">,
  paneKey?: string,
): ChatQueueHydration {
  const queue = loadChatQueue(storage, paneKey);
  if (!queue) return { queue: null, droppedMessages: 0, droppedImages: 0 };

  let droppedMessages = 0;
  let droppedImages = 0;
  const items = queue.items.filter((item) => {
    const temporaryImageCount = item.images?.filter(isNonDurablePastePath).length ?? 0;
    if (temporaryImageCount === 0) return true;
    droppedMessages += 1;
    droppedImages += temporaryImageCount;
    return false;
  });

  return {
    queue: {
      items,
      selected: items.length === 0 ? 0 : Math.min(queue.selected, items.length - 1),
    },
    droppedMessages,
    droppedImages,
  };
}

export function saveChatQueue(
  storage: Pick<QueueStorage, "setItem" | "removeItem">,
  paneKey: string | undefined,
  queue: DurableChatQueue,
): void {
  if (!paneKey) return;
  const normalized = normalize(queue);
  if (!normalized || normalized.items.length === 0) {
    try {
      storage.removeItem(keyFor(paneKey));
    } catch {
      // A blocked storage backend must not make composing or stopping a run fail.
    }
    return;
  }
  try {
    storage.setItem(keyFor(paneKey), JSON.stringify(normalized));
  } catch {
    // Quota protection handles browsers; an unavailable storage backend should
    // never make composing or stopping a run fail.
  }
}

export function clearChatQueue(
  storage: Pick<QueueStorage, "removeItem">,
  paneKey?: string,
): void {
  if (!paneKey) return;
  try {
    storage.removeItem(keyFor(paneKey));
  } catch {
    // no-op: the in-memory queue remains authoritative for this mounted pane.
  }
}
