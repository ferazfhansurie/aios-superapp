/** Automations pane — Codex-"Automations"-inspired view of EVERYTHING AIOS runs
 *  in the background, at a glance.
 *
 *  Layout:
 *    header   — clock icon · "automations" · "{n} jobs · {m} live" · refresh
 *    sections — "scheduled jobs" (launchd) | "today's plan" (proactive, if any)
 *               | "live agents" (tmux aios-* sessions)
 *
 *  Each job row: status dot (green=running · dim=loaded-idle · red=failed exit),
 *  label (mono, prefix-stripped), schedule chip on the right, faint mono command
 *  truncated below. Live-agent rows: green dot if attached, name.
 *
 *  Backed by the Rust `list_automations` command. Polls every 15s. */
import { useCallback, useEffect, useState } from "react";

import { Activity, Calendar, Clock, Cpu, RefreshCw, Zap } from "lucide-react";

import { listAutomations, type Automations, type Job } from "../lib/automations";

/** Strips the noisy launchd prefix so labels read cleanly. */
function shortLabel(label: string): string {
  return label
    .replace(/^com\.firaz\.aios-/, "")
    .replace(/^com\.aios\./, "");
}

/** status-dot variant for a job: failed (red) > running (green) > idle (dim). */
function jobDotClass(job: Job): string {
  if (job.last_exit !== 0) return "status-dot--idle";
  if (job.running) return "status-dot--active";
  return "status-dot--cold";
}

export function AutomationsPane() {
  const [data, setData] = useState<Automations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const a = await listAutomations();
      setData(a);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const jobs = data?.jobs ?? [];
  const planned = data?.planned ?? [];
  const agents = data?.agents ?? [];
  const liveAgents = agents.filter((a) => a.attached).length;
  const empty =
    !loading && data && jobs.length === 0 && planned.length === 0 && agents.length === 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-bg)] text-[13px] text-[var(--color-text)]">
      {/* header */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2.5 text-[var(--color-muted)]">
        <Clock size={13} className="text-[var(--color-accent)]" />
        <span className="font-mono text-[11px] lowercase">automations</span>
        {data && (
          <span className="text-[11px] text-[var(--color-faint)]">
            {jobs.length} jobs · {liveAgents} live
          </span>
        )}
        <button
          onClick={() => load()}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          refresh
        </button>
      </div>

      {error && (
        <p className="px-3 py-2 text-[12px] text-[var(--color-danger)]">{error}</p>
      )}
      {loading && !data && (
        <p className="px-3 py-2 text-[12px] text-[var(--color-muted)]/70">scanning…</p>
      )}
      {empty && (
        <div className="flex h-full items-center justify-center text-[12px] text-[var(--color-muted)]/60">
          nothing running in the background
        </div>
      )}

      {/* body */}
      {data && !empty && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2.5">
          {/* (1) scheduled jobs */}
          <Section icon={<Zap size={12} />} title="scheduled jobs" count={jobs.length}>
            {jobs.length === 0 ? (
              <Empty>no launchd jobs</Empty>
            ) : (
              <div className="flex flex-col gap-1">
                {jobs.map((job) => (
                  <JobRow key={job.label} job={job} />
                ))}
              </div>
            )}
          </Section>

          {/* (2) today's plan — only when the planner left items */}
          {planned.length > 0 && (
            <Section
              icon={<Calendar size={12} />}
              title="today's plan"
              count={planned.length}
            >
              <div className="flex flex-col gap-1">
                {planned.map((item, i) => (
                  <div
                    key={`${item.time}-${i}`}
                    className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-1.5"
                  >
                    <span className="mt-px shrink-0 rounded bg-[var(--color-accent-soft)] px-1.5 py-px font-mono text-[10px] text-[var(--color-accent)]">
                      {item.time || "—"}
                    </span>
                    <span className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--color-text-2)]">
                      {item.title || "(untitled)"}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* (3) live agents */}
          <Section icon={<Cpu size={12} />} title="live agents" count={agents.length}>
            {agents.length === 0 ? (
              <Empty>no background sessions</Empty>
            ) : (
              <div className="flex flex-col gap-1">
                {agents.map((agent) => (
                  <div
                    key={agent.name}
                    className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-1.5"
                  >
                    <span
                      className={`status-dot ${agent.attached ? "status-dot--active" : "status-dot--cold"}`}
                    />
                    <span className="truncate font-mono text-[12px] text-[var(--color-text)]">
                      {agent.name.replace(/^aios-/, "")}
                    </span>
                    {agent.attached && (
                      <span className="ml-auto flex items-center gap-1 text-[10px] text-[var(--color-success)]">
                        <Activity size={10} />
                        attached
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

/** A titled section card with a count badge. */
function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 px-0.5 text-[var(--color-faint)]">
        <span className="text-[var(--color-accent)]">{icon}</span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
          {title}
        </span>
        <span className="text-[10px] text-[var(--color-faint)]">{count}</span>
      </div>
      {children}
    </div>
  );
}

/** One launchd job row. */
function JobRow({ job }: { job: Job }) {
  const failed = job.last_exit !== 0;
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span
          className={`status-dot shrink-0 ${jobDotClass(job)}`}
          style={failed ? { background: "var(--color-danger)", opacity: 1 } : undefined}
          title={failed ? `last exit ${job.last_exit}` : job.running ? "running" : "loaded · idle"}
        />
        <span className="truncate font-mono text-[12px] text-[var(--color-text)]">
          {shortLabel(job.label)}
        </span>
        <span className="ml-auto shrink-0 rounded bg-[var(--color-panel-2)] px-1.5 py-px font-mono text-[10px] text-[var(--color-text-2)]">
          {job.schedule}
        </span>
      </div>
      {job.command && (
        <p className="mt-0.5 truncate pl-4 font-mono text-[10px] text-[var(--color-faint)]">
          {job.command}
        </p>
      )}
      {failed && (
        <p className="mt-0.5 pl-4 font-mono text-[10px] text-[var(--color-danger)]">
          exit {job.last_exit}
        </p>
      )}
    </div>
  );
}

/** Faint empty-state line inside a section. */
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-0.5 py-1 text-[11px] text-[var(--color-muted)]/50">{children}</p>
  );
}
