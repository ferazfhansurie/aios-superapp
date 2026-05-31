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
