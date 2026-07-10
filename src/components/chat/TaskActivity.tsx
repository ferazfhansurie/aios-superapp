import { memo, useMemo, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, CircleAlert, Loader2 } from "lucide-react";

import type { FleetAgent, FleetWorkflow } from "../../lib/subagentFleet";
import { taskActivityItems, type TaskActivityItem, type TaskActivityStatus } from "./taskActivityState";

export { taskActivityItems } from "./taskActivityState";

function StatusMark({ status }: { status: TaskActivityStatus }) {
  if (status === "done") return <Check size={13} className="text-[var(--color-success,#40c977)]" />;
  if (status === "failed") return <CircleAlert size={13} className="text-[var(--color-danger,#ff6764)]" />;
  if (status === "updated") return <Bot size={13} className="text-[var(--color-accent)]" />;
  return <Loader2 size={13} className="animate-spin text-[var(--color-accent)]" />;
}

export const TaskActivity = memo(function TaskActivity({
  agents,
  workflows,
}: {
  agents: FleetAgent[];
  workflows: FleetWorkflow[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const items = useMemo(() => taskActivityItems(agents, workflows), [agents, workflows]);
  if (items.length === 0) return null;

  const activate = (item: TaskActivityItem) => {
    if (item.paneKey) {
      window.dispatchEvent(new CustomEvent("aios-focus-pane", { detail: { key: item.paneKey } }));
      return;
    }
    setExpanded((current) => current === item.id ? null : item.id);
  };

  return (
    <section className="mx-auto w-full max-w-[760px] border-y border-white/[0.08] py-3" aria-label="task activity">
      <div className="mb-1 flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
        <Bot size={14} className="text-[var(--color-accent)]" />
        <span>{items.length} subagent{items.length === 1 ? "" : "s"}</span>
      </div>
      <div className="flex flex-col">
        {items.map((item) => {
          const open = expanded === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => activate(item)}
              className="flex min-w-0 items-start gap-2 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
            >
              <span className="mt-0.5 shrink-0"><StatusMark status={item.status} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-[var(--color-text-2)]">{item.label}</span>
                {item.preview && (
                  <span className={`block truncate text-[12px] ${open ? "whitespace-normal" : ""} text-[var(--color-faint)]`}>
                    {item.preview}
                  </span>
                )}
              </span>
              <span className="mt-0.5 shrink-0 text-[11px] text-[var(--color-faint)]">{item.status}</span>
              {!item.paneKey && (open ? <ChevronDown size={13} className="mt-0.5 text-[var(--color-faint)]" /> : <ChevronRight size={13} className="mt-0.5 text-[var(--color-faint)]" />)}
            </button>
          );
        })}
      </div>
    </section>
  );
});
