import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Bot, FilePlus2, Image, Link2, PackageOpen, Plus } from "lucide-react";

import type { Artifact } from "./toolPresentation";
import type { FleetAgent, FleetWorkflow } from "../../lib/subagentFleet";
import { getTaskWorkspace, subscribeTaskWorkspace, type TaskId } from "../../lib/taskWorkspace";
import type { ChatModel } from "../../lib/chat";
import { claudeRate, type ClaudeRate } from "../../lib/dashboard";
import { aiosRoles } from "../../lib/aiosRouter";
import { AiosMark, ModelIcon } from "./modelIcons";

export interface TaskSource {
  path: string;
  label: string;
}

/**
 * Compact, pinned task cockpit for a conversation. It deliberately consumes
 * already-normalized artifacts, fleet, and source attachments: no transcript
 * parsing or backend state lives here, keeping the streaming path cheap.
 */
export const TaskSummary = memo(function TaskSummary({
  taskId,
  model,
  aiosRouted,
  artifacts,
  agents,
  workflows,
  sources,
  onCreateOutput,
  onOpenArtifact,
  onOpenSource,
  onShowAgents,
}: {
  taskId?: TaskId;
  /** the pane's live (concrete) model — drives the router section. */
  model: ChatModel;
  /** route reason when the session was picked by aios, null = manual pick. */
  aiosRouted: string | null;
  artifacts: Artifact[];
  agents: FleetAgent[];
  workflows: FleetWorkflow[];
  sources: TaskSource[];
  onCreateOutput: () => void;
  onOpenArtifact: (artifact: Artifact) => void;
  onOpenSource: (source: TaskSource) => void;
  onShowAgents: () => void;
}) {
  const [showAllSources, setShowAllSources] = useState(false);
  // `getTaskWorkspace` returns a defensive clone, so use a scalar version for
  // useSyncExternalStore and read the durable snapshot once per change.
  const subscribe = useCallback((listener: () => void) => taskId ? subscribeTaskWorkspace(taskId, listener) : () => {}, [taskId]);
  const getVersion = useCallback(() => taskId ? getTaskWorkspace(taskId)?.updatedAt ?? 0 : 0, [taskId]);
  const version = useSyncExternalStore(subscribe, getVersion, () => 0);
  const workspace = useMemo(() => taskId ? getTaskWorkspace(taskId) : null, [taskId, version]);
  const durableArtifacts = workspace?.artifacts ?? artifacts;
  const durableAgents = workspace?.agents ?? agents;
  const durableWorkflows = workspace?.workflows ?? workflows;
  const complete = durableAgents.filter((agent) => agent.status !== "running").length;
  const active = durableAgents.length - complete + durableWorkflows.filter((workflow) => workflow.status === "running").length;
  const shownSources = showAllSources ? sources : sources.slice(0, 2);
  const artifactRows = useMemo(() => durableArtifacts.slice(-2).reverse(), [durableArtifacts]);

  return (
    <aside className="shell-card shell-elevated w-full max-w-[360px] p-5">
      <RouterSection model={model} aiosRouted={aiosRouted} />

      <SummarySection title="outputs" icon={<PackageOpen size={15} />} onAdd={onCreateOutput}>
        {artifactRows.length === 0 ? (
          <button
            type="button"
            onClick={onCreateOutput}
            className="-mx-1 flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-[15px] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-text)]"
          >
            <FilePlus2 size={16} /> create a file or site
          </button>
        ) : (
          artifactRows.map((artifact) => (
            <button
              type="button"
              key={artifact.path}
              onClick={() => onOpenArtifact(artifact)}
              className="-mx-1 flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-[14px] text-[var(--color-text-2)] transition-colors hover:bg-[var(--color-hover)]"
            >
              <PackageOpen size={15} className="shrink-0 text-[var(--color-accent)]" />
              <span className="truncate">{artifact.name}</span>
            </button>
          ))
        )}
      </SummarySection>

      <SummarySection title="subagents" icon={<Bot size={16} />}>
        {durableAgents.length + durableWorkflows.length === 0 ? (
          <p className="px-1 py-1 text-[14px] text-[var(--color-muted)]">no subagents yet</p>
        ) : (
          <button
            type="button"
            onClick={onShowAgents}
            className="-mx-1 flex items-center gap-2 rounded-lg px-1 py-1 text-left text-[15px] text-[var(--color-text-2)] transition-colors hover:bg-[var(--color-hover)]"
          >
            <span className="flex -space-x-1.5" aria-hidden="true">
              {durableAgents.slice(0, 4).map((agent) => (
                <span
                  key={agent.id}
                  className={`grid h-5 w-5 place-items-center rounded-full border border-[var(--color-panel)] text-[10px] ${
                    agent.status === "failed"
                      ? "bg-[color-mix(in_srgb,var(--color-danger-accent)_30%,transparent)] text-[var(--color-danger-accent)]"
                      : agent.status === "running"
                        ? "bg-[var(--color-accent)]/35 text-[var(--color-accent)]"
                        : "bg-[color-mix(in_srgb,var(--color-success-accent)_25%,transparent)] text-[var(--color-success-accent)]"
                  }`}
                >
                  {agent.status === "running" ? "•" : "✓"}
                </span>
              ))}
            </span>
            <span>{active > 0 ? `${active} active` : `${complete} done`}</span>
          </button>
        )}
      </SummarySection>

      <SummarySection title="sources" icon={<Image size={16} />} onAdd={onCreateOutput} last>
        {shownSources.length === 0 ? (
          <p className="px-1 py-1 text-[14px] text-[var(--color-muted)]">add screenshots, files, or links</p>
        ) : (
          <div className="flex flex-col gap-1">
            {shownSources.map((source) => (
              <button
                type="button"
                key={source.path}
                onClick={() => onOpenSource(source)}
                className="-mx-1 flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-[14px] text-[var(--color-text-2)] transition-colors hover:bg-[var(--color-hover)]"
              >
                <Image size={16} className="shrink-0 text-[var(--color-muted)]" />
                <span className="truncate">{source.label}</span>
              </button>
            ))}
            {sources.length > 2 && (
              <button
                type="button"
                onClick={() => setShowAllSources((shown) => !shown)}
                className="-mx-1 flex items-center gap-2 rounded-lg px-1 py-1 text-[14px] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-text)]"
              >
                <Link2 size={16} /> {showAllSources ? "show less" : `view all · ${sources.length}`}
              </button>
            )}
          </div>
        )}
      </SummarySection>
    </aside>
  );
});

