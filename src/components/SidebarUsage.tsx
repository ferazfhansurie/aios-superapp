/**
 * SidebarUsage — a compact, narrow-sidebar rendering of the user's live usage
 * for BOTH providers: Claude (5h / 7d rate-limit windows from the statusline)
 * and Codex (ChatGPT-sub primary/secondary windows from ~/.codex logs). Each
 * provider gets its own labelled block so you can see, at a glance, which brain
 * has headroom — the whole point now that codex is the daily driver.
 *
 * Data paths (both already-wired, defensive Tauri commands; see lib/dashboard):
 *   claude ← idleRate()  → usage_stats   (statusline 5h/7d %)
 *   codex  ← codexRate() → codex_usage   (logs_2.sqlite codex.rate_limits)
 *
 * A provider block hides itself when it has no data (e.g. codex before its first
 * desktop/TUI turn), so the section never shows empty bars.
 *
 * Color thresholds match the idle bar: accent under ~65%, warning to ~85%,
 * danger above.
 */
import { useEffect, useState } from "react";

import { idleRate, codexRate, resetIn, type IdleRate, type CodexRate } from "../lib/dashboard";

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
  showRemaining = false,
}: {
  label: string;
  pct: number | null;
  resetsAt: number | null;
  showRemaining?: boolean;
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
          <span className="font-mono text-[var(--color-text-2)]">
            {Math.round(showRemaining ? 100 - pct : pct)}%{showRemaining ? " left" : ""}
          </span>
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

/** One provider's titled block (e.g. "claude" / "codex") with its 5h + 7d bars. */
function ProviderBlock({
  name,
  fiveHour,
  sevenDay,
  showRemaining = false,
}: {
  name: string;
  fiveHour: { pct: number | null; resetsAt: number | null };
  sevenDay: { pct: number | null; resetsAt: number | null };
  showRemaining?: boolean;
}) {
  if (fiveHour.pct == null && sevenDay.pct == null) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-medium lowercase tracking-wide text-[var(--color-text-2)]">
        {name}
      </span>
      <UsageBar label="5h" pct={fiveHour.pct} resetsAt={fiveHour.resetsAt} showRemaining={showRemaining} />
      <UsageBar label="7d" pct={sevenDay.pct} resetsAt={sevenDay.resetsAt} showRemaining={showRemaining} />
    </div>
  );
}

export function SidebarUsage() {
  const [rate, setRate] = useState<IdleRate | null>(null);
  const [codex, setCodex] = useState<CodexRate | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      idleRate()
        .then((v) => alive && setRate(v))
        .catch(() => {});
      codexRate()
        .then((v) => alive && setCodex(v))
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const hasClaude = rate && (rate.fiveHour.pct != null || rate.sevenDay.pct != null);
  const hasCodex = codex && (codex.fiveHour.pct != null || codex.sevenDay.pct != null);
  if (!hasClaude && !hasCodex) return null;

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
      <span className="text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)]">usage</span>
      {hasClaude && (
        <ProviderBlock name="claude" fiveHour={rate!.fiveHour} sevenDay={rate!.sevenDay} />
      )}
      {hasCodex && (
        <ProviderBlock name="codex" fiveHour={codex!.fiveHour} sevenDay={codex!.sevenDay} showRemaining />
      )}
    </div>
  );
}
