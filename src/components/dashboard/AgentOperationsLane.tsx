import { Eye, Play, ShieldCheck } from "lucide-react";

import {
  agentRunLabel,
  agentUrgency,
  formatRelativeRunAge,
  summarizeAgentFleet,
} from "../../lib/controlCenter";
import { buildMoneyAgentRunCommand, type MoneyAgentSummary } from "../../lib/moneyAgents";

function urgencyWidth(agent: MoneyAgentSummary) {
  const urgency = agentUrgency(agent);
  if (urgency === "critical") return 1;
  if (urgency === "control") return 0.76;
  if (urgency === "active") return 0.56;
  return 0.24;
}

export function AgentOperationsLane({
  agents,
  onOpenOverview,
  onOpenAgent,
}: {
  agents: MoneyAgentSummary[];
  onOpenOverview: () => void;
  onOpenAgent: (id: string, label: string, command?: string) => void;
}) {
  const summary = summarizeAgentFleet(agents);

  return (
    <section className="border-t border-[var(--color-border)] pt-4">
      <div className="mb-3 flex items-center gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">agents</div>
          <div className="text-[12px] text-[var(--color-faint)]">
            {summary.runningOrScheduled} running · {summary.needsControl} need control · {summary.failed} failed
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenOverview}
          className="ml-auto rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-muted)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
        >
          control all
        </button>
      </div>
      <div className="grid gap-2 xl:grid-cols-3">
        {agents.map((agent) => {
          const urgency = urgencyWidth(agent);
          return (
            <article key={agent.id} className="min-w-0 border border-[var(--color-border)] bg-[var(--color-panel)]/30 p-3">
              <div className="mb-2 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-[var(--color-text)]">{agent.label}</div>
                  <div className="truncate text-[11px] text-[var(--color-faint)]">{agent.currentJob}</div>
                </div>
                <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-muted)]">
                  {agent.health}
                </span>
              </div>
              <div className="mb-3 h-1 rounded-full bg-[var(--color-border)]">
                <span className="block h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${urgency * 100}%` }} />
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <div className="text-[var(--color-faint)]">last run</div>
                  <div className="font-mono text-[var(--color-muted)]">{formatRelativeRunAge(agent.lastRunAt)}</div>
                </div>
                <div>
                  <div className="text-[var(--color-faint)]">schedule</div>
                  <div className="truncate text-[var(--color-muted)]">{agentRunLabel(agent)}</div>
                </div>
              </div>
              <div className="mt-3 truncate text-[11px] text-[var(--color-muted)]">{agent.nextAction}</div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpenAgent(agent.id, agent.label)}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-muted)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
                >
                  <Eye size={12} />
                  inspect
                </button>
                <button
                  type="button"
                  onClick={() => onOpenAgent(agent.id, agent.label, buildMoneyAgentRunCommand(agent))}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--color-accent)]/45 bg-[var(--color-accent)]/10 px-2 py-1 text-[11px] text-[var(--color-text)]"
                >
                  <Play size={12} />
                  run pulse
                </button>
                <ShieldCheck size={13} className="ml-auto text-[var(--color-muted)]" />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
