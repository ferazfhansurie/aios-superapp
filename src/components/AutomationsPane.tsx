/** Automations — everything AIOS runs on its own, as a dense status board.
 *
 * Research-backed redesign (cronitor / healthchecks / airflow / k9s / pm2 /
 * datadog): the two failure modes are split — ALWAYS-ON daemons (healthy ==
 * alive) vs SCHEDULED jobs (healthy == fired on time) — because they want
 * different columns. State is encoded ONCE as a left-edge dot (color + fill
 * shape, not hue alone), never as the repeated word "running" on every row. A
 * pill shows ONLY on a broken row (with its exit code), so the eye lands on
 * problems. Failed sorts to the top of each group. Times are mono + relative
 * ("fired 2h ago"). Rows are tight (single line) and expand in place for the
 * command, log tail, and run / enable controls.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ChevronRight,
  Clock,
  Cpu,
  FileText,
  Play,
  Power,
  RefreshCw,
  Zap,
} from "lucide-react";

import {
  automationDetail,
  listAutomations,
  runAutomation,
  setAutomationEnabled,
  type Agent,
  type Automations,
  type Job,
  type JobDetail,
} from "../lib/automations";

// ── label → human helpers ──────────────────────────────────────────────────────

/** Strip the noise prefix and turn `nightly-planner` → `Nightly planner`. */
function friendlyName(label: string): string {
  const base = label.replace(/^com\.(firaz\.)?aios-?/, "").replace(/^com\.aios\.?/, "");
  const words = base.replace(/[._]/g, "-").split("-").filter(Boolean);
  if (words.length === 0) return label;
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

/** Best-effort plain-English "what it does" from keywords in the label. */
function describe(label: string): string {
  const l = label.toLowerCase();
  const map: [RegExp, string][] = [
    [/nightly|planner|plan/, "plans tomorrow's nudges & interventions"],
    [/daily-brief|brief/, "compiles your daily brief"],
    [/threads/, "drafts your daily threads post"],
    [/standup/, "drafts & posts the daily standup"],
    [/memory-sleep|memory/, "consolidates long-term memory"],
    [/evolve/, "updates AIOS's capability snapshot"],
    [/skill/, "synthesizes new skills from your sessions"],
    [/claude-janitor|janitor/, "cleans up stale sessions & temp files"],
    [/caffeinate/, "keeps the mac awake"],
    [/ttyd/, "remote terminal access for an oracle"],
    [/bridge|bsg/, "runs the WhatsApp bridge"],
    [/hud/, "refreshes the AIOS HUD"],
    [/wakeup|wake/, "wakes an oracle session"],
    [/loot/, "collects telemetry"],
    [/ai-assign/, "monitors AI assignment"],
    [/gym/, "gym check-in nudge"],
    [/meal/, "meal check-in nudge"],
    [/stock|tank/, "stock/tank reminder"],
    [/reminder/, "sends a scheduled reminder"],
    [/checkin|check-in/, "sends a check-in nudge"],
    [/watch|monitor/, "watches for changes & alerts"],
  ];
  for (const [re, desc] of map) if (re.test(l)) return desc;
  return "background task";
}

/** Friendlier schedule phrasing (for the timed-job chip). */
function humanSchedule(s: string): string {
  if (!s) return "on demand";
  return s
    .replace(/^every (\d+)m$/, "every $1 min")
    .replace(/^every (\d+)h$/, "every $1 hr")
    .replace(/^daily /, "daily · ")
    .replace(/^weekly /, "weekly · ")
    .replace(/always on \(KeepAlive\)/i, "always on")
    .replace(/^at load$/i, "on startup")
    .replace(/^manual$/i, "on demand");
}

/** "2h ago" / "just now" / "" from a unix-seconds mtime. */
function ago(secs: number): string {
  if (!secs) return "";
  const rem = Date.now() / 1000 - secs;
  if (rem < 60) return "just now";
  const m = Math.floor(rem / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── state model ──────────────────────────────────────────────────────────────

type JobState = "running" | "idle" | "failed" | "down";

const isDaemon = (j: Job) => /always on|keepalive/i.test(j.schedule);

function jobState(j: Job): JobState {
  if (j.last_exit && j.last_exit !== 0) return "failed";
  if (j.running) return "running";
  return isDaemon(j) ? "down" : "idle"; // a daemon that should be alive but isn't = down
}

/** Rank for failed-to-top sorting inside a group. */
function stateRank(s: JobState): number {
  return { failed: 0, down: 1, running: 2, idle: 3 }[s];
}

/** Dot: green=running, red=failed, red-ring=daemon-down, grey-ring=idle/scheduled
 *  (the normal resting state for a timer). Colour + fill-shape, never hue alone. */
function StateDot({ state }: { state: JobState }) {
  if (state === "running")
    return (
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: "var(--color-success)", boxShadow: "0 0 6px color-mix(in srgb, var(--color-success) 60%, transparent)" }}
      />
    );
  if (state === "failed")
    return <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--color-danger)" }} />;
  if (state === "down")
    return <span className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-[var(--color-danger)]" />;
  return <span className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-[var(--color-faint)]" />;
}

