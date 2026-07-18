import { memo, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileOutput,
  GitBranch,
  Loader2,
  ShieldAlert,
  Wrench,
} from "lucide-react";

import { useSharedTicker } from "../../lib/ticker";
import type { RunActionProjection, RunReference } from "../../lib/runEvents";
import {
  buildTaskRailModel,
  type TaskRailAgentNode,
  type TaskRailInput,
} from "./taskRailState";

export interface TaskRailProps extends Omit<TaskRailInput, "now"> {
  defaultExpanded?: boolean;
  className?: string;
  onAgentOpen?: (agent: TaskRailAgentNode) => void;
  onReferenceOpen?: (reference: RunReference) => void;
}

function duration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusIcon(status: "running" | "waiting" | "done" | "failed", size = 13): ReactNode {
  if (status === "running") return <Loader2 size={size} className="animate-spin text-[var(--color-accent)]" />;
  if (status === "waiting") return <ShieldAlert size={size} className="text-[var(--color-accent)]" />;
  if (status === "failed") return <CircleAlert size={size} className="text-[var(--color-danger)]" />;
  return <Check size={size} className="text-[var(--color-success)]" />;
}

function actionStatus(action: RunActionProjection): "running" | "done" | "failed" {
  return action.status === "completed" ? "done" : action.status;
}

function ActionRow({ action }: { action: RunActionProjection }) {
  return (
    <li className="flex min-w-0 items-start gap-2 py-1">
      <span className="mt-0.5 shrink-0">{statusIcon(actionStatus(action), 12)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-[12px] font-medium text-[var(--color-text-2)]">{action.name}</span>
          {action.target && <span className="truncate font-mono text-[10.5px] text-[var(--color-muted)]">{action.target}</span>}
        </span>
        {action.status === "failed" && action.detail && (
          <span className="mt-0.5 block line-clamp-2 text-[10.5px] text-[var(--color-danger)]">{action.detail}</span>
        )}
      </span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--color-faint)]">{duration(action.durationMs)}</span>
    </li>
  );
}

function AgentBranch({ node, depth, onOpen }: {
  node: TaskRailAgentNode;
  depth: number;
  onOpen?: (agent: TaskRailAgentNode) => void;
}) {
  const [open, setOpen] = useState(node.status === "running");
  const hasDetail = node.children.length > 0 || node.actions.length > 0 || Boolean(node.lastLine);
  const activate = () => {
    if (node.paneKey && onOpen) onOpen(node);
    else if (hasDetail) setOpen((value) => !value);
  };
  return (
    <li>
      <button
        type="button"
        onClick={activate}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-[var(--color-hover)]"
        style={{ paddingLeft: `${6 + depth * 14}px` }}
      >
        {statusIcon(node.status === "done" ? "done" : node.status, 12)}
        <Bot size={12} className="shrink-0 text-[var(--color-muted)]" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-2)]">{node.label}</span>
        {node.lastLine && <span className="hidden max-w-[42%] truncate font-mono text-[10px] text-[var(--color-faint)] sm:block">{node.lastLine}</span>}
        {hasDetail && (open ? <ChevronDown size={12} className="text-[var(--color-faint)]" /> : <ChevronRight size={12} className="text-[var(--color-faint)]" />)}
      </button>
      {open && (
        <div style={{ paddingLeft: `${20 + depth * 14}px` }}>
          {node.actions.length > 0 && <ul>{node.actions.map((action) => <ActionRow key={action.id} action={action} />)}</ul>}
          {node.children.length > 0 && <ul>{node.children.map((child) => <AgentBranch key={child.id} node={child} depth={depth + 1} onOpen={onOpen} />)}</ul>}
        </div>
      )}
    </li>
  );
}

/** Mountable, thread-local run cockpit. It consumes the same normalized task
 * snapshot used by TaskWorkspace/FleetView; it never owns a parallel reducer. */
export const TaskRail = memo(function TaskRail({
  phase,
  events,
  agents,
  workflows,
  artifacts,
  defaultExpanded = false,
  className = "",
  onAgentOpen,
  onReferenceOpen,
}: TaskRailProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const live = phase !== "completed" && phase !== "failed" && phase !== "interrupted";
  useSharedTicker(1_000, live);
  const now = Date.now();
  const model = useMemo(
    () => buildTaskRailModel({ phase, events, agents, workflows, artifacts, now }),
    [phase, events, agents, workflows, artifacts, now],
  );
  const hasActivity = events.length > 0 || agents.length > 0 || workflows.length > 0 || artifacts.length > 0;
  if (!hasActivity) return null;

  return (
    <section className={`overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] backdrop-blur-md ${className}`} aria-label="run activity">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-hover)]"
      >
        <span className="shrink-0">{statusIcon(model.strip.status)}</span>
        <span className="shrink-0 text-[11px] font-medium capitalize text-[var(--color-text-2)]">{model.strip.phaseLabel}</span>
        {model.strip.currentAction && <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[var(--color-muted)]">{model.strip.currentAction}</span>}
        <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums text-[var(--color-faint)]">
          <Clock3 size={10} />{duration(model.strip.durationMs)}
        </span>
        {expanded ? <ChevronDown size={13} className="text-[var(--color-faint)]" /> : <ChevronRight size={13} className="text-[var(--color-faint)]" />}
      </button>

      {expanded && (
        <div className="border-t border-[var(--color-border-light)] px-3 py-2.5">
          {model.pendingApprovals > 0 && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/5 px-2.5 py-2 text-[11px] text-[var(--color-text-2)]">
              <ShieldAlert size={13} className="text-[var(--color-accent)]" />
              {model.pendingApprovals} approval{model.pendingApprovals === 1 ? "" : "s"} waiting
            </div>
          )}

          {model.actionGroups.map((group) => (
            <div key={group.kind} className="mb-2 last:mb-0">
              <div className="flex items-center gap-1.5 py-1 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-faint)]">
                <Wrench size={10} />{group.kind} · {group.actions.length}
              </div>
              <ul>{group.actions.filter((action) => !action.parentId).map((action) => <ActionRow key={action.id} action={action} />)}</ul>
            </div>
          ))}

          {model.agents.length > 0 && (
            <div className="mt-2 border-t border-[var(--color-border-light)] pt-2">
              <div className="flex items-center gap-1.5 px-1.5 py-1 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-faint)]"><Bot size={10} />agents</div>
              <ul>{model.agents.map((agent) => <AgentBranch key={agent.id} node={agent} depth={0} onOpen={onAgentOpen} />)}</ul>
            </div>
          )}

          {model.workflows.length > 0 && (
            <div className="mt-2 border-t border-[var(--color-border-light)] pt-2">
              {model.workflows.map((workflow) => (
                <div key={workflow.id} className="flex items-center gap-2 px-1.5 py-1.5 text-[12px] text-[var(--color-text-2)]">
                  <GitBranch size={12} className="text-[var(--color-accent)]" />
                  <span className="min-w-0 flex-1 truncate">{workflow.label}</span>
                  <span className="text-[10px] text-[var(--color-faint)]">{workflow.status}</span>
                </div>
              ))}
            </div>
          )}

          {model.references.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-[var(--color-border-light)] pt-2">
              {model.references.map((reference) => (
                <button
                  key={`${reference.type}:${reference.path}`}
                  type="button"
                  onClick={() => onReferenceOpen?.(reference)}
                  className="flex max-w-full items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 font-mono text-[10px] text-[var(--color-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-2)]"
                >
                  <FileOutput size={10} className="shrink-0" />
                  <span className="truncate">{reference.label ?? reference.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
});
