import type { IdleRate, MemoryFocus } from "../../lib/dashboard";
import type { UsageExtras } from "../../lib/stats";
import { ActivityHeatmap } from "./ControlCenterCharts";

function compactNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return `${Math.round(value / 1_000_000_000)}b`;
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function pct(value: number | null | undefined) {
  return value == null ? "—" : `${Math.round(value)}`;
}

function activeSince(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", year: "2-digit" }).toLowerCase();
}

export function PulseIdentityBand({
  extras,
  rate,
  focus,
}: {
  extras: UsageExtras | null;
  rate: IdleRate | null;
  focus: MemoryFocus | null;
}) {
  const metrics = [
    { label: "day streak", value: compactNumber(extras?.currentStreak), sub: `best ${compactNumber(extras?.longestStreak)}` },
    { label: "sessions", value: compactNumber(extras?.totalSessions) },
    { label: "messages", value: compactNumber(extras?.totalMessages) },
    { label: "tokens", value: compactNumber(extras?.tokensTotal) },
    { label: "top model", value: extras?.favoriteModel ?? "—" },
    { label: "active days · week", value: `${compactNumber(extras?.active7d)}/7` },
    { label: "active days · month", value: `${compactNumber(extras?.active30d)}/30` },
    { label: "active since", value: activeSince(extras?.firstSessionDate) },
  ];

  return (
    <section className="grid gap-5 border-b border-[var(--color-border)] pb-5 xl:grid-cols-[minmax(0,1fr)_330px]">
      <div className="min-w-0">
        <div className="mb-3 flex items-center gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">pulse</div>
            <div className="text-[11px] text-[var(--color-faint)]">activity & usage</div>
          </div>
          <div className="ml-auto grid grid-cols-3 gap-2 text-right font-mono text-[11px] text-[var(--color-muted)]">
            <span><b className="text-[var(--color-text)]">{pct(rate?.fiveHour.pct)}</b> 5h</span>
            <span><b className="text-[var(--color-text)]">{pct(rate?.sevenDay.pct)}</b> 7d</span>
            <span><b className="text-[var(--color-text)]">{pct(rate?.contextPct)}</b> ctx</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-4 md:grid-cols-4">
          {metrics.map((metric) => (
            <div key={metric.label} className="min-w-0 border-l border-[var(--color-border)] pl-3">
              <div className="truncate text-[22px] font-semibold leading-tight text-[var(--color-text)]">{metric.value}</div>
              <div className="truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted)]">{metric.label}</div>
              {metric.sub && <div className="text-[10px] text-[var(--color-faint)]">{metric.sub}</div>}
            </div>
          ))}
        </div>
        <div className="mt-4 border-t border-[var(--color-border)] pt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">focus</div>
          <div className="truncate text-[13px] text-[var(--color-text)]">{focus?.title ?? "aios shell control center"}</div>
          <div className="truncate text-[11px] text-[var(--color-faint)]">{focus?.tag ?? "jarvis brokers agent work from here"}</div>
        </div>
      </div>
      <div className="min-w-0">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">70-day activity</div>
        <ActivityHeatmap extras={extras} />
      </div>
    </section>
  );
}
