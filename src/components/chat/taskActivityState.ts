import type { FleetAgent, FleetWorkflow } from "../../lib/subagentFleet";

export type TaskActivityStatus = "started" | "updated" | "done" | "failed";

export interface TaskActivityItem {
  id: string;
  label: string;
  status: TaskActivityStatus;
  preview?: string;
  paneKey?: string;
  startedAt: number;
}

export function taskActivityItems(agents: FleetAgent[], workflows: FleetWorkflow[]): TaskActivityItem[] {
  const items: Array<TaskActivityItem & { index: number }> = [];
  agents.forEach((agent, index) => {
    items.push({
      id: agent.id,
      label: agent.label,
      status: agent.status === "done" ? "done" : agent.status === "failed" ? "failed" : agent.lastLine ? "updated" : "started",
      ...(agent.lastLine ? { preview: agent.lastLine } : {}),
      ...(agent.paneKey ? { paneKey: agent.paneKey } : {}),
      startedAt: agent.startedAt,
      index,
    });
  });
  workflows.forEach((workflow, index) => {
    items.push({
      id: workflow.id,
      label: workflow.label,
      status: workflow.status === "done" ? "done" : workflow.status === "failed" ? "failed" : workflow.description ? "updated" : "started",
      ...(workflow.description ? { preview: workflow.description } : {}),
      startedAt: workflow.startedAt,
      index: agents.length + index,
    });
  });
  return items.sort((left, right) => left.startedAt - right.startedAt || left.index - right.index).map(({ index: _index, ...item }) => item);
}
