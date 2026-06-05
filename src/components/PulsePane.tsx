/** PULSE detail pane — the rich expansion of the idle PULSE tile. The compact
 *  tile hides most of what UsageExtras + IdleRate know; this pane lays it all
 *  out: streaks, lifetime totals, the three rate windows (5h / 7d / context) as
 *  rings, the freshest memory focus, and a large activity heatmap.
 *
 *  Self-fetching (usageExtras + idleRate + memoryFocus on mount) so it's a
 *  standalone pane like the others. Reuses Ring / heatColor / fmtNum / shortModel
 *  / shortDate from IdleDashboard so the look matches the tile exactly. */
import { useEffect, useState } from "react";
import { Flame, Zap } from "lucide-react";

import { usageExtras, type UsageExtras } from "../lib/stats";
import { idleRate, memoryFocus, type IdleRate, type MemoryFocus } from "../lib/dashboard";
import { Ring, heatColor, fmtNum, shortModel, shortDate } from "./IdleDashboard";
import { reportDiag } from "../lib/diag";

export function PulsePane() {
  const [extras, setExtras] = useState<UsageExtras | null>(null);
  const [rate, setRate] = useState<IdleRate | null>(null);
  const [focus, setFocus] = useState<MemoryFocus | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      usageExtras().then((v) => alive && setExtras(v)).catch((e) => reportDiag("pulse.load", e, { action: "usageExtras" }));
      idleRate().then((v) => alive && setRate(v)).catch((e) => reportDiag("pulse.load", e, { action: "idleRate" }));
      memoryFocus().then((v) => alive && setFocus(v)).catch((e) => reportDiag("pulse.load", e, { action: "memoryFocus" }));
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // last ~18 weeks of activity, columned into weeks (same logic the tile uses).
  const days = (extras?.heatmap ?? []).slice(-126);
  const max = Math.max(1, ...days.map((d) => d.count));
  const weeks: { date: string; count: number }[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      {/* header — same shape as the other tool panes */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Zap size={14} className="text-[var(--color-highlight)]" />
        <span className="text-[13px] font-medium text-[var(--color-text)]">pulse</span>
        <span className="text-[11px] text-[var(--color-muted)]">activity &amp; usage</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {/* streak hero */}
        {extras && (
          <div className="mb-6 flex items-center gap-3">
            <Flame
              size={28}
              className={extras.currentStreak > 0 ? "aios-flame text-[var(--color-accent)]" : "text-[var(--color-faint)]"}
              fill={extras.currentStreak > 0 ? "currentColor" : "none"}
            />
            <span className="font-mono text-[44px] font-semibold leading-none text-[var(--color-text)]">
              {extras.currentStreak}
            </span>
            <div className="flex flex-col leading-tight">
              <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">day streak</span>
              {extras.longestStreak > 0 && (
                <span className="font-mono text-[11px] text-[var(--color-faint)]">best {extras.longestStreak}</span>
              )}
            </div>
          </div>
        )}

        {/* big lifetime stats */}
        {extras && (
          <div className="mb-6 grid grid-cols-2 gap-5 sm:grid-cols-3">
            {extras.totalSessions != null && <BigStat value={fmtNum(extras.totalSessions)} label="sessions" />}
            {extras.totalMessages != null && <BigStat value={fmtNum(extras.totalMessages)} label="messages" />}
            {extras.tokensTotal != null && extras.tokensTotal > 0 && (
              <BigStat value={fmtNum(extras.tokensTotal)} label="tokens" />
            )}
            {extras.favoriteModel && <BigStat value={shortModel(extras.favoriteModel)} label="top model" />}
            {extras.active7d != null && <BigStat value={`${extras.active7d}/7`} label="active days · week" />}
            {extras.active30d != null && <BigStat value={`${extras.active30d}/30`} label="active days · month" />}
            {extras.firstSessionDate && (
              <BigStat value={shortDate(extras.firstSessionDate)} label="active since" />
            )}
          </div>
        )}

        {/* the three rate windows as rings */}
        {rate && (rate.fiveHour.pct != null || rate.sevenDay.pct != null || rate.contextPct != null) && (
          <div className="mb-6 flex flex-wrap gap-7">
            {rate.fiveHour.pct != null && (
              <Ring label="5h" pct={rate.fiveHour.pct} resetsAt={rate.fiveHour.resetsAt} size={72} />
            )}
            {rate.sevenDay.pct != null && (
              <Ring label="7d" pct={rate.sevenDay.pct} resetsAt={rate.sevenDay.resetsAt} size={72} />
            )}
            {rate.contextPct != null && <Ring label="ctx" pct={rate.contextPct} resetsAt={null} size={72} />}
          </div>
        )}

        {/* memory focus line */}
        {focus?.title && (
          <div className="mb-6 flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-accent)]">focus</span>
            <span className="text-[13px] leading-snug text-[var(--color-text-2)]">{focus.title}</span>
          </div>
        )}

        {/* large activity heatmap — full available width */}
        {!!weeks.length && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              {days.length}-day activity
            </span>
            <div className="flex h-[170px] gap-[3px]">
              {weeks.map((week, wi) => (
                <div key={wi} className="flex flex-1 flex-col gap-[3px]">
                  {week.map((d, di) => (
                    <span
                      key={d.date}
                      title={`${d.date} · ${d.count}`}
                      className="aios-cell flex-1 rounded-[2px]"
                      style={{ background: heatColor(d.count, max), animationDelay: `${(wi * 7 + di) * 5}ms` }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A large stacked value+label cell for the detail pane's stat grid. */
function BigStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[22px] font-semibold leading-none text-[var(--color-text)]">{value}</span>
      <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]">{label}</span>
    </div>
  );
}

// future: a per-model token breakdown + a daily-tokens sparkline would need a new
// usage-by-model Tauri command — out of scope (no new backend per the brief).
