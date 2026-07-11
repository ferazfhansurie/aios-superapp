/** Persisted width for the drag-resizable sidebar rail.
 *  Deliberately its OWN localStorage key (not part of lib/settings.ts) so the
 *  live drag loop can write cheaply without churning the whole settings blob.
 *  Only the "full" rail is resizable; icons-only + collapsed are fixed states. */

const STORAGE_KEY = "aios.sidebarWidth";

/** Resizable bounds for the full rail. `DEFAULT` matches the old w-60 (15rem). */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 240;
/** Release the drag below this live width → collapse (same as ⌘B hide). */
export const SIDEBAR_COLLAPSE_AT = 140;
/** Drag out from the collapsed edge past this delta → re-expand to last width. */
export const SIDEBAR_EXPAND_AT = 60;

/** Clamp any value into the resizable range. */
export function clampSidebarWidth(px: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)));
}

/** Last persisted width, clamped + default-backed. */
export function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return clampSidebarWidth(n);
    }
  } catch {
    /* quota / unavailable — fall through to default */
  }
  return SIDEBAR_DEFAULT;
}

/** Persist a width (clamped). No-op on quota failure. */
export function saveSidebarWidth(px: number): number {
  const w = clampSidebarWidth(px);
  try {
    localStorage.setItem(STORAGE_KEY, String(w));
  } catch {
    /* quota / unavailable — keep whatever's in-memory */
  }
  return w;
}
