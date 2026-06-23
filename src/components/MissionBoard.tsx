/**
 * Mission-control board — the visual memory of firaz's work, and the door to the
 * ONE capable AI he talks to (the orchestrator). It does NOT fragment work into
 * separate canned chats. Every action opens/focuses the single orchestrator chat
 * (board-aware, can spawn agents + make loops) and optionally drops a starter
 * into its composer WITHOUT sending — firaz talks; he's never auto-dispatched.
 *
 * Shows the active mission, each agent's status (written back by the agent into
 * its config.json, pulled via syncAgentsFromDisk), and the open task list.
 */
import { useEffect, useState } from "react";
import { Check, MessageSquare, Pause, Pencil, Play, RefreshCw, Repeat, Target } from "lucide-react";

import { talkToOrchestrator } from "../lib/paneBus";
import {
  getMission,
  listAgents,
  listGoals,
  listLoops,
  missionTask,
  seedWrmsControlCentre,
  setLoopCadence,
  setMission,
  startLoop,
  stopLoop,
  syncAgentsFromDisk,
  wrmsAgentSeeds,
  wrmsSeedTasks,
  type AgentConfig,
  type BoardTask,
  type GoalDriver,
  type LoopInfo,
  type LoopStatus,
} from "../lib/agents";

type Status = NonNullable<AgentConfig["status"]>;

const STATUS_META: Record<Status, { label: string; color: string }> = {
  idle: { label: "idle", color: "var(--color-faint)" },
  running: { label: "running", color: "var(--color-success)" },
  blocked: { label: "blocked", color: "var(--color-danger)" },
  done: { label: "done", color: "var(--color-info)" },
};

/** Goal-driver status → pill color. Goal statuses ("active"/"held"/…) differ
 *  from the agent set, so map them here with a faint fallback. */
function goalStatusColor(status: string | undefined): string {
  switch (status) {
    case "active":
    case "running":
      return "var(--color-success)";
    case "blocked":
      return "var(--color-danger)";
    case "done":
      return "var(--color-info)";
    case "held":
    case "paused":
      return "var(--color-muted)";
    default:
      return "var(--color-faint)";
  }
}

function relAge(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "no update yet";
  const delta = Math.max(0, now - ts);
  const min = Math.max(1, Math.floor(delta / 60_000));
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function MissionBoard() {
  const [version, setVersion] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [goals, setGoals] = useState<GoalDriver[]>([]);
  const [loops, setLoops] = useState<LoopInfo[]>([]);

  const pullFeeds = async () => {
    const [g, l] = await Promise.all([listGoals(), listLoops()]);
    setGoals(g);
    setLoops(l);
  };

  useEffect(() => {
    seedWrmsControlCentre();
    void syncAgentsFromDisk().then(() => setVersion((v) => v + 1));
    void pullFeeds();
  }, []);

  const refresh = async () => {
    setSyncing(true);
    await Promise.all([syncAgentsFromDisk(), pullFeeds()]);
    setSyncing(false);
    setVersion((v) => v + 1);
  };

  void version;
  const mission = getMission();
  const persisted = listAgents();
  const rows = wrmsAgentSeeds().map((seed) => {
    const agent = persisted.find((a) => a.id === seed.id);
    return {
      id: seed.id,
      label: seed.label,
      role: agent?.role ?? seed.role,
      status: (agent?.status ?? "idle") as Status,
      blocker: agent?.blocker,
      nextAction: agent?.nextAction,
      lastUpdate: agent?.lastUpdate,
    };
  });

  // Open the orchestrator with an editable STARTER (composer prefilled, not sent).
  const askAgent = (label: string, role: string) =>
    talkToOrchestrator(`take the ${label} lane (${role}). mission: ${mission}. break it up and spawn threads as needed.`);
  const askTask = (task: BoardTask) => talkToOrchestrator(task.prompt);

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]/35 p-3">
      <div className="flex items-center gap-2">
        <MissionHeader onChange={() => setVersion((v) => v + 1)} />
        <button
          type="button"
          onClick={() => talkToOrchestrator()}
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-bg)] transition-transform hover:scale-[1.03]"
          title="open the AIOS orchestrator — the one AI that knows your board, spawns agents, makes loops"
        >
          <MessageSquare size={12} />
          talk to AIOS
        </button>
      </div>

      <div className="mt-2.5 flex flex-col gap-1.5">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => askAgent(row.label, row.role)}
            className="group flex min-w-0 items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]/40"
            title={`talk to AIOS about the ${row.label} lane`}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: STATUS_META[row.status].color }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[12.5px] font-medium text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
                  {row.label}
                </span>
                <span
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider"
                  style={{
                    color: STATUS_META[row.status].color,
                    background: `color-mix(in srgb, ${STATUS_META[row.status].color} 16%, transparent)`,
                  }}
                >
                  {STATUS_META[row.status].label}
                </span>
              </div>
              <div className="truncate font-mono text-[9.5px] text-[var(--color-faint)]">{row.role}</div>
              {row.status === "blocked" && row.blocker && (
                <div className="mt-0.5 truncate text-[10px] text-[var(--color-danger)]">⚠ {row.blocker}</div>
              )}
              {row.nextAction && (
                <div className="mt-0.5 truncate text-[10px] text-[var(--color-muted)]">→ {row.nextAction}</div>
              )}
            </div>
            <span className="shrink-0 font-mono text-[9px] text-[var(--color-faint)]">{relAge(row.lastUpdate)}</span>
          </button>
        ))}
      </div>

      <GoalsSection goals={goals} mission={mission} />
      <LoopsSection loops={loops} onChanged={() => void pullFeeds()} />

      <TaskBacklog onPick={askTask} />

      <div className="mt-2 flex items-center justify-end">
        <button
          type="button"
          onClick={refresh}
          disabled={syncing}
          className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
          title="pull status the agents wrote back to disk"
        >
          <RefreshCw size={11} className={syncing ? "animate-spin" : ""} />
          refresh status
        </button>
      </div>
    </div>
  );
}

