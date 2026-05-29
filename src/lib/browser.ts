/** Wrappers over the native embedded-browser (child webview) commands. */
import { invoke } from "@tauri-apps/api/core";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const browserShow = (url: string, r: Rect) =>
  invoke("browser_show", { url, ...r });
export const browserSetBounds = (r: Rect) => invoke("browser_set_bounds", { ...r });
export const browserNavigate = (url: string) => invoke("browser_navigate", { url });
export const browserBack = () => invoke("browser_back");
export const browserForward = () => invoke("browser_forward");
export const browserReload = () => invoke("browser_reload");
export const browserHide = () => invoke("browser_hide");
export const browserClose = () => invoke("browser_close");
