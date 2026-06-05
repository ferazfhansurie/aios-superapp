export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  previousScrollHeight?: number;
}

export const BOTTOM_STICKY_THRESHOLD_PX = 8;

/**
 * The threshold used to decide whether NEW content should keep the viewport
 * pinned to the bottom (autoscroll). Deliberately MUCH wider than the
 * pause/unpause threshold: a fast token stream grows `scrollHeight` by tens of
 * px between layout passes, so an 8px window let the bottom overshoot and the
 * view silently fell off. 96px keeps the view pinned through fast streams while
 * still releasing the instant the user scrolls up (the scroll handler pauses on
 * an "up" intent regardless of this number). Keep this separate from
 * `BOTTOM_STICKY_THRESHOLD_PX` so user-driven pause stays crisp.
 */
export const AUTOSCROLL_STICK_THRESHOLD_PX = 96;

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

export function shouldAutoscroll(
  metrics: ScrollMetrics,
  paused: boolean,
  thresholdPx: number = BOTTOM_STICKY_THRESHOLD_PX,
): boolean {
  if (paused) return false;
  if (distanceFromBottom(metrics) < thresholdPx) return true;
  if (metrics.previousScrollHeight == null) return false;
  return metrics.previousScrollHeight - metrics.scrollTop - metrics.clientHeight < thresholdPx;
}

export type ScrollIntent = "up" | "down" | "unknown";

export function nextAutoscrollPaused(
  paused: boolean,
  metrics: ScrollMetrics,
  intent: ScrollIntent,
  thresholdPx: number = BOTTOM_STICKY_THRESHOLD_PX,
): boolean {
  if (intent === "up") return true;
  if (distanceFromBottom(metrics) < thresholdPx) return false;
  return paused || intent !== "down";
}
