export type UsagePaceRiskLevel = "warning" | "danger";

export interface UsagePaceRisk {
  level: UsagePaceRiskLevel;
  title: string;
  detail: string;
}

export interface UsagePaceInput {
  pct: number | null;
  resetsAt: number | null;
  windowSeconds: number;
  nowSeconds?: number;
}

const clampPct = (pct: number): number => Math.min(Math.max(pct, 0), 100);

function compactDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

export function usagePaceRisk(input: UsagePaceInput): UsagePaceRisk | null {
  if (input.pct == null || !input.resetsAt || input.windowSeconds <= 0) return null;

  const pct = clampPct(input.pct);
  if (pct <= 0 || pct >= 100) return null;

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const remainingSeconds = input.resetsAt - now;
  if (remainingSeconds <= 60) return null;

  const elapsedSeconds = input.windowSeconds - remainingSeconds;
  if (elapsedSeconds <= 60) return null;

  const evenPacePct = (elapsedSeconds / input.windowSeconds) * 100;
  const aheadBy = pct - evenPacePct;
  if (aheadBy < 8 && pct < 85) return null;

  const pctPerSecond = pct / elapsedSeconds;
  if (pctPerSecond <= 0) return null;

  const secondsToEmpty = (100 - pct) / pctPerSecond;
  if (secondsToEmpty >= remainingSeconds) return null;

  const level: UsagePaceRiskLevel =
    pct >= 85 || secondsToEmpty < remainingSeconds * 0.45 ? "danger" : "warning";

  return {
    level,
    title: level === "danger" ? "slow down" : "fast pace",
    detail: `empty in ${compactDuration(secondsToEmpty)} before reset`,
  };
}
