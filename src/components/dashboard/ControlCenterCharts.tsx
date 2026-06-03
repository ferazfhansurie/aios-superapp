import type { AiosNotification } from "../../lib/notifications";
import type { MoneyAgentSummary } from "../../lib/moneyAgents";
import type { UsageExtras } from "../../lib/stats";
import { agentUrgency, formatRelativeRunAge } from "../../lib/controlCenter";

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function urgencyWidth(agent: MoneyAgentSummary) {
  const urgency = agentUrgency(agent);
  if (urgency === "critical") return 1;
  if (urgency === "control") return 0.76;
  if (urgency === "active") return 0.56;
  return 0.24;
}

export function ActivityHeatmap({ extras }: { extras: UsageExtras | null }) {
  const days = extras?.heatmap?.slice(-70) ?? [];
  const max = Math.max(1, ...days.map((day) => day.count));
  const cells = days.length ? days : Array.from({ length: 70 }, (_, index) => ({ date: `empty-${index}`, count: 0 }));

  return (
    <div className="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1" aria-label="70-day activity">
      {cells.map((day) => {
        const intensity = clamp01(day.count / max);
        return (
          <span
            key={day.date}
            title={`${day.date}: ${day.count}`}
            className="aspect-square rounded-[3px] border border-[var(--color-border)]"
            style={{
              background: intensity
                ? `color-mix(in srgb, var(--color-accent) ${18 + intensity * 62}%, transparent)`
                : "color-mix(in srgb, var(--color-border) 46%, transparent)",
            }}
          />
        );
      })}
    </div>
  );
}

export function TrendBars({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-16 items-end gap-1" aria-label="usage trend">
      {values.map((value, index) => (
        <span
          key={`${value}-${index}`}
          className="min-w-0 flex-1 rounded-t-sm bg-[var(--color-highlight)]/55"
          style={{ height: `${Math.max(8, (value / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

export function AgentRunTimeline({ agents }: { agents: MoneyAgentSummary[] }) {
  return (
    <div className="space-y-2" aria-label="agent run timeline">
      {agents.map((agent) => (
        <div key={agent.id} className="grid grid-cols-[112px_1fr_74px] items-center gap-2 text-[11px]">
          <span className="truncate text-[var(--color-muted)]">{agent.label}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]">
            <span
              className="block h-full rounded-full bg-[var(--color-accent)]"
              style={{ width: `${urgencyWidth(agent) * 100}%` }}
            />
          </span>
          <span className="text-right font-mono text-[10px] text-[var(--color-faint)]">
            {formatRelativeRunAge(agent.lastRunAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ApprovalAgingBars({ notifications }: { notifications: AiosNotification[] }) {
  const actionItems = notifications.filter((item) => !item.read && item.level !== "success").slice(0, 5);
  const now = Date.now();
  const values = actionItems.length ? actionItems : notifications.slice(0, 5);

  return (
    <div className="space-y-2" aria-label="approval aging">
      {values.map((item) => {
        const ageHours = Math.max(0.25, (now - item.at) / 3_600_000);
        const pct = Math.min(100, ageHours * 10);
        return (
          <div key={item.id} className="grid grid-cols-[1fr_54px] items-center gap-2 text-[11px]">
            <span className="truncate text-[var(--color-muted)]">{item.title}</span>
            <span className="h-1.5 rounded-full bg-[var(--color-border)]">
              <span className="block h-full rounded-full bg-[var(--color-warning)]" style={{ width: `${pct}%` }} />
            </span>
          </div>
        );
      })}
      {!values.length && <p className="text-[11px] text-[var(--color-faint)]">no approvals waiting.</p>}
    </div>
  );
}

export function ControlCenterCharts({
  agents,
  extras,
  notifications,
}: {
  agents: MoneyAgentSummary[];
  extras: UsageExtras | null;
  notifications: AiosNotification[];
}) {
  const heat = extras?.heatmap?.slice(-14).map((day) => day.count) ?? [2, 5, 3, 7, 8, 4, 6, 9, 7, 5, 8, 6, 4, 7];

  return (
    <section className="grid gap-4 border-t border-[var(--color-border)] pt-4 lg:grid-cols-[1.2fr_1fr_1fr]">
      <div className="min-w-0">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">70-day activity</div>
        <ActivityHeatmap extras={extras} />
      </div>
      <div className="min-w-0">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">agent run timeline</div>
        <AgentRunTimeline agents={agents} />
      </div>
      <div className="min-w-0">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">approval aging</div>
        <ApprovalAgingBars notifications={notifications} />
        <div className="mt-3">
          <TrendBars values={heat} />
        </div>
      </div>
    </section>
  );
}