/** The model-architecture view: who runs this session, what routes where, and
 *  the live meters the router decides on. Self-contained polling (60s, only
 *  while the panel is open) so the streaming path stays untouched. */
function RouterSection({ model, aiosRouted }: { model: ChatModel; aiosRouted: string | null }) {
  const [claude, setClaude] = useState<ClaudeRate | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = () => {
      void claudeRate().then((r) => alive && setClaude(r)).catch(() => {});
    };
    pull();
    const timer = window.setInterval(pull, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const roles = aiosRoles();

  const meter = (label: string, pct: number | null, extra?: ReactNode) => (
    <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--color-muted)]">
      <span className="w-16 shrink-0">{label}</span>
      <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--color-panel-2)]">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-accent)]/70"
          style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
        />
      </span>
      <span className="w-9 shrink-0 text-right">{pct != null ? `${Math.round(pct)}%` : "—"}</span>
      {extra}
    </div>
  );

  return (
    <SummarySection title="aios router" icon={<AiosMark size={15} />}>
      <div className="flex flex-col gap-2 px-1 py-1">
        {/* who is running THIS session */}
        <div
          className="flex items-center gap-2 text-[14px] text-[var(--color-text-2)]"
          title={aiosRouted ?? undefined}
        >
          {aiosRouted ? <AiosMark size={14} /> : <ModelIcon model={model} size={14} />}
          <span className="truncate">
            {aiosRouted ? (
              <>
                aios <span className="text-[var(--color-faint)]">→</span> {model.label}
              </>
            ) : (
              <>{model.label} · manual pick</>
            )}
          </span>
        </div>
        {aiosRouted && (
          <p className="text-[11.5px] leading-snug text-[var(--color-muted)]">{aiosRouted}</p>
        )}

        {/* the architecture — which model does what */}
        <div className="mt-1 flex flex-col gap-1 text-[12.5px] text-[var(--color-muted)]">
          {(
            [
              [roles.main, "claude code", "gpt via claude code below 100%"],
              [roles.main, "native", "native codex at claude 100%"],
              [roles.bulk, "manual", "heavy work · use bulk"],
            ] as const
          ).map(([m, role, what]) => (
            <div key={role} className="flex items-center gap-2">
              <ModelIcon model={m} size={13} />
              <span className="text-[var(--color-text-2)]">{m.label}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
                {role}
              </span>
              <span className="ml-auto text-[11px] text-[var(--color-faint)]">
                {what}
              </span>
            </div>
          ))}
        </div>

        {/* live meters the router decides on */}
        <div className="mt-1 flex flex-col gap-1">
          {meter("claude 5h", claude?.fiveHour.pct ?? null)}
          {meter("claude 7d", claude?.sevenDay.pct ?? null)}
        </div>
      </div>
    </SummarySection>
  );
}

function SummarySection({
  title,
  icon,
  onAdd,
  last = false,
  children,
}: {
  title: string;
  icon: ReactNode;
  onAdd?: () => void;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={last ? "" : "mb-4 border-b border-[var(--color-border-light)] pb-4"}>
      <div className="mb-2 flex items-center gap-2 text-[15px] font-medium text-[var(--color-muted)]">
        <span className="text-[var(--color-faint)]">{icon}</span>
        <span>{title}</span>
        {onAdd && (
          <button
            type="button"
            title={`add ${title}`}
            onClick={onAdd}
            className="ml-auto grid h-6 w-6 place-items-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-text)]"
          >
            <Plus size={18} />
          </button>
        )}
      </div>
      {children}
    </section>
  );
}
