/** Automations — a human-readable view of everything AIOS runs on its own:
 *  scheduled launchd jobs, today's planned nudges, and live background agents.
 *  Cryptic `com.firaz.aios-*` labels are translated to friendly names, plain
 *  schedules, and a one-line "what it does". */
import { useCallback, useEffect, useState } from "react";

import { Activity, Clock, Cpu, RefreshCw, Zap } from "lucide-react";

import { listAutomations, type Automations, type Job } from "../lib/automations";

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

/** Friendlier schedule phrasing. */
function humanSchedule(s: string): string {
  if (!s) return "on demand";
  return s
    .replace(/^every (\d+)m$/, "every $1 min")
    .replace(/^every (\d+)h$/, "every $1 hr")
    .replace(/^daily /, "every day · ")
    .replace(/^weekly /, "weekly · ")
    .replace(/always on \(KeepAlive\)/i, "always running")
    .replace(/^at load$/i, "on startup")
    .replace(/^manual$/i, "on demand");
}

function jobStatus(j: Job): { dot: string; text: string } {
  if (j.running) return { dot: "status-dot--active", text: "running" };
  if (j.last_exit && j.last_exit !== 0)
    return { dot: "status-dot--cold", text: `last run failed (${j.last_exit})` };
  return { dot: "status-dot--idle", text: "idle · waiting for next run" };
}

export function AutomationsPane() {
  const [data, setData] = useState<Automations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const jobs = data?.jobs ?? [];
  const agents = data?.agents ?? [];
  const planned = data?.planned ?? [];
  const liveCount = jobs.filter((j) => j.running).length + agents.filter((a) => a.attached).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-[var(--color-accent)]" />
          <span className="text-[13px] font-medium text-[var(--color-text)]">automations</span>
          <span className="text-[11px] text-[var(--color-muted)]">
            {jobs.length} scheduled · {liveCount} live
          </span>
        </div>
        <button
          onClick={refresh}
          className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-3 text-[11px] leading-relaxed text-[var(--color-muted)]">
          everything AIOS runs on its own — timed jobs, today's planned nudges, and live background
          agents.
        </p>

        {error && <p className="text-[12px] text-[var(--color-danger)]">{error}</p>}

        {planned.length > 0 && (
          <Section icon={<Activity size={12} />} title="today's plan">
            {planned.map((p, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/30 px-3 py-2"
              >
                <span className="w-12 shrink-0 font-mono text-[11px] text-[var(--color-accent)]">
                  {p.time}
                </span>
                <span className="truncate text-[12px] text-[var(--color-text-2)]">{p.title}</span>
              </div>
            ))}
          </Section>
        )}

        {agents.length > 0 && (
          <Section icon={<Cpu size={12} />} title="live agents">
            {agents.map((a) => (
              <div
                key={a.name}
                className="flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/30 px-3 py-2"
              >
                <span className={`status-dot ${a.attached ? "status-dot--active" : "status-dot--idle"}`} />
                <span className="truncate text-[12px] text-[var(--color-text)]">
                  {a.name.replace(/^aios-/, "")}
                </span>
                <span className="ml-auto text-[10px] text-[var(--color-faint)]">
                  {a.attached ? "attached" : "running"}
                </span>
              </div>
            ))}
          </Section>
        )}

        <Section icon={<Zap size={12} />} title="scheduled jobs">
          {jobs.length === 0 && !loading ? (
            <p className="text-[11px] text-[var(--color-muted)]/60">no scheduled jobs found.</p>
          ) : (
            jobs.map((j) => {
              const st = jobStatus(j);
              return (
                <div
                  key={j.label}
                  className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/30 px-3 py-2"
                  title={j.command}
                >
                  <span className={`status-dot shrink-0 ${st.dot}`} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12px] text-[var(--color-text)]">
                      {friendlyName(j.label)}
                    </span>
                    <span className="truncate text-[10px] text-[var(--color-muted)]">
                      {describe(j.label)} · {st.text}
                    </span>
                  </div>
                  <span className="shrink-0 rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] text-[var(--color-text-2)]">
                    {humanSchedule(j.schedule)}
                  </span>
                </div>
              );
            })
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
        {icon}
        {title}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}
