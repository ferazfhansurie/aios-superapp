export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  previousScrollHeight?: number;
}

export const BOTTOM_STICKY_THRESHOLD_PX = 8;

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
