export interface PaneOrderState<T> {
  items: T[];
  selected: number;
}

export const CORE_PANE_TYPES = ["browser", "chat", "files", "history", "oracle", "shell", "tmux"] as const;

const CORE_PANE_TYPE_SET = new Set<string>(CORE_PANE_TYPES);

export function isCorePaneKind(type: string): type is (typeof CORE_PANE_TYPES)[number] {
  return CORE_PANE_TYPE_SET.has(type);
}

// ── stable pane keys ─────────────────────────────────────────────────────────
// A pane's key is minted ONCE at spawn and persisted with the layout
// (`aios.layout`), then REUSED on restore. Terminal panes derive their tmux
// session name (`aios-term-<key>`) from it, so a key that changes across
// launches orphans the session. Shape: `k-<kind>-<shortid>`.

/** Sanitize a pane kind for embedding in a key (and thus a tmux session name). */
function kindSlug(kind: string): string {
  const slug = kind.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "pane";
}

function shortId(): string {
  try {
    // 8 hex chars of real randomness when available.
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0].toString(36).padStart(7, "0").slice(0, 7);
  } catch {
    return `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
  }
}

/** Mint a stable pane key: `k-<kind>-<shortid>`. Pass `taken` (existing keys)
 *  to guarantee uniqueness within a layout. */
export function newPaneKey(kind: string, taken?: ReadonlySet<string>): string {
  for (let i = 0; i < 32; i++) {
    const key = `k-${kindSlug(kind)}-${shortId()}`;
    if (!taken || !taken.has(key)) return key;
  }
  // astronomically unlikely; timestamp suffix breaks any tie.
  return `k-${kindSlug(kind)}-${shortId()}-${Date.now().toString(36)}`;
}

/** A persisted layout entry. `kind` keeps whatever fields were saved (unknown
 *  future fields survive a round-trip — the migration must never shed data). */
export interface SavedPaneRecord {
  key: string;
  label: string;
  kind: { type: string; [extra: string]: unknown };
  [extra: string]: unknown;
}

/** Core-shell key migration for a parsed `aios.layout` value.
 *
 *  - entries that already carry a string key are passed through UNTOUCHED
 *  - entries without a key (pre-stable-keys layouts) get one minted ONCE
 *    (`changed: true` tells the caller to persist the migrated array so the
 *    next launch sees the same keys — that's what makes tmux reattach work)
 *  - non-core pane kinds are dropped and persisted away so old layouts cannot
 *    quietly revive slow feature panes at startup
 *  - only entries that aren't even pane-shaped (no kind.type string) are
 *    skipped; a skip alone never sets `changed`, so a parse oddity can't
 *    trigger a rewrite of stored data.
 */
export function migrateLayoutPanes(parsed: unknown): { panes: SavedPaneRecord[]; changed: boolean } {
  if (!Array.isArray(parsed)) return { panes: [], changed: false };
  const taken = new Set<string>();
  for (const p of parsed) {
    if (p && typeof p === "object" && typeof (p as { key?: unknown }).key === "string") {
      taken.add((p as { key: string }).key);
    }
  }
  let changed = false;
  const panes: SavedPaneRecord[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const kind = rec.kind;
    if (!kind || typeof kind !== "object" || typeof (kind as { type?: unknown }).type !== "string") {
      continue;
    }
    if (!isCorePaneKind((kind as { type: string }).type)) {
      changed = true;
      continue;
    }
    let key = typeof rec.key === "string" && rec.key ? rec.key : null;
    if (!key) {
      key = newPaneKey((kind as { type: string }).type, taken);
      taken.add(key);
      changed = true;
    }
    panes.push({
      ...rec,
      key,
      label: typeof rec.label === "string" ? rec.label : "",
      kind: kind as SavedPaneRecord["kind"],
    });
  }
  return { panes, changed };
}

export function movePane<T>(items: T[], index: number, delta: -1 | 1): PaneOrderState<T> {
  if (index < 0 || index >= items.length || items.length < 2) {
    return { items, selected: Math.max(0, Math.min(index, items.length - 1)) };
  }
  const to = Math.max(0, Math.min(items.length - 1, index + delta));
  if (to === index) return { items, selected: index };
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return { items: next, selected: to };
}

export function gridTrackStorageKey(base: string, cols: number, rows: number): string {
  return `${base}:${cols}x${rows}`;
}

export function loadGridTracks(
  key: string,
  cols: number,
  rows: number,
): { cols: number[]; rows: number[] } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { cols?: unknown; rows?: unknown };
    if (
      !Array.isArray(parsed.cols) ||
      !Array.isArray(parsed.rows) ||
      parsed.cols.length !== cols ||
      parsed.rows.length !== rows
    ) {
      return null;
    }
    const colTracks = parsed.cols.filter((n): n is number => typeof n === "number" && n > 0);
    const rowTracks = parsed.rows.filter((n): n is number => typeof n === "number" && n > 0);
    if (colTracks.length !== cols || rowTracks.length !== rows) return null;
    return { cols: colTracks, rows: rowTracks };
  } catch {
    return null;
  }
}

export function saveGridTracks(key: string, cols: number[], rows: number[]): void {
  try {
    localStorage.setItem(key, JSON.stringify({ cols, rows }));
  } catch {
    /* quota / unavailable */
  }
}
