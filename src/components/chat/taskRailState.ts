import type { Artifact } from "./toolPresentation.tsx";
import type { FleetAgent, FleetWorkflow } from "../../lib/subagentFleet.ts";
import {
  projectRun,
  type RunActionKind,
  type RunActionProjection,
  type RunEvent,
  type RunPhase,
  type RunReference,
} from "../../lib/runEvents.ts";

export interface TaskRailAgent extends FleetAgent {
  parentId?: string;
}

export interface TaskRailAgentNode extends TaskRailAgent {
  actions: RunActionProjection[];
  children: TaskRailAgentNode[];
}

export interface TaskRailActionGroup {
  kind: RunActionKind;
  actions: RunActionProjection[];
}

export interface TaskRailInput {
  phase: RunPhase;
  events: RunEvent[];
  agents: TaskRailAgent[];
  workflows: FleetWorkflow[];
  artifacts: Artifact[];
  now?: number;
}

export interface TaskRailModel {
  strip: {
    phaseLabel: string;
    currentAction?: string;
    status: "running" | "waiting" | "done" | "failed";
    durationMs: number;
  };
  actionGroups: TaskRailActionGroup[];
  agents: TaskRailAgentNode[];
  workflows: FleetWorkflow[];
  permissions: ReturnType<typeof projectRun>["permissions"];
  pendingApprovals: number;
  references: RunReference[];
}

function phaseStatus(phase: RunPhase): TaskRailModel["strip"]["status"] {
  if (phase === "waiting") return "waiting";
  if (phase === "failed" || phase === "interrupted") return "failed";
  if (phase === "completed") return "done";
  return "running";
}

export function buildTaskRailModel(input: TaskRailInput): TaskRailModel {
  const now = input.now ?? Date.now();
  const projection = projectRun(input.events, {
    phase: input.phase,
    now,
    artifacts: input.artifacts,
    agents: input.agents,
  });
  const pending = projection.permissions.filter((permission) => permission.status === "pending");
  const active = [...projection.actions].reverse().find((action) => action.status === "running");
  const currentAction = pending.length
    ? `approval needed · ${pending[pending.length - 1].toolName}`
    : active ? `${active.name} · ${active.target ?? "working"}` : undefined;
  const starts = [
    ...projection.actions.map((action) => action.startedAt),
    ...input.agents.map((agent) => agent.startedAt),
    ...input.workflows.map((workflow) => workflow.startedAt),
  ];
  const ends = [
    ...projection.actions.map((action) => action.endedAt ?? now),
    ...input.agents.map((agent) => agent.endedAt ?? now),
    ...input.workflows.map((workflow) => workflow.endedAt ?? now),
  ];

  const groupMap = new Map<RunActionKind, RunActionProjection[]>();
  for (const action of projection.actions) {
    const group = groupMap.get(action.kind) ?? [];
    group.push(action);
    groupMap.set(action.kind, group);
  }

  const nodes = new Map<string, TaskRailAgentNode>();
  input.agents.forEach((agent) => nodes.set(agent.id, {
    ...agent,
    actions: projection.actions.filter((action) => action.parentId === agent.id),
    children: [],
  }));
  const roots: TaskRailAgentNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return {
    strip: {
      phaseLabel: input.phase,
      ...(currentAction ? { currentAction } : {}),
      status: phaseStatus(input.phase),
      durationMs: starts.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : 0,
    },
    actionGroups: [...groupMap].map(([kind, actions]) => ({ kind, actions })),
    agents: roots,
    workflows: input.workflows,
    permissions: projection.permissions,
    pendingApprovals: pending.length,
    references: projection.references,
  };
}