// ── pane ───────────────────────────────────────────────────────────────────────

export function AutomationsPane() {
  const [data, setData] = useState<Automations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setData(await listAutomations());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const jobs = useMemo(() => data?.jobs ?? [], [data]);
  const agents = data?.agents ?? [];
  const planned = data?.planned ?? [];

  const { daemons, timed, runningCount, idleCount, failedCount } = useMemo(() => {
    const byState = (a: Job, b: Job) =>
      stateRank(jobState(a)) - stateRank(jobState(b)) ||
      friendlyName(a.label).localeCompare(friendlyName(b.label));
    const d = jobs.filter(isDaemon).sort(byState);
    const t = jobs.filter((j) => !isDaemon(j)).sort(byState);
    return {
      daemons: d,
      timed: t,
      runningCount: jobs.filter((j) => j.running).length,
      idleCount: jobs.filter((j) => jobState(j) === "idle").length,
      failedCount: jobs.filter((j) => jobState(j) === "failed" || jobState(j) === "down").length,
    };
  }, [jobs]);

  const visible = (list: Job[]) => (onlyProblems ? list.filter((j) => jobState(j) === "failed" || jobState(j) === "down") : list);
  const vDaemons = visible(daemons);
  const vTimed = visible(timed);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      {/* header + live summary counts */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-[var(--color-accent)]" />
          <span className="text-[13px] font-medium text-[var(--color-text)]">automations</span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10.5px] text-[var(--color-muted)]">
          <Count color="var(--color-success)" n={runningCount} label="running" />
          <Count ring n={idleCount} label="scheduled" />
          <Count color={failedCount ? "var(--color-danger)" : undefined} ring={!failedCount} n={failedCount} label="failed" />
          <button
            onClick={() => setOnlyProblems((v) => !v)}
            title="show only problems"
            className={`rounded px-1.5 py-0.5 ${onlyProblems ? "bg-[var(--color-danger)]/15 text-[var(--color-danger)]" : "text-[var(--color-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"}`}
          >
            {onlyProblems ? "all" : "problems"}
          </button>
          <button
            onClick={refresh}
            className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title="Refresh"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="px-3 py-2 text-[12px] text-[var(--color-danger)]">{error}</p>}

        {/* today's plan — the timed nudges from the nightly plan */}
        {planned.length > 0 && !onlyProblems && (
          <Group icon={<Clock size={11} />} title="today's plan" count={planned.length}>
            {planned.map((p, i) => (
              <div key={i} className="flex h-8 items-center gap-3 border-b border-[var(--color-border)]/40 px-3">
                <span className="w-12 shrink-0 font-mono text-[11px] text-[var(--color-accent)]">{p.time}</span>
                <span className="truncate text-[12px] text-[var(--color-text-2)]">{p.title}</span>
              </div>
            ))}
          </Group>
        )}

        {/* live agents — oracle tmux sessions; healthy == alive */}
        {agents.length > 0 && !onlyProblems && (
          <Group icon={<Cpu size={11} />} title="live agents" count={agents.length}>
            {agents.map((a) => (
              <AgentRow key={a.name} agent={a} />
            ))}
          </Group>
        )}

        {/* always-on daemons — healthy == alive (no next-run notion) */}
        {(vDaemons.length > 0 || (!onlyProblems && daemons.length > 0)) && (
          <Group
            icon={<Power size={11} />}
            title="always-on"
            count={daemons.length}
            alert={daemons.some((j) => jobState(j) === "down" || jobState(j) === "failed")}
          >
            {vDaemons.map((j) => (
              <JobRow key={j.label} job={j} daemon onAction={refresh} />
            ))}
          </Group>
        )}

        {/* scheduled jobs — healthy == fired on schedule */}
        {(vTimed.length > 0 || (!onlyProblems && timed.length > 0)) && (
          <Group
            icon={<Zap size={11} />}
            title="scheduled"
            count={timed.length}
            alert={timed.some((j) => jobState(j) === "failed")}
          >
            {vTimed.length === 0 && !loading ? (
              <p className="px-3 py-2 text-[11px] text-[var(--color-muted)]/60">no scheduled jobs.</p>
            ) : (
              vTimed.map((j) => <JobRow key={j.label} job={j} onAction={refresh} />)
            )}
          </Group>
        )}

        {onlyProblems && failedCount === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-[var(--color-muted)]">
            all healthy — nothing failed or down.
          </p>
        )}
      </div>
    </div>
  );
}

