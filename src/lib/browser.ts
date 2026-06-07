/** Wrappers over the native embedded-browser (child webview) commands. Each
 *  browser pane drives its own webview, addressed by a per-pane `label`. */
import { invoke } from "./tauri";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const browserShow = (label: string, url: string, r: Rect, profile?: string) =>
  invoke("browser_show", { label, url, ...r, profile: profile ?? null });
export const browserSetBounds = (label: string, r: Rect) =>
  invoke("browser_set_bounds", { label, ...r });
export const browserNavigate = (label: string, url: string) =>
  invoke("browser_navigate", { label, url });
export const browserCurrentUrl = (label: string) =>
  invoke<string | null>("browser_current_url", { label });
/** WKWebView element-fullscreen state: 0 none · 1 entering · 2 in · 3 exiting. */
export const browserFullscreenState = (label: string) =>
  invoke<number>("browser_fullscreen_state", { label });
/** Put the OS window in/out of native fullscreen (screen-filling). */
export const setWindowFullscreen = (on: boolean) =>
  invoke("set_window_fullscreen", { on });
export const browserBack = (label: string) => invoke("browser_back", { label });
export const browserForward = (label: string) => invoke("browser_forward", { label });
export const browserReload = (label: string) => invoke("browser_reload", { label });
/** TRUE cache-bypass reload (WKWebView reloadFromOrigin) — the real "force reload". */
export const browserForceReload = (label: string) => invoke("browser_force_reload", { label });
/** [canGoBack, canGoForward] from the live WKWebView — drives toolbar button disabling. */
export const browserNavState = (label: string) =>
  invoke<[boolean, boolean]>("browser_nav_state", { label });
/** Opens the WKWebView Web Inspector (DevTools) for this pane. */
export const browserOpenDevtools = (label: string) =>
  invoke("browser_open_devtools", { label });
/** Native find-in-page. Returns whether a match was found (no match-count in the WebKit API). */
export const browserFind = (label: string, query: string, forward: boolean) =>
  invoke<boolean>("browser_find", { label, query, forward });
export const browserHide = (label: string) => invoke("browser_hide", { label });
export const browserClose = (label: string) => invoke("browser_close", { label });
export const browserZoom = (label: string, factor: number) =>
  invoke("browser_zoom", { label, factor });
export const browserClearCookies = (label: string) =>
  invoke("browser_clear_cookies", { label });
export const browserClearCache = (label: string) =>
  invoke("browser_clear_cache", { label });
export const browserDeviceMode = (label: string, mobile: boolean) =>
  invoke("browser_device_mode", { label, mobile });
export const browserScreenshot = (label: string, r: Rect) =>
  invoke<string>("browser_screenshot", { label, ...r });

// ─── Annotate mode (Codex-style select-on-page → send to chat) ──────────────
// Clipboard-bridge: the injected annotator writes `AIOS_ANNOT:<json>` to the
// system clipboard; the pane polls `readClipboard()` and parses the sentinel.
export const browserEnterAnnotate = (label: string) =>
  invoke("browser_enter_annotate", { label });
export const browserExitAnnotate = (label: string) =>
  invoke("browser_exit_annotate", { label });
export const browserCopySelection = (label: string) =>
  invoke("browser_copy_selection", { label });
export const browserInstallContextProbe = (label: string) =>
  invoke("browser_install_context_probe", { label });
export const readClipboard = () => invoke<string>("read_clipboard");

// ─── Persistent history / bookmarks / downloads ─────────────────────────────
// Backed by JSON stores under the Tauri app-data dir (browser_store.rs). See
// that module for the "JSON not sqlite" rationale.

export interface HistoryEntry {
  url: string;
  title: string;
  /** Last-visited timestamp (unix ms). */
  ts: number;
  visit_count: number;
}

/** Record (or bump) a committed navigation. Best-effort — never rejects-fatal. */
export const browserHistoryRecord = (url: string, title?: string) =>
  invoke("browser_history_record", { url, title: title ?? null });
/** Autocomplete query against history, ranked recency × frequency. Empty query
 *  returns the most-recently-visited entries. */
export const browserHistoryQuery = (query: string, limit?: number) =>
  invoke<HistoryEntry[]>("browser_history_query", { query, limit: limit ?? null });
export const browserHistoryClear = () => invoke("browser_history_clear");

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  ts: number;
}

/** Add/refresh a bookmark (idempotent on url). Returns the full list, newest first. */
export const browserBookmarkAdd = (url: string, title?: string) =>
  invoke<Bookmark[]>("browser_bookmark_add", { url, title: title ?? null });
/** Remove a bookmark by url (the star-off path) or id. Returns the updated list. */
export const browserBookmarkRemove = (opts: { url?: string; id?: string }) =>
  invoke<Bookmark[]>("browser_bookmark_remove", { url: opts.url ?? null, id: opts.id ?? null });
export const browserBookmarkList = () => invoke<Bookmark[]>("browser_bookmark_list");

export interface DownloadRecord {
  id: string;
  path: string;
  name: string;
  state: string;
  ts: number;
}

export const browserDownloadList = () => invoke<DownloadRecord[]>("browser_download_list");
export const browserDownloadForget = (id: string) =>
  invoke<DownloadRecord[]>("browser_download_forget", { id });
export const browserDownloadClear = () => invoke("browser_download_clear");
/** Reveal a downloaded file in Finder/Explorer, selecting it. */
export const browserRevealInFinder = (path: string) =>
  invoke("browser_reveal_in_finder", { path });

/** Shape the injected annotator (and selection-copy) serialize into the
 *  clipboard behind the `AIOS_ANNOT:` sentinel. */
export interface BrowserAnnotation {
  selector: string;
  tagName: string;
  text: string;
  note: string;
  rect: { x: number; y: number; width: number; height: number } | null;
  url: string;
}

export interface BrowserContextPayload {
  x: number;
  y: number;
  url: string;
  linkUrl: string;
  text: string;
}
