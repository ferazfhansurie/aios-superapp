export interface PaneOrderState<T> {
  items: T[];
  selected: number;
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