function TaskBacklog({ onPick }: { onPick: (task: BoardTask) => void }) {
  const tasks: BoardTask[] = [missionTask(), ...wrmsSeedTasks()];
  if (tasks.length === 0) return null;

  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-2.5">
      <div className="mb-1.5 text-[9px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
        tasks · click to hand to AIOS
      </div>
      <div className="flex flex-col gap-1">
        {tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            onClick={() => onPick(task)}
            className={`group flex min-w-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition-colors hover:border-[var(--color-accent)]/40 ${
              task.id === "mission"
                ? "border-[var(--color-accent)]/45 bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]"
                : "border-[var(--color-border)] bg-[var(--color-bg)]/40"
            }`}
            title="open AIOS with this as a starter (you send it)"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11.5px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
                {task.title}
              </div>
              <div className="truncate font-mono text-[9px] text-[var(--color-faint)]">{task.lane}</div>
            </div>
            <Play size={12} className="shrink-0 text-[var(--color-faint)] group-hover:text-[var(--color-accent)]" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Goals section — every active goal driver the box is advancing (read-only,
 *  source-of-truth = goals/active/<id>/state.json). Clicking opens the
 *  orchestrator with a starter to advance that goal. Renders nothing when empty
 *  (web build / no goals) so it stays purely additive to the WRMS lane. */
function GoalsSection({ goals, mission }: { goals: GoalDriver[]; mission: string }) {
  if (goals.length === 0) return null;

  const ask = (goal: GoalDriver) =>
    talkToOrchestrator(
      `advance the goal "${goal.goal}" (${goal.id}). ${goal.nextStep || ""}`.trim() +
        ` mission context: ${mission}.`,
    );

  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-2.5">
      <div className="mb-1.5 text-[9px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
        goals · what the box is driving
      </div>
      <div className="flex flex-col gap-1.5">
        {goals.map((goal) => {
          const meta = [goal.kind, goal.priority, goal.window].filter(Boolean).join(" · ");
          const color = goalStatusColor(goal.status);
          return (
            <button
              key={goal.id}
              type="button"
              onClick={() => ask(goal)}
              className="group flex min-w-0 items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]/40"
              title={`talk to AIOS about the "${goal.goal}" goal`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12.5px] font-medium text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
                    {goal.goal}
                  </span>
                  {goal.status && (
                    <span
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider"
                      style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}
                    >
                      {goal.status}
                    </span>
                  )}
                </div>
                {meta && (
                  <div className="truncate font-mono text-[9.5px] text-[var(--color-faint)]">{meta}</div>
                )}
                {goal.status === "blocked" && goal.blocker ? (
                  <div className="mt-0.5 truncate text-[10px] text-[var(--color-danger)]">⛔ {goal.blocker}</div>
                ) : (
                  goal.nextStep && (
                    <div className="mt-0.5 truncate text-[10px] text-[var(--color-muted)]">→ {goal.nextStep}</div>
                  )
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Loop status → pill color. */
function loopStatusColor(status: LoopStatus | undefined): string {
  switch (status) {
    case "running":
      return "var(--color-success)";
    case "paused":
      return "var(--color-warning, var(--color-muted))";
    case "stopped":
      return "var(--color-danger)";
    default:
      return "var(--color-faint)";
  }
}

/** Loops section — firaz's control panel for every loop (loops/*.meta): live
 *  status, start/stop toggle, inline cadence edit. Renders null when empty so it
 *  stays additive. `onChanged` re-pulls the feed after a control action. */
function LoopsSection({ loops, onChanged }: { loops: LoopInfo[]; onChanged: () => void }) {
  if (loops.length === 0) return null;

  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[9px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
        <Repeat size={10} />
        loops · control panel
      </div>
      <div className="flex flex-col gap-1">
        {loops.map((loop) => (
          <LoopRow key={loop.name} loop={loop} onChanged={onChanged} />
        ))}
      </div>
    </div>
  );
}

/** One loop row — status dot, name, inline-editable cadence, start/stop toggle,
 *  last log line. Each control action invokes Rust then re-pulls via onChanged.
 *  Exported so the dedicated LoopPane reuses the exact same control row. */
export function LoopRow({ loop, onChanged }: { loop: LoopInfo; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(loop.cadence);

  const status = loop.status ?? "running";
  const color = loopStatusColor(status);
  const isOff = status === "stopped" || status === "paused";
  const editable = loop.editable !== false && loop.source !== "launchagent";
  const controllable = loop.controllable !== false;

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch {
      /* surfaced by the unchanged status on re-pull */
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const toggle = () => {
    if (!controllable) return;
    void run(() => (isOff ? startLoop(loop.name) : stopLoop(loop.name)));
  };
  const saveCadence = () => {
    if (!editable) {
      setEditing(false);
      return;
    }
    const next = draft.trim();
    setEditing(false);
    if (!next || next === loop.cadence) return;
    void run(() => setLoopCadence(loop.name, next));
  };

  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-3 py-1.5">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: color }}
        title={status}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[11.5px] font-medium text-[var(--color-text-2)]">{loop.name}</span>
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={saveCadence}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveCadence();
                else if (e.key === "Escape") {
                  setDraft(loop.cadence);
                  setEditing(false);
                }
              }}
              className="w-16 shrink-0 rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1 py-0.5 font-mono text-[9px] text-[var(--color-text)] outline-none"
            />
          ) : (
            loop.cadence && (
              editable ? (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(loop.cadence);
                    setEditing(true);
                  }}
                  className="group/c shrink-0 rounded-full bg-[var(--color-panel-2)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  title="edit cadence"
                >
                  {loop.cadence}
                  <Pencil size={8} className="ml-1 inline opacity-0 group-hover/c:opacity-100" />
                </button>
              ) : (
                <span
                  className="shrink-0 rounded-full bg-[var(--color-panel-2)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-muted)]"
                  title={loop.label || "launchd schedule"}
                >
                  {loop.cadence}
                </span>
              )
            )
          )}
          {loop.source === "launchagent" && (
            <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-[var(--color-faint)]">
              launchd
            </span>
          )}
        </div>
        {loop.lastLog && (
          <div className="truncate font-mono text-[9.5px] text-[var(--color-faint)]">{loop.lastLog}</div>
        )}
      </div>
      <button
        type="button"
        onClick={toggle}
        disabled={busy || !controllable}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] disabled:opacity-40"
        title={isOff ? "start loop" : "stop loop"}
      >
        {isOff ? <Play size={12} /> : <Pause size={12} />}
      </button>
    </div>
  );
}

function MissionHeader({ onChange }: { onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => getMission());

  const save = () => {
    setMission(draft);
    setEditing(false);
    onChange();
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Target size={13} className="shrink-0 text-[var(--color-accent)]" />
      <span className="shrink-0 text-[9px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
        mission
      </span>
      {editing ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="submit"
            className="grid h-6 w-6 place-items-center rounded text-[var(--color-success)] hover:bg-[var(--color-panel-2)]"
          >
            <Check size={12} />
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(getMission());
            setEditing(true);
          }}
          className="group flex min-w-0 items-center gap-1.5 text-left"
          title="edit mission"
        >
          <span className="truncate text-[13px] font-medium text-[var(--color-text)]">{getMission()}</span>
          <Pencil size={10} className="shrink-0 text-[var(--color-faint)] opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}
    </div>
  );
}