/** A summary count chip: dot + n + label. */
function Count({ n, label, color, ring }: { n: number; label: string; color?: string; ring?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`h-1.5 w-1.5 rounded-full ${ring ? "border-[1.5px] border-[var(--color-faint)]" : ""}`}
        style={ring ? undefined : { background: color ?? "var(--color-muted)" }}
      />
      <span className={n && color ? "" : "text-[var(--color-faint)]"} style={n && color ? { color } : undefined}>
        {n}
      </span>
      <span className="text-[var(--color-faint)]">{label}</span>
    </span>
  );
}

// ── agent row ────────────────────────────────────────────────────────────────

function AgentRow({ agent }: { agent: Agent }) {
  return (
    <div className="flex h-8 items-center gap-2.5 border-b border-[var(--color-border)]/40 px-3">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: "var(--color-success)", boxShadow: "0 0 6px color-mix(in srgb, var(--color-success) 60%, transparent)" }}
      />
      <span className="truncate text-[12.5px] text-[var(--color-text)]">{agent.name.replace(/^aios-/, "")}</span>
      {agent.attached && <span className="ml-auto font-mono text-[10px] text-[var(--color-accent)]">attached</span>}
    </div>
  );
}

// ── job row (collapsed dense line, expands in place) ────────────────────────────

