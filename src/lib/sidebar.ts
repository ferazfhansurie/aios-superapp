/** Typed, localStorage-backed sidebar store for the AIOS cockpit.
 *  Mirrors src/lib/settings.ts exactly: plain load/save helpers + a tiny
 *  subscribe/notify emitter so the rail re-renders on change without a state
 *  lib. The ordered `items` array IS the render order. Persisted as JSON under
 *  a single key. */

import { SPAWN } from "./apps.ts";

const STORAGE_KEY = "aios.sidebar";
const SCHEMA_VERSION = 4;

/** A space = a named, collapsible section of the rail. The three built-ins
 *  (sessions / tools / pinned) are `system` — they can be renamed + collapsed +
 *  reordered, but not deleted. The user can create their own spaces and sort
 *  apps + pinned sites into them. An item's `group` is the id of its space. */
export type SidebarGroup = string;

export const SYSTEM_SPACES = ["tools", "pinned"] as const;
const SYSTEM_SPACE_NAMES: Record<string, string> = {
  tools: "tools",
  pinned: "pinned",
};

export interface SidebarSpace {
  id: string; // stable id ("sessions" etc for system, uuid for custom)
  name: string; // user-editable display name
  collapsed?: boolean; // section folded shut
  system?: boolean; // built-in (cannot be deleted)
}

export type SidebarItemKind =
  | { type: "app"; appId: string } // references a built-in SPAWN entry by stable id
  | { type: "link"; url: string }; // pinned website → embedded browser

export interface SidebarItem {
  id: string; // stable uuid
  label: string; // user-editable display label
  iconName: string; // lucide icon name OR "favicon" for links
  faviconUrl?: string; // for link items: cached favicon url
  kind: SidebarItemKind;
  group: SidebarGroup; // id of the space it lives in
  hidden?: boolean; // user hid a default app
}

export interface SidebarState {
  items: SidebarItem[]; // ORDER in this array == render order
  spaces: SidebarSpace[]; // ORDER == section render order
  version: number; // schema version for migrations
}

