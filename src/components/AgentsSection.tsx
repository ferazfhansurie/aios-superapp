/**
 * Persistent-agents sidebar — the user-facing CRUD + control surface for the
 * agents runtime (src/lib/agents.ts). Modeled on MoneyAgentsSection but for the
 * generic "any prompt, any model, persisted, run-now/stop" agents the spec asks
 * for. Pane/session machinery lives in App.tsx; this component is presentation +
 * the create form, and delegates open/stop/run-now/remove to props.
 */
import { useState } from "react";
import { ChevronRight, Play, Plus, Square, X } from "lucide-react";

import {
  createAgent,
  deleteAgent,
  listAgents,
  type AgentConfig,
} from "../lib/agents";
import { CHAT_MODELS, PERMISSION_MODES } from "../lib/chat";

/** Live/idle status, cross-referenced against live chat sessions by App. */
export type AgentLiveState = "live" | "idle";

interface Props {
  /** Re-render trigger: App bumps this when panes/liveChats change so status
   *  dots refresh. */
  version?: number;
  /** id → live (running a turn / backgrounded) vs idle. From App's liveChats. */
  liveStates?: Record<string, AgentLiveState>;
  /** Open (or reattach) the agent's chatpane. */
  onOpen: (agent: AgentConfig) => void;
  /** Run the agent now: re-send its prompt into its session (spawn if needed). */
  onRunNow: (agent: AgentConfig) => void;
  /** Stop the agent's live chat session (chat_stop). */
  onStop: (agent: AgentConfig) => void;
  /** Called after create so App can immediately materialize the chatpane. */
  onCreated: (agent: AgentConfig) => void;
}

const COLLAPSE_KEY = "aios.agentsCollapsed";

function statusColor(state: AgentLiveState): string {
  return state === "live" ? "var(--color-success)" : "var(--color-faint)";
}

export function AgentsSection({
  version,
  liveStates = {},
  onOpen,
  onRunNow,
  onStop,
  onCreated,
}: Props) {
  // `version` is read so React re-renders the (localStorage-backed) list when
  // App signals a change; listAgents() is synchronous so no effect needed.
  void version;
  const agents = listAgents();
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");

  const [draftLabel, setDraftLabel] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [draftModel, setDraftModel] = useState(CHAT_MODELS[0]?.id ?? "claude-opus-4-8");
  const [draftPerm, setDraftPerm] = useState(PERMISSION_MODES[0]?.id ?? "bypassPermissions");

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  };

  const resetDraft = () => {
    setDraftLabel("");
    setDraftPrompt("");
    setCreating(false);
  };

  const submit = () => {
    const model = CHAT_MODELS.find((m) => m.id === draftModel);
    const engine = model?.engine ?? "claude";
    const agent = createAgent({
      label: draftLabel,
      mission: draftPrompt,
      engine,
      model: draftModel,
      permissionMode: draftPerm,
      prompt: draftPrompt,
    });
    if (!agent) return;
    resetDraft();
    onCreated(agent);
  };

  const remove = (agent: AgentConfig) => {
    if (!confirm(`remove "${agent.label}" agent? this clears its saved config.`)) return;
    deleteAgent(agent.id);
    // force a re-render: toggle creating off (cheap state churn) — list reads
    // fresh from localStorage on next render.
    setCreating((c) => c);
    onStop(agent); // also stop any live session so it doesn't linger
  };

  const form = creating && (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="mb-1 flex flex-col gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-pane)] p-2"
    >
      <input
        autoFocus
        value={draftLabel}
        onChange={(e) => setDraftLabel(e.target.value)}
        placeholder="agent name (e.g. research-daily)"
        className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
      />
      <textarea
        value={draftPrompt}
        onChange={(e) => setDraftPrompt(e.target.value)}
        placeholder="prompt / mission (e.g. /last30days AI agents)"
        rows={2}
        className="resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
      />
      <div className="flex gap-1">
        <select
          value={draftModel}
          onChange={(e) => setDraftModel(e.target.value)}
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-[10.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        >
          {CHAT_MODELS.filter((m) => !m.disabled).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          value={draftPerm}
          onChange={(e) => setDraftPerm(e.target.value)}
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-[10.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        >
          {PERMISSION_MODES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={resetDraft}
          className="rounded px-2 py-1 text-[10px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
        >
          cancel
        </button>
        <button
          type="submit"
          className="rounded bg-[var(--color-accent)] px-2 py-1 text-[10px] font-medium text-[var(--color-bg)] disabled:opacity-50"
          disabled={!draftLabel.trim() || !draftPrompt.trim()}
        >
          create + run
        </button>
      </div>
    </form>
  );

  const body = (
    <div className="flex flex-col gap-0.5">
      {form}
      {agents.length === 0 && !creating ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-2 text-left text-[10.5px] text-[var(--color-faint)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-muted)]"
        >
          no agents — click + to create one
        </button>
      ) : (
        agents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            state={liveStates[agent.id] ?? "idle"}
            onOpen={() => onOpen(agent)}
            onRunNow={() => onRunNow(agent)}
            onStop={() => onStop(agent)}
            onRemove={() => remove(agent)}
          />
        ))
      )}
    </div>
  );

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
          <button
            type="button"
            onClick={() => setCreating((value) => !value)}
            className="rounded p-1 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-accent)]"
            title="new persistent agent"
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      {!collapsed && body}
    </div>
  );
}

function AgentRow({
  agent,
  state,
  onOpen,
  onRunNow,
  onStop,
  onRemove,
}: {
  agent: AgentConfig;
  state: AgentLiveState;
  onOpen: () => void;
  onRunNow: () => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  const modelShort = agent.model.replace(/^claude-/, "").replace(/^gpt-/, "gpt");
  return (
    <div className="group relative flex min-w-0 items-center rounded-md transition-colors hover:bg-[var(--color-panel-2)]">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
        title={`open ${agent.label} · ${agent.mission}`}
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor(state) }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
            {agent.label}
          </span>
          <span className="block truncate font-mono text-[9.5px] text-[var(--color-faint)]">
            {modelShort} · {agent.mission}
          </span>
        </span>
      </button>
      <div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {state === "live" ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onStop();
            }}
            className="grid h-6 w-6 place-items-center rounded text-[var(--color-faint)] hover:text-[var(--color-danger)]"
            title="stop"
          >
            <Square size={11} />
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRunNow();
            }}
            className="grid h-6 w-6 place-items-center rounded text-[var(--color-faint)] hover:text-[var(--color-success)]"
            title="run now"
          >
            <Play size={11} />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="grid h-6 w-6 place-items-center rounded text-[var(--color-faint)] hover:text-[var(--color-danger)]"
          title={`remove ${agent.label}`}
        >
          <X size={11} />
        </button>
      </div>
    </div>
  );
}
