/** Wrappers over the native embedded-browser (child webview) commands. Each
 *  browser pane drives its own webview, addressed by a per-pane `label`. */
import { invoke } from "@tauri-apps/api/core";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const browserShow = (label: string, url: string, r: Rect) =>
  invoke("browser_show", { label, url, ...r });
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
