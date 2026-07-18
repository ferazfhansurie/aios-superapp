/** CDP "real Chrome as a pane" bridge — thin wrappers over the Rust cdp_*
 *  commands (src-tauri/src/cdp.rs). One spike session: a supervised real
 *  Chrome, one attached tab, screencast frames streamed back over a Tauri
 *  `Channel` (same per-session channel pattern as pty.ts / chat.ts).
 *
 *  Frame acking happens in RUST on receipt — by the time a frame event reaches
 *  this layer Chrome is already producing the next one, so the paint loop can
 *  be as slow as it likes without throttling the stream. */
import { Channel } from "@tauri-apps/api/core";

import { invoke } from "./tauri";

/** A detected Chromium-family browser. */
export interface ChromeInfo {
  name: string;
  path: string;
}

/** Page.screencastFrame metadata — everything the pane needs to map canvas CSS
 *  px → page viewport coordinates. `timestamp` is epoch SECONDS (CDP
 *  TimeSinceEpoch) — comparable against Date.now()/1000 on the same machine,
 *  which is exactly what the input→frame latency probe does. */
export interface FrameMeta {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  timestamp?: number;
}

/** Everything the backend pushes over the pane's channel. */
export type CdpEvent =
  | { type: "frame"; data: string; metadata: FrameMeta; rustTs: number }
  | { type: "url"; url: string }
  | { type: "detached"; reason: string }
  | { type: "closed" };

/** Live tab info the pane tracks (spike: just the URL). */
export interface TabInfo {
  url: string;
}

/** Which Chromium-family browser would be driven, or null (→ empty state). */
export async function cdpDetectChrome(): Promise<ChromeInfo | null> {
  return invoke<ChromeInfo | null>("cdp_detect_chrome");
}

/** Launch-or-reattach Chrome + attach the first tab + start the screencast.
 *  `width`/`height` = pane rect CSS px, `scale` = devicePixelRatio (frames come
 *  back at width×scale for retina crispness). Returns the tab's current URL.
 *  Events (frames, url changes, detach) stream to `onEvent`. */
export async function cdpOpen(
  onEvent: (ev: CdpEvent) => void,
  opts: { url?: string; width: number; height: number; scale?: number },
): Promise<string> {
  const channel = new Channel<CdpEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("cdp_open", {
    onEvent: channel,
    url: opts.url ?? null,
    width: Math.max(32, Math.round(opts.width)),
    height: Math.max(32, Math.round(opts.height)),
    scale: opts.scale ?? window.devicePixelRatio ?? 1,
  });
}

/** Detach the pane (stops the screencast, closes the WS). Chrome itself stays
 *  alive for instant reattach; the app-exit handler reaps it. */
export async function cdpClosePane(): Promise<void> {
  return invoke<void>("cdp_close_pane");
}

export async function cdpNavigate(url: string): Promise<void> {
  return invoke<void>("cdp_navigate", { url });
}

/** Returns whether a history step actually happened. */
export async function cdpBack(): Promise<boolean> {
  return invoke<boolean>("cdp_back");
}

export async function cdpForward(): Promise<boolean> {
  return invoke<boolean>("cdp_forward");
}

export async function cdpReload(): Promise<void> {
  return invoke<void>("cdp_reload");
}

export type CdpMouseKind = "mousePressed" | "mouseReleased" | "mouseMoved";
export type CdpMouseButton = "left" | "middle" | "right" | "none";

/** Forward a mouse event at page CSS-px coordinates. */
export async function cdpMouse(
  kind: CdpMouseKind,
  x: number,
  y: number,
  opts?: { button?: CdpMouseButton; clickCount?: number; modifiers?: number },
): Promise<void> {
  return invoke<void>("cdp_mouse", {
    kind,
    x,
    y,
    button: opts?.button ?? null,
    clickCount: opts?.clickCount ?? null,
    modifiers: opts?.modifiers ?? null,
  });
}

/** Forward a wheel event. NOTE: deltas here use CDP's wheel convention, which
 *  is the INVERSE of DOM WheelEvent (DevTools' own screencast frontend sends
 *  `wheelDelta`, i.e. -deltaY). Use `wheelDeltas(e)` to convert. */
export async function cdpScroll(
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
  modifiers?: number,
): Promise<void> {
  return invoke<void>("cdp_scroll", { x, y, deltaX, deltaY, modifiers: modifiers ?? null });
}

/** DOM WheelEvent → CDP mouseWheel deltas (sign flip). */
export function wheelDeltas(e: { deltaX: number; deltaY: number }): { deltaX: number; deltaY: number } {
  return { deltaX: -e.deltaX, deltaY: -e.deltaY };
}

export interface CdpKeyEvent {
  kind: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
  modifiers: number;
}

export async function cdpKey(ev: CdpKeyEvent): Promise<void> {
  return invoke<void>("cdp_key", {
    kind: ev.kind,
    key: ev.key,
    code: ev.code,
    windowsVirtualKeyCode: ev.windowsVirtualKeyCode,
    text: ev.text ?? null,
    modifiers: ev.modifiers,
  });
}

/** IME-grade insertion (paste / emoji) — bypasses key events. */
export async function cdpInsertText(text: string): Promise<void> {
  return invoke<void>("cdp_insert_text", { text });
}

/** Pane rect changed → re-emulate the viewport + restart the screencast. */
export async function cdpSetViewport(width: number, height: number, scale?: number): Promise<void> {
  return invoke<void>("cdp_set_viewport", {
    width: Math.max(32, Math.round(width)),
    height: Math.max(32, Math.round(height)),
    scale: scale ?? window.devicePixelRatio ?? 1,
  });
}

// ── JS KeyboardEvent → CDP key event mapping ─────────────────────────────────

/** CDP Input modifiers bitmask: alt=1 ctrl=2 meta=4 shift=8. */
export function cdpModifiers(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** Keys whose keydown should carry `text` even though e.key is a name. */
const TEXT_FOR_KEY: Record<string, string> = {
  Enter: "\r",
  Tab: "\t",
};

/** The minimal KeyboardEvent surface the mapper reads (so tests can fake it). */
export interface KeyLike {
  key: string;
  code: string;
  keyCode?: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Maps a DOM keyboard event to the CDP events to dispatch.
 *
 *  Scheme (same as Puppeteer / the DevTools screencast frontend):
 *  - keydown of a PRINTABLE (e.key is one char, no ctrl/meta chord) →
 *    `keyDown` WITH `text` — Chrome synthesizes the char insertion from that
 *    one event, so no separate `char` event is sent (sending both would
 *    double-type; the `char` kind stays available on CdpKeyEvent for callers
 *    that want insertion without a keydown).
 *  - keydown of anything else (arrows, Escape, chorded keys) → `rawKeyDown`.
 *  - keyup → `keyUp`. */
export function keyEventsFor(e: KeyLike, dir: "down" | "up"): CdpKeyEvent[] {
  const modifiers = cdpModifiers(e);
  const vk = e.keyCode ?? 0;
  const base = { key: e.key, code: e.code, windowsVirtualKeyCode: vk, modifiers };
  if (dir === "up") return [{ ...base, kind: "keyUp" }];
  const chorded = e.ctrlKey || e.metaKey;
  const text = !chorded ? (e.key.length === 1 ? e.key : TEXT_FOR_KEY[e.key]) : undefined;
  if (text !== undefined) return [{ ...base, kind: "keyDown", text }];
  return [{ ...base, kind: "rawKeyDown" }];
}
