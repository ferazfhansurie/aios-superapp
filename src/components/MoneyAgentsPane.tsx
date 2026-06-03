import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { MessageSquare, RefreshCw, Target, TriangleAlert } from "lucide-react";

import {
  buildMoneyAgentRunCommand,
  loadMoneyAgentDetails,
  type MoneyAgentDetail,
} from "../lib/moneyAgents";

interface Props {
  onOpenAgentChat: (id: string, label: string, command?: string) => void;
}

function healthColor(health: MoneyAgentDetail["health"]): string {
  if (health === "running") return "var(--color-success)";
  if (health === "scheduled") return "var(--color-info)";
  if (health === "needs-steer") return "var(--color-warning)";
  if (health === "failed") return "var(--color-danger)";
  return "var(--color-faint)";
}

function healthLabel(health: MoneyAgentDetail["health"]): string {
  if (health === "needs-steer") return "needs steer";
  return health;
}

export function MoneyAgentsPane({ onOpenAgentChat }: Props) {
  const [agents, setAgents] = useState<MoneyAgentDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [steerAll, setSteerAll] = useState("");

  const refresh = () => {
    setLoading(true);
    setError(null);
    loadMoneyAgentDetails()
      .then(setAgents)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 20_000);
    return () => clearInterval(interval);
  }, []);

  const earning = agents.filter((agent) => agent.health === "running" || agent.health === "scheduled").length;
  const steer = agents.filter((agent) => agent.health === "needs-steer" || agent.health === "failed").length;
  const sendSteerAll = () => {
    const instruction = steerAll.trim();
    if (!instruction) return;
    for (const agent of agents) {
      onOpenAgentChat(
        agent.id,
        agent.label,
        [
          "agent control update from the aios shell:",
          instruction,
          "",
          "apply this to your operating plan for getting sales for aios.",
          "keep your chat history ordered, continue autonomously, and write a concise status entry for the shell control plane.",
        ].join("\n"),
      );
    }
    setSteerAll("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <div className="flex items-center gap-2">
          <Target size={14} className="text-[var(--color-success)]" />
          <span className="text-[13px] font-medium text-[var(--color-text)]">aios sales agents</span>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="refresh agents"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 border-b border-[var(--color-border)] p-3">
        <Metric label="active loops" value={earning} />
        <Metric label="needs steer" value={steer} warn={steer > 0} />
        <Metric label="agents" value={agents.length} />
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          sendSteerAll();
        }}
        className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] p-3"
      >
        <input
          value={steerAll}
          onChange={(event) => setSteerAll(event.target.value)}
          placeholder="control update for all agents"
          className="h-8 min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="submit"
          disabled={!steerAll.trim() || agents.length === 0}
          className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-[var(--color-accent)]/45 bg-[var(--color-accent-soft)] px-3 text-[12px] text-[var(--color-text)] transition-colors hover:border-[var(--color-accent)]/75 disabled:opacity-45"
        >
          <Target size={13} />
          send update
        </button>
      </form>

      {error && (
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 text-[12px] text-[var(--color-danger)]">
          <TriangleAlert size={13} />
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="grid gap-3 xl:grid-cols-2">
          {agents.map((agent) => (
            <section
              key={agent.id}
              className="min-w-0 rounded-[var(--aios-radius-lg)] border border-[var(--color-border)] bg-[var(--color-panel)] p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: healthColor(agent.health) }} />
                    <h2 className="truncate text-[15px] font-semibold text-[var(--color-text)]">{agent.label}</h2>
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-muted)]">{agent.mission}</p>
                </div>
                <span
                  className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px]"
                  style={{ borderColor: healthColor(agent.health), color: healthColor(agent.health) }}
                >
                  {healthLabel(agent.health)}
                </span>
              </div>

              <button
                type="button"
                onClick={() => onOpenAgentChat(agent.id, agent.label)}
                className="mt-3 inline-flex h-8 items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 text-[12px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-accent)]/45 hover:text-[var(--color-text)]"
                title={`talk to ${agent.label}`}
              >
                <MessageSquare size={13} />
                open chatpane
              </button>
              <button
                type="button"
                onClick={() => onOpenAgentChat(agent.id, agent.label, buildMoneyAgentRunCommand(agent))}
                className="ml-2 mt-3 inline-flex h-8 items-center gap-2 rounded-md border border-[var(--color-accent)]/45 bg-[var(--color-accent-soft)] px-3 text-[12px] text-[var(--color-text)] transition-colors hover:border-[var(--color-accent)]/75"
                title={`run ${agent.label} now`}
              >
                <Target size={13} />
                run sales pulse
              </button>

              <div className="mt-3 grid grid-cols-3 gap-2">
                <Fact label="metric" value={agent.primaryMetric} />
                <Fact label="schedule" value={agent.schedule} />
                <Fact label="agent" value={agent.id} icon={<MessageSquare size={11} />} />
              </div>

              <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/45 p-2">
                <div className="text-[10px] uppercase tracking-wider text-[var(--color-faint)]">current job</div>
                <div className="mt-1 text-[12.5px] text-[var(--color-text-2)]">{agent.currentJob}</div>
              </div>

              <div className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/45 p-2">
                <div className="text-[10px] uppercase tracking-wider text-[var(--color-faint)]">next steer</div>
                <div className="mt-1 text-[12.5px] text-[var(--color-text-2)]">{agent.nextAction}</div>
              </div>

              <details className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-pane)]">
                <summary className="cursor-pointer px-2 py-1.5 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)]">
                  state and evidence
                </summary>
                <div className="border-t border-[var(--color-border)] p-2">
                  <div className="mb-2 grid gap-1 font-mono text-[9.5px] text-[var(--color-faint)]">
                    <span>state: {agent.statePath}</span>
                    <span>queue: {agent.queuePath}</span>
                    <span>events: {agent.stdoutPath}</span>
                  </div>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/25 p-2 font-mono text-[10.5px] leading-relaxed text-[var(--color-text-2)]">
                    {agent.logTail.length ? agent.logTail.join("\n") : "no log tail available yet"}
                  </pre>
                </div>
              </details>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2">
      <div className={`text-[19px] font-semibold ${warn ? "text-[var(--color-warning)]" : "text-[var(--color-text)]"}`}>
        {value}
      </div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted)]">{label}</div>
    </div>
  );
}

function Fact({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/45 p-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--color-faint)]">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-[11px] text-[var(--color-text-2)]">{value}</div>
    </div>
  );
}
