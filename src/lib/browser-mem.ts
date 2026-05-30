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
