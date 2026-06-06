/** Wrappers over the native app-cast (ScreenCaptureKit) commands. Each app-cast
 *  pane live-mirrors ONE foreign macOS window into a native child view floated
 *  over a React slot — the same architecture as the embedded browser, but the
 *  native layer is fed by another app's framebuffer instead of WebKit. Addressed
 *  by a per-pane `label`. Phase A = capture + mirror only (no input forwarding).
 *  See SPIKE-screencapturekit.md. macOS-only. */
import { invoke } from "./tauri";

import type { Rect } from "./browser";

/** One capturable window, as returned by the picker (SCShareableContent). */
export interface WindowInfo {
  app_name: string;
  window_title: string;
  window_id: number;
  pid: number;
  /** Owning app's bundle id (may be empty if SCK didn't expose one). */
  bundle_id: string;
}

/** Enumerate capturable windows (on-screen, non-trivial size, not AIOS itself).
 *  The FIRST call triggers the macOS Screen Recording permission prompt. */
export const appcastListWindows = () =>
  invoke<WindowInfo[]>("appcast_list_windows");

/** Start mirroring `window_id` into a native child view at the slot rect. Creates
 *  the SCStream + layer-backed view on first call; reposition-only if already up. */
export const appcastStart = (label: string, windowId: number, r: Rect) =>
  invoke("appcast_start", { label, windowId, ...r });

/** Reposition / resize the mirror view to the slot rect (bounds-sync loop). */
export const appcastSetBounds = (label: string, r: Rect) =>
  invoke("appcast_set_bounds", { label, ...r });

/** Hide without tearing down the stream (the view stays, just hidden). */
export const appcastHide = (label: string) => invoke("appcast_hide", { label });

/** Re-show after hide. */
export const appcastShow = (label: string) => invoke("appcast_show", { label });

/** Stop capture, drop the stream, and remove the native view (pane closed). */
export const appcastClose = (label: string) => invoke("appcast_close", { label });
