import { useEffect, useState } from "react";
import { ChevronRight, MessageSquare, Plus, RefreshCw, X } from "lucide-react";

import {
  createMoneyAgent,
  loadMoneyAgentSummaries,
  removeMoneyAgent,
  type MoneyAgentSummary,
} from "../lib/moneyAgents";

interface Props {
  iconsOnly?: boolean;
  embedded?: boolean;
  onOpenOverview: () => void;
  onOpenAgentChat: (id: string, label: string, command?: string) => void;
  agentChatStates?: Partial<Record<MoneyAgentSummary["id"], MoneyAgentChatState>>;
}

const COLLAPSE_KEY = "aios.moneyAgentsCollapsed";

export type MoneyAgentChatState = "open" | "running" | "saved" | "none";

function healthColor(health: MoneyAgentSummary["health"]): string {
  if (health === "running") return "var(--color-success)";
  if (health === "scheduled") return "var(--color-info)";
  if (health === "needs-steer") return "var(--color-warning)";
  if (health === "failed") return "var(--color-danger)";
  return "var(--color-faint)";
}

function chatStateLabel(state: MoneyAgentChatState): string {
  if (state === "open") return "attached";
  if (state === "running") return "running";
  if (state === "saved") return "resume";
  return "start";
}

function chatStateColor(state: MoneyAgentChatState): string {
  if (state === "open") return "var(--color-success)";
  if (state === "running") return "var(--color-warning)";
  if (state === "saved") return "var(--color-info)";
  return "var(--color-muted)";
}

export function MoneyAgentsSection({
  iconsOnly = false,
  embedded = false,
  onOpenOverview,
  onOpenAgentChat,
  agentChatStates = {},
}: Props) {
  const [summaries, setSummaries] = useState<MoneyAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftMission, setDraftMission] = useState("get sales for aios");
  const [draftSchedule, setDraftSchedule] = useState("daily");
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");

  const refresh = () => {
    setLoading(true);
    loadMoneyAgentSummaries()
      .then(setSummaries)
      .catch(() => setSummaries([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 20_000);
    return () => clearInterval(interval);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  };

  const open = (id: string, label: string) => onOpenAgentChat(id, label);
  const remove = (id: string) => {
    removeMoneyAgent(id);
    setSummaries((prev) => prev.filter((agent) => agent.id !== id));
  };
  const create = () => {
    const agent = createMoneyAgent({
      label: draftName,
      mission: draftMission,
      schedule: draftSchedule,
    });
    if (!agent) return;
    setDraftName("");
    setDraftMission("get sales for aios");
    setDraftSchedule("daily");
    setCreating(false);
    refresh();
    onOpenAgentChat(agent.id, agent.label);
  };
  // No defaults — the sidebar is empty until the user creates an agent.
  const rows = summaries;

  if (iconsOnly) {
    return (
      <div className="flex flex-col items-center gap-1 border-t border-[var(--color-border)] pt-2">
        <button
          type="button"
          onClick={onOpenOverview}
          className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="open agents"
        >
          <MessageSquare size={14} />
        </button>
        {!collapsed &&
          rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => open(row.id, row.label)}
              className="grid h-8 w-8 place-items-center rounded-md transition-colors hover:bg-[var(--color-panel-2)]"
              title={`${row.label} · ${row.currentJob}`}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: healthColor(row.health) }} />
            </button>
          ))}
      </div>
    );
  }

  const body = (
    <div className="flex flex-col gap-0.5">
      {creating && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
          className="mb-1 flex flex-col gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-pane)] p-2"
        >
          <input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="agent name"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <input
            value={draftMission}
            onChange={(event) => setDraftMission(event.target.value)}
            placeholder="mission"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <input
            value={draftSchedule}
            onChange={(event) => setDraftSchedule(event.target.value)}
            placeholder="schedule"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded px-2 py-1 text-[10px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              cancel
            </button>
            <button
              type="submit"
              className="rounded bg-[var(--color-accent)] px-2 py-1 text-[10px] font-medium text-[var(--color-bg)] disabled:opacity-50"
              disabled={!draftName.trim()}
            >
              create
            </button>
          </div>
        </form>
      )}
      {rows.length === 0 && !creating ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-2 text-left text-[10.5px] text-[var(--color-faint)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-muted)]"
        >
          no agents — click + to create one
        </button>
      ) : (
        rows.map((row) => (
          <AgentRow
            key={row.id}
            row={row}
            chatState={agentChatStates[row.id] ?? "none"}
            onOpen={() => open(row.id, row.label)}
            onRemove={() => remove(row.id)}
          />
        ))
      )}
    </div>
  );

  if (embedded) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-end gap-0.5">
          <button
            type="button"
            onClick={() => setCreating((value) => !value)}
            className="rounded p-1 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-accent)]"
            title="new chatpane agent"
          >
            <Plus size={12} />
          </button>
          <button
            type="button"
            onClick={refresh}
            className="rounded p-1 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title="refresh agents"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        {body}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)]"
          title={collapsed ? "show agents" : "hide agents"}
        >
          <ChevronRight size={11} className={`transition-transform ${collapsed ? "" : "rotate-90"}`} />
          agents
        </button>
        {!collapsed && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setCreating((value) => !value)}
              className="rounded p-1 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-accent)]"
              title="new chatpane agent"
            >
              <Plus size={12} />
            </button>
            <button
              type="button"
              onClick={refresh}
              className="rounded p-1 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              title="refresh agents"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        )}
      </div>
      {!collapsed && body}
    </div>
  );
}

function AgentRow({
  row,
  chatState,
  onOpen,
  onRemove,
}: {
  row: MoneyAgentSummary;
  chatState: MoneyAgentChatState;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const controlLabel = chatStateLabel(chatState);
  const controlColor = chatStateColor(chatState);
  return (
    <div className="group relative flex min-w-0 items-center rounded-md transition-colors hover:bg-[var(--color-panel-2)]">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
        title={`${controlLabel} ${row.label} chatpane · ${row.nextAction}`}
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: healthColor(row.health) }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
            {row.label}
          </span>
          <span className="block truncate font-mono text-[9.5px] text-[var(--color-faint)]">
            {row.currentJob}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[9.5px] text-[var(--color-muted)]">{row.primaryMetric}</span>
        <span
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-pane)] px-1.5 font-mono text-[9.5px]"
          style={{ color: controlColor }}
        >
          <MessageSquare size={10} />
          {controlLabel}
        </span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (confirm(`remove "${row.label}" agent? this clears its saved chat + schedule state.`)) onRemove();
        }}
        className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--color-faint)] opacity-0 transition-opacity hover:text-[var(--color-danger)] group-hover:opacity-100"
        title={`remove ${row.label}`}
      >
        <X size={12} />
      </button>
    </div>
  );
}
