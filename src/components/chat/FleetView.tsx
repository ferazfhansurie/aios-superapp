/**
 * Live sub-agent fleet view — surfaces the Task-tool sub-agents the chat model
 * spawns mid-turn (claude Task tools, codex-visible `aios-agent` worker panes,
 * or agent-like codex tool calls), plus any `Workflow`-tool phase-tree runs it launches. Modelled on Claude Code's own
 * TERMINAL agent presentation: a clean VERTICAL LIST, one readable row per
 * agent — status glyph + `✶ <type> · <task>` identity, a live status line
 * (`working… (Xm Ys · N.Nk tokens)`), and a dim latest-action line. Clicking a
 * row expands its fuller live output. Additive: the parent only mounts this when
 * the fleet is non-empty, so a turn with no sub-agents/workflows shows nothing.
 *
 * On-brand per firaz's design direction (restraint + status/identity color +
 * apple glass): neutral glass surfaces, color carries meaning only — running =
 * accent (live), done = success green, failed = danger red. Brand orange is the
 * live-accent only, never decoration. Spinner is pure-CSS (tailwind animate-spin
 * on a thin ring) — no animation loops in JS. A single 1s ticking interval
 * advances the elapsed clocks while ≥1 agent is still running, then stops.
 */
import { memo, useCallback, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, ExternalLink, GitBranch, Sparkle, X } from "lucide-react";
import type {
  FleetAgent,
  FleetStatus,
  FleetWorkflow,
} from "../../lib/subagentFleet";
import { useSharedTicker } from "../../lib/ticker";

function statusColor(status: FleetStatus | "running" | "done" | "failed"): string {
  switch (status) {
    case "done":
      return "var(--color-success,#4ade80)";
    case "failed":
      return "var(--color-danger,#fca5a5)";
    default:
      return "var(--color-accent)";
  }
}

/** Status glyph — a pure-CSS spinning ring while running, a check/cross once
 *  resolved. The ring is a bordered circle with one accent edge, spun by
 *  tailwind's animate-spin (CSS keyframes, no JS loop). */
function StatusGlyph({ status }: { status: FleetStatus }) {
  if (status === "running") {
    return (
      <span
        aria-label="running"
        className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-white/15"
        style={{ borderTopColor: "var(--color-accent)" }}
      />
    );
  }
  if (status === "failed") {
    return <X size={12} className="shrink-0 text-[var(--color-danger,#fca5a5)]" />;
  }
  return <Check size={12} className="shrink-0 text-[var(--color-success,#4ade80)]" />;
}

function statusWord(status: FleetStatus): string {
  return status === "running" ? "working…" : status === "failed" ? "failed" : "done";
}

