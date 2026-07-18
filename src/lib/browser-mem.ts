/** Per-pinned-site "last location" memory. A pinned site opens in a browser
 *  pane; as you navigate inside it the real url drifts from the pinned one. We
 *  stash the latest url under the site's stable sidebar id so closing + reopening
 *  returns you to where you left off instead of the original landing page.
 *
 *  Keyed by the sidebar item id (stable across restarts), persisted in
 *  localStorage. Generic (un-pinned) browser panes have no stable id, so they
 *  don't participate — only pinned sites get memory. */

const KEY = "aios.browser.lastUrl";

type Mem = Record<string, string>;

function read(): Mem {
  try {
    const raw = localStorage.getItem(KEY);
    const obj = raw ? (JSON.parse(raw) as unknown) : null;
    return obj && typeof obj === "object" ? (obj as Mem) : {};
  } catch {
    return {};
  }
}

/** Last url we recorded for this pinned site, if any. */
export function recallUrl(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return read()[key];
}

/** Record the current url for this pinned site (debounced by the caller). */
export function rememberUrl(key: string | undefined, url: string): void {
  if (!key || !url) return;
  try {
    const mem = read();
    if (mem[key] === url) return;
    mem[key] = url;
    localStorage.setItem(KEY, JSON.stringify(mem));
  } catch {
    /* quota / unavailable — best-effort */
  }
}

/** Drop the remembered url for a key (pane closed for good → don't restore it). */
export function forgetUrl(key: string | undefined): void {
  if (!key) return;
  try {
    const mem = read();
    if (!(key in mem)) return;
    delete mem[key];
    localStorage.setItem(KEY, JSON.stringify(mem));
  } catch {
    /* best-effort */
  }
}

// ── session-restore: per-pane-key last url ───────────────────────────────────
// Item 4. A GENERIC (un-pinned) browser pane has no stable sidebar id, but its
// pane KEY *is* persisted in the layout (App.tsx B1) and reused on restore. So a
// browser pane uses its own pane key as the memKey — this same `aios.browser.
// lastUrl` map then records its last url, and on restore the pane reads it back
// to reopen where it left off. recallUrl/rememberUrl above already key by an
// arbitrary string, so no new store is needed — the pane key just joins the
// pinned-site ids in the same map. These aliases make the intent explicit at
// the call sites and let App resolve a restored pane's url before mount.

/** Last url recorded for a browser pane key (session restore). */
export const recallPaneUrl = recallUrl;
/** Record a browser pane's current url under its pane key (session restore). */
export const rememberPaneUrl = rememberUrl;