function JobRow({ job, daemon, onAction }: { job: Job; daemon?: boolean; onAction: () => void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [started, setStarted] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const state = jobState(job);
  const lastRun = ago(job.last_run);

  const loadDetail = useCallback(async () => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      setDetail(await automationDetail(job.label));
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }, [job.label]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next && !detail && !detailLoading) loadDetail();
      return next;
    });
  }, [detail, detailLoading, loadDetail]);

  const onRunNow = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await runAutomation(job.label);
      setStarted(true);
      setTimeout(() => setStarted(false), 2500);
      await loadDetail();
      onAction();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [job.label, loadDetail, onAction]);

  const loaded = detail?.loaded ?? false;

  const onToggleEnabled = useCallback(async () => {
    if (loaded && !confirmDisable) {
      setConfirmDisable(true);
      setTimeout(() => setConfirmDisable(false), 4000);
      return;
    }
    setBusy(true);
    setActionError(null);
    setConfirmDisable(false);
    try {
      await setAutomationEnabled(job.label, !loaded);
      await loadDetail();
      onAction();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [job.label, loaded, confirmDisable, loadDetail, onAction]);

  return (
    <div className="border-b border-[var(--color-border)]/40">
      {/* collapsed dense row */}
      <button
        type="button"
        onClick={toggle}
        className="group flex h-9 w-full items-center gap-2.5 px-3 text-left hover:bg-[var(--color-panel-2)]/40"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 text-[var(--color-faint)] transition-transform group-hover:text-[var(--color-muted)] ${open ? "rotate-90" : ""}`}
        />
        <StateDot state={state} />
        <span className="shrink-0 text-[12.5px] text-[var(--color-text)]">{friendlyName(job.label)}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-muted)]">{describe(job.label)}</span>

        {/* exception pill — only on broken rows, so the eye lands on problems */}
        {state === "failed" && (
          <span className="shrink-0 rounded bg-[var(--color-danger)]/15 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-danger)]">
            exit {job.last_exit}
          </span>
        )}
        {state === "down" && (
          <span className="shrink-0 rounded bg-[var(--color-danger)]/15 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-danger)]">
            not running
          </span>
        )}

        {/* relative last-run (mono, right-aligned) */}
        {lastRun && <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">{lastRun}</span>}

        {/* schedule chip — only meaningful for timed jobs (daemons carry it in the group header) */}
        {!daemon && (
          <span className="shrink-0 rounded-full bg-[var(--color-bg)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text-2)]">
            {humanSchedule(job.schedule)}
          </span>
        )}
      </button>

      {/* expanded detail */}
      {open && (
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] bg-[var(--color-bg)]/30 px-3 py-3 pl-8">
          {detailLoading && <p className="text-[11px] text-[var(--color-muted)]">loading detail…</p>}
          {detailError && <p className="text-[11px] text-[var(--color-danger)]">{detailError}</p>}

          {detail && (
            <>
              <Field label="command">
                <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[11px] text-[var(--color-text-2)]">
                  {detail.command || "(none)"}
                </pre>
              </Field>

              <Field label="plist">
                <span className="break-all font-mono text-[10px] text-[var(--color-faint)]">{detail.plistPath}</span>
              </Field>

              <div className="flex flex-wrap items-center gap-1.5">
                <Chip>{humanSchedule(detail.schedule)}</Chip>
                {detail.runAtLoad && <Chip>runAtLoad</Chip>}
                {detail.keepAlive && <Chip>keepAlive</Chip>}
                <Chip>
                  {detail.loaded ? `loaded${detail.pid != null ? ` · pid ${detail.pid}` : ""}` : "not loaded"}
                </Chip>
                <Chip>last exit {detail.lastExit ?? job.last_exit}</Chip>
                {lastRun && <Chip>ran {lastRun}</Chip>}
              </div>

              <Field label={<><FileText size={11} /> recent log</>}>
                {detail.recentLog.length > 0 ? (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[10px] text-[var(--color-faint)]">
                    {detail.recentLog.join("\n")}
                  </pre>
                ) : (
                  <span className="text-[10px] text-[var(--color-muted)]/60">no log output</span>
                )}
              </Field>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onRunNow}
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 text-[11px] text-[var(--color-text-2)] hover:bg-[var(--color-panel-2)] disabled:opacity-50"
                >
                  <Play size={11} /> run now
                </button>
                {started && <span className="text-[10px] text-[var(--color-accent)]">started</span>}

                <button
                  type="button"
                  disabled={busy}
                  onClick={onToggleEnabled}
                  className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-[11px] disabled:opacity-50 ${
                    confirmDisable
                      ? "border-[var(--color-danger)] bg-[var(--color-bg)] text-[var(--color-danger)]"
                      : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-2)] hover:bg-[var(--color-panel-2)]"
                  }`}
                >
                  <Power size={11} />
                  {loaded ? (confirmDisable ? "confirm disable" : "disable") : "enable"}
                </button>

                <button
                  type="button"
                  onClick={loadDetail}
                  disabled={detailLoading}
                  className="ml-auto rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                  title="refresh detail"
                >
                  <RefreshCw size={11} className={detailLoading ? "animate-spin" : ""} />
                </button>
              </div>
              {actionError && <p className="text-[10px] text-[var(--color-danger)]">{actionError}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[var(--color-muted)]">{label}</span>
      {children}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text-2)]">
      {children}
    </span>
  );
}

/** A collapsible-feeling section header + its rows. The group header states the
 *  shared state ("always-on") ONCE — rows below never repeat it. */
function Group({
  icon,
  title,
  count,
  alert,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  alert?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-pane)]/95 px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)] backdrop-blur-sm">
        <span className="text-[var(--color-faint)]">{icon}</span>
        {title}
        {count != null && <span className="text-[var(--color-faint)]">· {count}</span>}
        {alert && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-[var(--color-danger)]" />}
      </div>
      {children}
    </div>
  );
}
