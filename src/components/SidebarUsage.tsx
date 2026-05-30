/**
 * SidebarUsage — a compact, narrow-sidebar rendering of the user's live Claude
 * usage (the same 5h / 7d rate-limit windows the idle dashboard's rings show).
 *
 * Reuses the already-wired data path: `idleRate()` → `usage_stats` Tauri command
 * (see lib/dashboard.ts). Mirrors IdleDashboard's polling (a useEffect with a
 * setInterval at 30s). Renders two thin labelled bars instead of rings so it
 * sits quietly at the bottom of the agents sidebar.
 *
 * Color thresholds match the idle bar (`Meter` in IdleDashboard): accent under
 * ~65%, warning to ~85%, danger above.
 */
import { useEffect, useState } from "react";

import { idleRate, resetIn, type IdleRate } from "../lib/dashboard";

/** accent < 65% · warning < 85% · danger above — matches IdleDashboard's Meter. */
function barColor(pct: number): string {
  if (pct >= 85) return "var(--color-danger)";
  if (pct >= 65) return "var(--color-warning)";
  return "var(--color-accent)";
}

function UsageBar({
  label,
  pct,
  resetsAt,
}: {
  label: string;
  pct: number | null;
  resetsAt: number | null;
}) {
  if (pct == null) return null;
  const clamped = Math.min(Math.max(pct, 0), 100);
  const reset = resetsAt ? resetIn(resetsAt) : "";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[10px]">
        <span className="font-medium uppercase tracking-widest text-[var(--color-muted)]">{label}</span>
        <span className="flex items-baseline gap-1.5">
          {reset && <span className="text-[var(--color-faint)]">resets {reset}</span>}
          <span className="font-mono text-[var(--color-text-2)]">{Math.round(pct)}%</span>
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--color-panel-2)]">
        <div
          className="h-full rounded-full transition-[width] duration-700"
          style={{ width: `${clamped}%`, background: barColor(pct) }}
        />
      </div>
    </div>
  );
}

export function SidebarUsage() {
  const [rate, setRate] = useState<IdleRate | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      idleRate()
        .then((v) => alive && setRate(v))
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const hasRate = rate && (rate.fiveHour.pct != null || rate.sevenDay.pct != null);
  if (!hasRate) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
      <span className="text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)]">usage</span>
      <div className="flex flex-col gap-2">
        <UsageBar label="5h" pct={rate!.fiveHour.pct} resetsAt={rate!.fiveHour.resetsAt} />
        <UsageBar label="7d" pct={rate!.sevenDay.pct} resetsAt={rate!.sevenDay.resetsAt} />
      </div>
    </div>
  );
}