/** The three built-in spaces, in their canonical order. */
function defaultSpaces(): SidebarSpace[] {
  return SYSTEM_SPACES.map((id) => ({ id, name: SYSTEM_SPACE_NAMES[id], system: true }));
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
    spaces: defaultSpaces(),
    items: SPAWN.map((a) => ({
      id: `app:${a.id}`,
      label: a.id === "chat" ? "new chat" : a.label,
      iconName: a.id, // resolved back to the lucide icon via SPAWN_BY_ID at render
      kind: { type: "app", appId: a.id } as SidebarItemKind,
      group: a.group as SidebarGroup,
      // non-first-class apps seed hidden — still reachable via ⌘K, just off the
      // default rail. The user can un-hide any of them from the row menu.
      hidden: !a.firstClass,
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
    const items = [...kept, ...additions];

    // Spaces: use stored ones if present (v2+); otherwise synthesize (v1 → v2
    // migration) from the built-in three plus any custom group ids items
    // reference. Then guarantee every item points at an existing space.
    const storedSpaces = Array.isArray(stored.spaces) ? (stored.spaces as SidebarSpace[]) : null;
    let spaces: SidebarSpace[];
    if (storedSpaces && storedSpaces.length) {
      // re-assert system flags + ensure the three built-ins always exist.
      const byId = new Map(storedSpaces.map((s) => [s.id, { ...s }]));
      for (const id of SYSTEM_SPACES) {
        const ex = byId.get(id);
        if (ex) ex.system = true;
        else byId.set(id, { id, name: SYSTEM_SPACE_NAMES[id], system: true });
      }
      // keep stored order, appending any missing system space at the end.
      const ordered = storedSpaces.map((s) => byId.get(s.id)!).filter(Boolean);
      for (const id of SYSTEM_SPACES) {
        if (!ordered.some((s) => s.id === id)) ordered.push(byId.get(id)!);
      }
      spaces = ordered;
    } else {
      const custom = Array.from(new Set(items.map((it) => it.group))).filter(
        (g) => !SYSTEM_SPACES.includes(g as (typeof SYSTEM_SPACES)[number]),
      );
      spaces = [...defaultSpaces(), ...custom.map((id) => ({ id, name: id }))];
    }
    // v2→v3: the "sessions" group was folded into "tools". Drop the sessions
    // space and move anything that lived there into tools.
    spaces = spaces.filter((s) => s.id !== "sessions");
    const remapped = items.map((it) =>
      it.group === "sessions" ? { ...it, group: "tools" } : it,
    );
    const knownSpaces = new Set(spaces.map((s) => s.id));
    const fixed = remapped.map((it) =>
      knownSpaces.has(it.group) ? it : { ...it, group: "pinned" },
    );
    cache = { version: SCHEMA_VERSION, spaces, items: fixed };
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

/** Pin a website → a link item in a space (default "pinned"). */
export function addLink(
  url: string,
  label?: string,
  faviconUrl?: string,
  spaceId: string = "pinned",
): SidebarState {
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
    group: spaceId,
  };
  const cur = loadSidebar();
  const group = cur.spaces.some((s) => s.id === spaceId) ? spaceId : "pinned";
  return saveSidebar({ ...cur, items: [...cur.items, { ...item, group }] });
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

/** Change an item's sidebar icon. Links may use "favicon" to restore the site icon. */
export function setItemIcon(id: string, iconName: string): SidebarState {
  const clean = iconName.trim();
  if (!clean) return loadSidebar();
  const cur = loadSidebar();
  return saveSidebar({
    ...cur,
    items: cur.items.map((it) => (it.id === id ? { ...it, iconName: clean } : it)),
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

/* ── spaces ────────────────────────────────────────────────────────────── */

/** Create a new (custom) space at the end of the rail. Returns its id. */
export function addSpace(name: string): { state: SidebarState; id: string } {
  const cur = loadSidebar();
  const clean = name.trim().slice(0, 32) || "new space";
  const space: SidebarSpace = { id: uid(), name: clean };
  return { state: saveSidebar({ ...cur, spaces: [...cur.spaces, space] }), id: space.id };
}

/** Rename a space (system or custom). */
export function renameSpace(id: string, name: string): SidebarState {
  const cur = loadSidebar();
  const clean = name.trim().slice(0, 32);
  if (!clean) return cur;
  return saveSidebar({
    ...cur,
    spaces: cur.spaces.map((s) => (s.id === id ? { ...s, name: clean } : s)),
  });
}

/** Delete a custom space; its items fall back to the "pinned" space so nothing
 *  is lost. System spaces are protected (no-op). */
export function removeSpace(id: string): SidebarState {
  const cur = loadSidebar();
  const target = cur.spaces.find((s) => s.id === id);
  if (!target || target.system) return cur;
  return saveSidebar({
    ...cur,
    spaces: cur.spaces.filter((s) => s.id !== id),
    items: cur.items.map((it) => (it.group === id ? { ...it, group: "pinned" } : it)),
  });
}

/** Collapse / expand a space (or set explicitly). */
export function toggleSpaceCollapsed(id: string, collapsed?: boolean): SidebarState {
  const cur = loadSidebar();
  return saveSidebar({
    ...cur,
    spaces: cur.spaces.map((s) =>
      s.id === id ? { ...s, collapsed: collapsed ?? !s.collapsed } : s,
    ),
  });
}

/** Reorder spaces (absolute indices into the spaces array). */
export function moveSpace(fromIndex: number, toIndex: number): SidebarState {
  const cur = loadSidebar();
  const spaces = [...cur.spaces];
  if (
    fromIndex < 0 ||
    fromIndex >= spaces.length ||
    toIndex < 0 ||
    toIndex >= spaces.length ||
    fromIndex === toIndex
  ) {
    return cur;
  }
  const [moved] = spaces.splice(fromIndex, 1);
  spaces.splice(toIndex, 0, moved);
  return saveSidebar({ ...cur, spaces });
}

/** Restore the default sidebar (drops all links + custom spaces + un-hides). */
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
