/** Wrappers over the native embedded-browser (child webview) commands. Each
 *  browser pane drives its own webview, addressed by a per-pane `label`. */
import { invoke } from "@tauri-apps/api/core";

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
export const browserBack = (label: string) => invoke("browser_back", { label });
export const browserForward = (label: string) => invoke("browser_forward", { label });
export const browserReload = (label: string) => invoke("browser_reload", { label });
export const browserHide = (label: string) => invoke("browser_hide", { label });
export const browserClose = (label: string) => invoke("browser_close", { label });
export const browserZoom = (label: string, factor: number) =>
  invoke("browser_zoom", { label, factor });
export const browserClearCookies = (label: string) =>
  invoke("browser_clear_cookies", { label });
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
export const readClipboard = () => invoke<string>("read_clipboard");

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
