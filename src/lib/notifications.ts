const STORAGE_KEY = "aios.notifications";
const MAX_NOTIFICATIONS = 200;

export type NotificationLevel = "info" | "success" | "warning" | "error";
export type NotificationSource = "system" | "pane" | "chat" | "browser" | "monitor";

export interface AiosNotificationAction {
  id: string;
  label: string;
}

export interface AiosNotification {
  id: string;
  source: NotificationSource;
  sourceId?: string;
  sourceLabel?: string;
  level: NotificationLevel;
  title: string;
  body?: string;
  actions?: AiosNotificationAction[];
  read: boolean;
  at: number;
}

export type NotificationInput = Omit<AiosNotification, "id" | "read" | "at" | "level"> & {
  level?: NotificationLevel;
  read?: boolean;
};

type Listener = (items: AiosNotification[]) => void;

const listeners = new Set<Listener>();
let cache: AiosNotification[] | null = null;
let seq = 0;

function nowId(now: number): string {
  seq += 1;
  return `n-${now.toString(36)}-${seq.toString(36)}`;
}

function sanitize(items: unknown): AiosNotification[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter(
      (item): item is Partial<AiosNotification> & { title: string; source: string } =>
        item != null &&
        typeof item === "object" &&
        typeof (item as Partial<AiosNotification>).title === "string" &&
        typeof (item as Partial<AiosNotification>).source === "string",
    )
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : nowId(Date.now()),
      source: item.source as NotificationSource,
      sourceId: typeof item.sourceId === "string" ? item.sourceId : undefined,
      sourceLabel: typeof item.sourceLabel === "string" ? item.sourceLabel : undefined,
      level: (item.level as NotificationLevel | undefined) ?? "info",
      title: item.title,
      body: typeof item.body === "string" ? item.body : undefined,
      actions: Array.isArray(item.actions) ? item.actions.filter(isAction) : undefined,
      read: item.read === true,
      at: typeof item.at === "number" ? item.at : Date.now(),
    }))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_NOTIFICATIONS);
}

function isAction(value: unknown): value is AiosNotificationAction {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as AiosNotificationAction).id === "string" &&
    typeof (value as AiosNotificationAction).label === "string"
  );
}

function persist(items: AiosNotification[]): void {
  cache = items.slice(0, MAX_NOTIFICATIONS);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* keep in-memory cache */
  }
  listeners.forEach((fn) => fn(cache ?? []));
}

export function listNotifications(): AiosNotification[] {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    cache = [];
  }
  return cache;
}

export function unreadNotificationCount(): number {
  return listNotifications().filter((item) => !item.read).length;
}

export function pushNotification(
  input: NotificationInput,
  opts: { now?: number } = {},
): AiosNotification {
  const at = opts.now ?? Date.now();
  const item: AiosNotification = {
    ...input,
    id: nowId(at),
    level: input.level ?? "info",
    read: input.read ?? false,
    at,
  };
  persist([item, ...listNotifications()].sort((a, b) => b.at - a.at));
  return item;
}

export function emitPaneNotification(
  input: {
    paneId: string;
    paneLabel?: string;
    title: string;
    body?: string;
    level?: NotificationLevel;
    actions?: AiosNotificationAction[];
  },
  opts: { now?: number } = {},
): AiosNotification {
  return pushNotification(
    {
      source: "pane",
      sourceId: input.paneId,
      sourceLabel: input.paneLabel,
      title: input.title,
      body: input.body,
      level: input.level,
      actions: input.actions,
    },
    opts,
  );
}

export function markNotificationRead(id: string): void {
  persist(listNotifications().map((item) => (item.id === id ? { ...item, read: true } : item)));
}

export function markAllNotificationsRead(): void {
  persist(listNotifications().map((item) => ({ ...item, read: true })));
}

export function clearNotification(id: string): void {
  persist(listNotifications().filter((item) => item.id !== id));
}

export function clearAllNotifications(): void {
  persist([]);
}

export function subscribeNotifications(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
