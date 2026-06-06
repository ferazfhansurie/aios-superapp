const STORAGE_KEY = "aios.notifications";
const MAX_NOTIFICATIONS = 200;

export type NotificationLevel = "info" | "success" | "warning" | "error";

/** Taxonomy of what a notification *is* — replaces the vague `source`. Kept open
 *  (string) so call sites can introduce new kinds without a central edit, but the
 *  known set documents intent. */
export type NotificationKind =
  | "chat.done"
  | "chat.needs_input"
  | "chat.crashed"
  | "download.complete"
  | "editor.conflict"
  | "error.pane_crash"
  | "error.tool_failed"
  | "system"
  | (string & {});

/** What to DO when a notification is clicked. The whole point of the rewrite:
 *  every actionable notification carries the opener + its argument, not a bare
 *  pane key that dead-ends once the pane is closed. */
export type NotificationTarget =
  // focus an open pane by key (today's behavior; back-compat for migrated items)
  | { type: "pane"; key: string }
  // reattach (or focus, if still open) a chat by its BACKEND numeric session id.
  // THE killer case: dispatch finds an open pane bound to this id → focusPane;
  // else spawn({ type: "chat", reattach: sessionId }).
  | { type: "chat"; sessionId: number; title?: string }
  // open Settings → Diagnostics (optionally pre-filtered to a source tag)
  | { type: "diagnostics"; filterSource?: string }
  // open a file in-app: "editor" (editable) | "viewer" (preview) | "reveal" (Finder)
  | {
      type: "file";
      path: string;
      name?: string;
      mode?: "editor" | "viewer" | "reveal";
      at?: { line?: number; col?: number };
    }
  // open a terminal pane by key (alias of pane, but semantically a terminal)
  | { type: "terminal"; key: string }
  // open a url in an in-app browser pane
  | { type: "url"; url: string; label?: string };

export interface AiosNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  ts: number;
  read: boolean;
  level: NotificationLevel;
  /** "high" → also fires a transient toast (and, when wired, a native OS notif). */
  priority?: "normal" | "high";
  /** THE deep-link. no target = informational only (rare). */
  target?: NotificationTarget;
  /** display only (e.g. "chat", "browser", "diagnostics"). */
  sourceLabel?: string;
}

export type NotificationInput = Omit<AiosNotification, "id" | "read" | "ts" | "level"> & {
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

function sanitizeTarget(raw: unknown): NotificationTarget | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  switch (t.type) {
    case "pane":
    case "terminal":
      return typeof t.key === "string" ? ({ type: t.type, key: t.key } as NotificationTarget) : undefined;
    case "chat":
      return typeof t.sessionId === "number"
        ? { type: "chat", sessionId: t.sessionId, title: typeof t.title === "string" ? t.title : undefined }
        : undefined;
    case "diagnostics":
      return {
        type: "diagnostics",
        filterSource: typeof t.filterSource === "string" ? t.filterSource : undefined,
      };
    case "file":
      return typeof t.path === "string"
        ? {
            type: "file",
            path: t.path,
            name: typeof t.name === "string" ? t.name : undefined,
            mode:
              t.mode === "editor" || t.mode === "viewer" || t.mode === "reveal"
                ? t.mode
                : undefined,
            at: t.at && typeof t.at === "object" ? (t.at as { line?: number; col?: number }) : undefined,
          }
        : undefined;
    case "url":
      return typeof t.url === "string"
        ? { type: "url", url: t.url, label: typeof t.label === "string" ? t.label : undefined }
        : undefined;
    default:
      return undefined;
  }
}

function sanitize(items: unknown): AiosNotification[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter(
      (item): item is Partial<AiosNotification> & { title: string } & Record<string, unknown> =>
        item != null && typeof item === "object" && typeof (item as { title?: unknown }).title === "string",
    )
    .map((raw) => {
      const item = raw as Partial<AiosNotification> & Record<string, unknown>;
      // back-compat: old persisted items used `at` and `sourceId`(pane key)/`source`.
      const ts =
        typeof item.ts === "number"
          ? item.ts
          : typeof item.at === "number"
            ? (item.at as number)
            : Date.now();
      let target = sanitizeTarget(item.target);
      if (!target && typeof item.sourceId === "string") {
        // migrate the legacy bare pane key into a pane target.
        target = { type: "pane", key: item.sourceId as string };
      }
      const kind: NotificationKind =
        typeof item.kind === "string"
          ? (item.kind as NotificationKind)
          : typeof item.source === "string"
            ? (item.source as NotificationKind)
            : "system";
      return {
        id: typeof item.id === "string" ? item.id : nowId(Date.now()),
        kind,
        title: item.title as string,
        body: typeof item.body === "string" ? item.body : undefined,
        ts,
        read: item.read === true,
        level: (item.level as NotificationLevel | undefined) ?? "info",
        priority: item.priority === "high" ? "high" : item.priority === "normal" ? "normal" : undefined,
        target,
        sourceLabel:
          typeof item.sourceLabel === "string"
            ? item.sourceLabel
            : typeof item.source === "string"
              ? (item.source as string)
              : undefined,
      } satisfies AiosNotification;
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_NOTIFICATIONS);
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
  const ts = opts.now ?? Date.now();
  const item: AiosNotification = {
    ...input,
    id: nowId(ts),
    level: input.level ?? "info",
    read: input.read ?? false,
    ts,
  };
  // De-dupe: at most one live (unread) chat.needs_input / chat.done per session —
  // replace the prior one rather than stacking, so a chatty agent can't spam.
  let prior = listNotifications();
  const t = item.target;
  if (
    (item.kind === "chat.needs_input" || item.kind === "chat.done") &&
    t &&
    t.type === "chat"
  ) {
    prior = prior.filter(
      (n) =>
        !(
          n.kind === item.kind &&
          n.target?.type === "chat" &&
          n.target.sessionId === t.sessionId
        ),
    );
  }
  persist([item, ...prior].sort((a, b) => b.ts - a.ts));
  return item;
}

/** Pane-scoped notification helper. Maps a pane id + label into a `pane` target
 *  so the notification stays clickable (focuses that pane). Still used by
 *  AppCastPane for stream errors. */
export function emitPaneNotification(
  input: {
    paneId: string;
    paneLabel?: string;
    title: string;
    body?: string;
    level?: NotificationLevel;
  },
  opts: { now?: number } = {},
): AiosNotification {
  return pushNotification(
    {
      kind: "pane",
      sourceLabel: input.paneLabel,
      title: input.title,
      body: input.body,
      level: input.level,
      target: { type: "pane", key: input.paneId },
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
