/** Typed, localStorage-backed sidebar store for the AIOS cockpit.
 *  Mirrors src/lib/settings.ts exactly: plain load/save helpers + a tiny
 *  subscribe/notify emitter so the rail re-renders on change without a state
 *  lib. The ordered `items` array IS the render order. Persisted as JSON under
 *  a single key. */

import { SPAWN } from "./apps";

const STORAGE_KEY = "aios.sidebar";
const SCHEMA_VERSION = 1;

export type SidebarGroup = "sessions" | "tools" | "pinned";

export type SidebarItemKind =
  | { type: "app"; appId: string } // references a built-in SPAWN entry by stable id
  | { type: "link"; url: string }; // pinned website → embedded browser

export interface SidebarItem {
  id: string; // stable uuid
  label: string; // user-editable display label
  iconName: string; // lucide icon name OR "favicon" for links
  faviconUrl?: string; // for link items: cached favicon url
  kind: SidebarItemKind;
  group: SidebarGroup; // which section it lives in
  hidden?: boolean; // user hid a default app
}

export interface SidebarState {
  items: SidebarItem[]; // ORDER in this array == render order
  version: number; // schema version for migrations
}

/** A small, stable id generator (crypto.randomUUID with a fallback). */
function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** Build the default sidebar from the app catalog — identical to the old
 *  hardcoded rail (same items, same two groups, same order). */
export function seedDefault(): SidebarState {
  return {
    version: SCHEMA_VERSION,
    items: SPAWN.map((a) => ({
      id: `app:${a.id}`,
      label: a.id === "chat" ? "new chat" : a.label,
      iconName: a.id, // resolved back to the lucide icon via SPAWN_BY_ID at render
      kind: { type: "app", appId: a.id } as SidebarItemKind,
      group: a.group as SidebarGroup,
    })),
  };
}

type Listener = (s: SidebarState) => void;
const listeners = new Set<Listener>();

let cache: SidebarState | null = null;

/** Load the sidebar state. On a fresh profile, seed from the app catalog so the
 *  default rail matches today's. Stored app-items are reconciled against the
 *  catalog so a new built-in app shows up after an upgrade (forward-compatible),
 *  while preserving user order / hidden / renames for existing ones. */
export function loadSidebar(): SidebarState {
  if (cache) return cache;
  const seeded = seedDefault();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = seeded;
      return cache;
    }
    const stored = JSON.parse(raw) as Partial<SidebarState>;
    const storedItems = Array.isArray(stored.items) ? stored.items : [];
    // keep all stored items whose underlying app still exists (or are links).
    const known = new Set(SPAWN.map((a) => a.id));
    const kept = storedItems.filter(
      (it) => it.kind?.type === "link" || (it.kind?.type === "app" && known.has(it.kind.appId)),
    );
    // append any catalog app not present in stored state (new built-in).
    const present = new Set(
      kept.filter((it) => it.kind?.type === "app").map((it) => (it.kind as { appId: string }).appId),
    );
    const additions = seeded.items.filter(
      (it) => it.kind.type === "app" && !present.has((it.kind as { appId: string }).appId),
    );
    cache = { version: SCHEMA_VERSION, items: [...kept, ...additions] };
  } catch {
    cache = seeded;
  }
  return cache;
}

/** Persist the next state and notify subscribers. */
export function saveSidebar(next: SidebarState): SidebarState {
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / unavailable — keep in-memory cache */
  }
  listeners.forEach((fn) => fn(next));
  return next;
}

/* ── mutators ──────────────────────────────────────────────────────────── */

/** Move an item from one index to another (within the full ordered array). */
export function reorder(fromIndex: number, toIndex: number): SidebarState {
  const items = [...loadSidebar().items];
  if (
    fromIndex < 0 ||
    fromIndex >= items.length ||
    toIndex < 0 ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return loadSidebar();
  }
  const [moved] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, moved);
  return saveSidebar({ ...loadSidebar(), items });
}

/** Pin a website → a link item in the "pinned" group. */
export function addLink(url: string, label?: string, faviconUrl?: string): SidebarState {
  const norm = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  let host = "";
  try {
    host = new URL(norm).hostname.replace(/^www\./, "");
  } catch {
    host = norm;
  }
  const favicon =
    faviconUrl ?? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  const item: SidebarItem = {
    id: uid(),
    label: label?.trim() || host,
    iconName: "favicon",
    faviconUrl: favicon,
    kind: { type: "link", url: norm },
    group: "pinned",
  };
  const cur = loadSidebar();
  return saveSidebar({ ...cur, items: [...cur.items, item] });
}

/** Remove an item entirely (used for unpinning links). */
export function removeItem(id: string): SidebarState {
  const cur = loadSidebar();
  return saveSidebar({ ...cur, items: cur.items.filter((it) => it.id !== id) });
}

/** Rename an item's display label. */
export function renameItem(id: string, label: string): SidebarState {
  const cur = loadSidebar();
  return saveSidebar({
    ...cur,
    items: cur.items.map((it) => (it.id === id ? { ...it, label } : it)),
  });
}

/** Toggle (or set) an item's hidden flag. */
export function toggleHidden(id: string, hidden?: boolean): SidebarState {
  const cur = loadSidebar();
  return saveSidebar({
    ...cur,
    items: cur.items.map((it) =>
      it.id === id ? { ...it, hidden: hidden ?? !it.hidden } : it,
    ),
  });
}

/** Move an item into a different group (keeps it at the end of that group's run
 *  via the natural array order — render groups by filtering). */
export function setGroup(id: string, group: SidebarGroup): SidebarState {
  const cur = loadSidebar();
  return saveSidebar({
    ...cur,
    items: cur.items.map((it) => (it.id === id ? { ...it, group } : it)),
  });
}

/** Restore the default sidebar (drops all links + un-hides built-ins). */
export function resetSidebar(): SidebarState {
  return saveSidebar(seedDefault());
}

/** Subscribe to changes; returns an unsubscribe fn. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