export function FleetView({
  agents,
  workflows = [],
}: {
  agents: FleetAgent[];
  workflows?: FleetWorkflow[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const anyRunning =
    agents.some((a) => a.status === "running") ||
    workflows.some((w) => w.status === "running");
  // Advance elapsed clocks on the shared 1Hz ticker, only while something runs.
  useSharedTicker(1000, anyRunning);
  const now = Date.now();

  // Stable identities so memoized rows don't re-render just because the parent did.
  const toggle = useCallback(
    (id: string) => setExpanded((cur) => (cur === id ? null : id)),
    [],
  );
  // Clicking an agent: focus its live worker pane if it has one, else expand the
  // inline detail. (Worker panes exist for AIOS `agent:` panes; claude Task
  // sub-agents have no separate pane yet, so they expand in place.)
  const onActivate = useCallback((agent: FleetAgent) => {
    if (agent.paneKey) {
      window.dispatchEvent(
        new CustomEvent("aios-focus-pane", { detail: { key: agent.paneKey } }),
      );
      return;
    }
    setExpanded((cur) => (cur === agent.id ? null : agent.id));
  }, []);

  // Derived counts scan the whole list — memoize so the 1Hz tick / per-frame
  // fleet churn doesn't recompute filters every render.
  const summary = useMemo(() => fleetSummary(agents), [agents]);
  const doneCount = useMemo(
    () => agents.filter((a) => a.status !== "running").length,
    [agents],
  );
  const total = agents.length;

  if (agents.length === 0 && workflows.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 rounded-xl border border-white/10 bg-white/[0.035] px-1.5 py-1.5 backdrop-blur-md">
      {/* header — tap to collapse the whole fleet so it never crowds the chat */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-left font-sans text-[11px] text-[var(--color-muted)] transition-colors hover:bg-white/[0.03]"
      >
        <Sparkle size={11} className="shrink-0 text-[var(--color-accent)]" />
        <span className="shrink-0 font-medium text-[var(--color-text-2)]">
          {total > 0 ? `${total} agent${total === 1 ? "" : "s"}` : "workflow"}
        </span>
        <span className="truncate text-[var(--color-faint)]">· {summary}</span>
        <span className="flex-1" />
        {total > 1 && (
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="h-1 w-14 overflow-hidden rounded-full bg-white/10">
              <span
                className="block h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500"
                style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }}
              />
            </span>
            <span className="font-mono text-[9.5px] tabular-nums text-[var(--color-faint)]">
              {doneCount}/{total}
            </span>
          </span>
        )}
        <ChevronDown
          size={13}
          className={`shrink-0 text-[var(--color-faint)] transition-transform ${
            collapsed ? "-rotate-90" : ""
          }`}
        />
      </button>

      {!collapsed && (
        <>
          {/* vertical agent list — running rows pop, settled rows recede */}
          <div className="flex flex-col gap-px">
            {agents.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                // settled rows get a FROZEN clock (their endedAt) so the 1Hz
                // tick can't invalidate their memo — only still-running rows
                // re-render each second.
                now={a.endedAt ?? now}
                expanded={expanded === a.id}
                onActivate={onActivate}
              />
            ))}
          </div>

          {/* workflow runs (the /workflows phase-tree fan-out) */}
          {workflows.map((w) => (
            <WorkflowRow
              key={w.id}
              workflow={w}
              now={w.endedAt ?? now}
              expanded={expanded === w.id}
              onToggle={toggle}
            />
          ))}
        </>
      )}
    </div>
  );
}

const AgentRow = memo(function AgentRow({
  agent,
  now,
  expanded,
  onActivate,
}: {
  agent: FleetAgent;
  now: number;
  expanded: boolean;
  onActivate: (agent: FleetAgent) => void;
}) {
  const running = agent.status === "running";
  const color = statusColor(agent.status);
  const elapsed = (agent.endedAt ?? now) - agent.startedAt;
  const type = agent.subagentType ?? "agent";
  return (
    <div
      className={`group rounded-lg transition-[background-color,opacity] hover:bg-white/[0.03] ${
        running ? "" : "opacity-55 hover:opacity-100"
      }`}
    >
      <button
        type="button"
        onClick={() => onActivate(agent)}
        title={agent.paneKey ? "open worker pane" : expanded ? "hide detail" : "show detail"}
        className="flex w-full items-center gap-2 px-1.5 py-1 text-left"
      >
        <StatusGlyph status={agent.status} />
        {/* type tag — restraint: neutral mono tag, status color only while live */}
        <span
          className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.04em]"
          style={{ color: running ? color : "var(--color-faint)" }}
        >
          {type}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-sans text-[12.5px] leading-tight text-[var(--color-text-2)]">
            {agent.label}
          </span>
          {/* live action line — only while running, so settled rows stay one line */}
          {running && agent.lastLine && (
            <span className="mt-0.5 block truncate font-mono text-[10px] leading-tight text-[var(--color-faint)]">
              {agent.lastLine}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--color-faint)]">
          {fmtDur(elapsed)}
          {agent.tokens != null ? ` · ${fmtTokens(agent.tokens)}` : ""}
        </span>
        {agent.paneKey ? (
          <ExternalLink
            size={11}
            className="shrink-0 text-[var(--color-faint)] opacity-0 transition-opacity group-hover:text-[var(--color-accent)] group-hover:opacity-100"
          />
        ) : (
          <ChevronRight
            size={12}
            className={`shrink-0 text-[var(--color-faint)] transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
          />
        )}
      </button>
      {/* inline detail — claude Task agents have no separate pane, so the expand
          surfaces their full label + meta + latest output rather than nothing */}
      {expanded && !agent.paneKey && (
        <div className="mx-1.5 mb-1.5 mt-0.5 rounded-md border border-white/[0.08] bg-black/20 px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10px] text-[var(--color-faint)]">
            <span style={running ? { color } : undefined}>{statusWord(agent.status)}</span>
            <span>·</span>
            <span>{fmtDur(elapsed)}</span>
            {agent.tokens != null && (
              <>
                <span>·</span>
                <span>{fmtTokens(agent.tokens)} tokens</span>
              </>
            )}
            <span>·</span>
            <span>{type}</span>
          </div>
          {agent.lastLine ? (
            <div className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--color-muted)]">
              {agent.lastLine}
            </div>
          ) : (
            <div className="mt-1.5 font-sans text-[11px] italic text-[var(--color-faint)]">
              no output captured yet
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const WorkflowRow = memo(function WorkflowRow({
  workflow,
  now,
  expanded,
  onToggle,
}: {
  workflow: FleetWorkflow;
  now: number;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const color = statusColor(workflow.status);
  const elapsed = (workflow.endedAt ?? now) - workflow.startedAt;
  return (
    <div className="rounded-lg border border-white/10 bg-[var(--color-bg)]/40 px-1.5 py-1.5">
      <button
        type="button"
        onClick={() => onToggle(workflow.id)}
        className="flex w-full items-start gap-2 text-left"
      >
        <GitBranch size={12} className="mt-[3px] shrink-0" style={{ color }} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 font-sans text-[12px]">
            <span className="shrink-0 font-medium" style={{ color }}>
              workflow
            </span>
            <span className="truncate text-[var(--color-text-2)]">{workflow.label}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[10.5px] text-[var(--color-faint)]">
            <span style={workflow.status === "running" ? { color } : undefined}>
              {workflow.status === "running"
                ? "running in background"
                : workflow.status === "failed"
                  ? "launch failed"
                  : "done"}
            </span>
            <span>
              ({fmtDur(elapsed)}
              {workflow.phases.length > 0
                ? ` · ${workflow.phases.length} phase${workflow.phases.length === 1 ? "" : "s"}`
                : ""}
              )
            </span>
          </span>
        </span>
        <ChevronRight
          size={12}
          className={`mt-1 shrink-0 text-[var(--color-faint)] transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </button>

      {/* phase tree — declared phases from the script's meta. Per-phase / per-
          agent LIVE progress is NOT observable from this stream (the run is a
          background process writing to a separate transcript), so we surface the
          DECLARED phases and point at /workflows for live progress. */}
      {expanded && (
        <div className="mt-1.5 flex flex-col gap-1 pl-[18px]">
          {workflow.description && (
            <p className="font-sans text-[11px] leading-relaxed text-[var(--color-muted)]">
              {workflow.description}
            </p>
          )}
          {workflow.phases.length > 0 ? (
            <ol className="flex flex-col gap-0.5">
              {workflow.phases.map((p, i) => (
                <li
                  key={`${p.title}-${i}`}
                  className="flex items-baseline gap-1.5 font-sans text-[11px]"
                >
                  <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">
                    {i + 1}.
                  </span>
                  <span className="text-[var(--color-text-2)]">{p.title}</span>
                  {p.detail && (
                    <span className="truncate text-[var(--color-faint)]">
                      · {p.detail}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="font-sans text-[11px] italic text-[var(--color-faint)]">
              no declared phases
            </p>
          )}
          <p className="font-sans text-[10.5px] italic leading-relaxed text-[var(--color-faint)]">
            live phase progress runs in the background — watch it with /workflows
            {workflow.runId ? ` (${workflow.runId})` : ""}.
          </p>
        </div>
      )}
    </div>
  );
});

function fleetSummary(agents: FleetAgent[]): string {
  const running = agents.filter((a) => a.status === "running").length;
  const done = agents.filter((a) => a.status === "done").length;
  const failed = agents.filter((a) => a.status === "failed").length;
  const parts: string[] = [];
  if (running) parts.push(`${running} running`);
  if (done) parts.push(`${done} done`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(" · ") || (agents.length ? `${agents.length}` : "");
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalS = Math.floor(ms / 1000);
  if (totalS < 60) return `${totalS}s`;
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}m ${s}s`;
}
