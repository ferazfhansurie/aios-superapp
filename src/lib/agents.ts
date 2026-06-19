/**
 * Persistent agents runtime — config + persistence layer.
 *
 * An "agent" is a named, persisted recipe for a CHATPANE: a label, a model, a
 * working dir, and an opening prompt (the mission, e.g. "/last30days AI
 * agents"). Creating one materializes a chat pane (via the control-command
 * `run-agent` path in App.tsx), persists it, and lists it in the sidebar where
 * it can be reattached / stopped / run-again.
 *
 * SOURCE OF TRUTH: localStorage key `aios.agents` (synchronous, survives
 * relaunch). We ALSO mirror each config to
 * `~/.aios/state/chat-agents/<id>/config.json` via the Rust `agent_save` /
 * `agent_list` / `agent_delete` commands, so a HEADLESS caller — the future
 * cron runner on the box — can enumerate agents and fire them through the
 * control hook WITHOUT a running webview. The mirror is best-effort: a failed
 * fs write never blocks the localStorage write.
 *
 * This is intentionally SEPARATE from `moneyAgents.ts` (the older sales-agent
 * sidebar): that one is launchd/state-file shaped; this one is the generic
 * "any prompt, any model, persisted, schedulable" runtime the spec asks for.
 * Keeping them apart keeps the daily-driver additive — nothing in the existing
 * money-agents path changes.
 *
 * // TODO(cron): schedule via systemd-user timer on the box / launchd on mac,
 * // firing an agent-runner that POSTs `run-agent` to the control hook
 * // (127.0.0.1:<control-port>, bearer from ~/.aios/state/node-secret). The
 * // `schedule` field below is the seam — parse it there, not here.
 */
import { invoke } from "./tauri";

export interface AgentConfig {
  /** Stable slug (normalized from the label). Pane key = `agent:<id>`. */
  id: string;
  /** Human label shown in the sidebar + used as the chat/background title. */
  label: string;
  /** One-line description of what this agent is for. */
  mission: string;
  /** Backend engine: "claude" | "codex" | "opencode". Derived from the model. */
  engine: string;
  /** Model id passed to the engine (e.g. `claude-opus-4-8`, `gpt-5.3-codex-spark`). */
  model: string;
  /** claude permission mode (bypassPermissions | acceptEdits | default | plan). */
  permissionMode: string;
  /** The opening prompt fired when the agent materializes / runs (the mission,
   *  e.g. "/last30days AI agents"). Re-sent verbatim by Run-now. */
  prompt: string;
  /** Working directory for the chat session (so tools hit the right repo). */
  cwd: string;
  /** Cron-ish cadence string. Parsed by the future cron runner, NOT here.
   *  Absent / "manual" = no scheduling. */
  schedule?: string;
  createdAt: number;
  /** Epoch ms of the last Run-now / scheduled fire (for the sidebar subtitle). */
  lastRun?: number;

  // ── control-centre status board (the mission-control MVP) ────────────────
  // These are written by the AGENT ITSELF into its config.json (via the fs
  // mirror) so the board reflects real work, not just UI guesses. The oracle
  // dispatches; the agent reports back here; `syncAgentsFromDisk` reads it.
  /** Short role line: what this agent owns (e.g. "vendor app/api · release"). */
  role?: string;
  /** Current state shown as a pill on the board. */
  status?: "idle" | "running" | "blocked" | "done";
  /** What's blocking, if status === "blocked" (one line). */
  blocker?: string;
  /** The single next concrete action (one line). */
  nextAction?: string;
  /** Epoch ms the agent last wrote a status update. */
  lastUpdate?: number;
}

const STORAGE_KEY = "aios.agents";

/** Normalizes a label into a stable, fs-safe slug. Mirrors `safe_id` in
 *  control.rs so the id round-trips identically between TS and Rust. */
export function normalizeAgentId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** The pane key an agent's chatpane is opened under. One stable key per agent
 *  so a reopen reattaches the SAME pane rather than spawning a duplicate. */
export function agentPaneKey(id: string): string {
  return `agent:${id}`;
}

function readStore(): AgentConfig[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((a): a is AgentConfig => Boolean(a && a.id && a.label));
  } catch {
    return [];
  }
}

function writeStore(agents: AgentConfig[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(agents));
}

/** Best-effort fs mirror — never throws (the localStorage write is the truth). */
async function mirrorSave(agent: AgentConfig): Promise<void> {
  try {
    await invoke("agent_save", { id: agent.id, config: agent });
  } catch {
    /* outside tauri / fs unavailable — localStorage still holds it */
  }
}

async function mirrorDelete(id: string): Promise<void> {
  try {
    await invoke("agent_delete", { id });
  } catch {
    /* ignore */
  }
}

/** Lists configured agents (localStorage = source of truth). */
export function listAgents(): AgentConfig[] {
  return readStore();
}

export function getAgent(id: string): AgentConfig | undefined {
  return readStore().find((a) => a.id === id);
}

/** Creates (or returns an existing) agent. Persists to localStorage + fs mirror.
 *  Returns null on an unusable label. */
export function createAgent(input: {
  label: string;
  mission?: string;
  engine: string;
  model: string;
  permissionMode?: string;
  prompt: string;
  cwd?: string;
  schedule?: string;
  role?: string;
}): AgentConfig | null {
  const label = input.label.trim();
  const id = normalizeAgentId(label);
  if (!id || !input.prompt.trim()) return null;

  const agents = readStore();
  const existing = agents.find((a) => a.id === id);
  if (existing) return existing;

  const agent: AgentConfig = {
    id,
    label,
    mission: (input.mission || input.prompt).trim().slice(0, 200),
    engine: input.engine,
    model: input.model,
    permissionMode: input.permissionMode || "bypassPermissions",
    prompt: input.prompt.trim(),
    cwd: input.cwd?.trim() || "",
    schedule: input.schedule?.trim() || "manual",
    createdAt: Date.now(),
    role: input.role?.trim() || undefined,
    status: "idle",
  };
  writeStore([...agents, agent]);
  void mirrorSave(agent);
  return agent;
}

/** Patches an agent in place (e.g. stamping lastRun). No-op if id unknown. */
export function updateAgent(id: string, patch: Partial<AgentConfig>): AgentConfig | undefined {
  const agents = readStore();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx < 0) return undefined;
  const next = { ...agents[idx], ...patch, id: agents[idx].id };
  agents[idx] = next;
  writeStore(agents);
  void mirrorSave(next);
  return next;
}

/** Stamps lastRun = now. Called from the run-now / control-command path. */
export function markAgentRun(id: string): void {
  updateAgent(id, { lastRun: Date.now() });
}

/** Removes an agent from localStorage + fs mirror. */
export function deleteAgent(id: string): void {
  writeStore(readStore().filter((a) => a.id !== id));
  void mirrorDelete(id);
}

// ── mission-control MVP: active mission + WRMS agent fleet ────────────────────
// The shell is the CONTROL CENTRE: the oracle decides the mission, the three
// WRMS agents (tool/vendor/collector) execute, and each reports status back into
// its own config.json. The board reads truth from disk via syncAgentsFromDisk().

const MISSION_KEY = "aios.mission";
const DEFAULT_MISSION = "digital payment apk today";

/** The single active mission shown atop the board. UI-owned (localStorage). */
export function getMission(): string {
  if (typeof localStorage === "undefined") return DEFAULT_MISSION;
  return localStorage.getItem(MISSION_KEY) || DEFAULT_MISSION;
}

export function setMission(value: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(MISSION_KEY, value.trim() || DEFAULT_MISSION);
}

/** Firaz's box. The agents launch chat panes here, scoped to the right repo so
 *  tools hit the correct codebase. Absolute because spawn() needs a real cwd. */
const WRMS_ROOT = "/Users/firazfhansurie/Repo/wrms";

export interface WrmsAgentSeed {
  id: string;
  label: string;
  role: string;
  cwd: string;
  /** Opening prompt fired when the agent's chat pane materializes. */
  prompt: string;
}

/** The three control-centre agents. Order = board order. */
export function wrmsAgentSeeds(mission = getMission()): WrmsAgentSeed[] {
  return [
    {
      id: "wrms-tool-agent",
      label: "wrms-tool-agent",
      role: "outside truth · jira/gchat/wa/github/sentry/vercel/repos",
      cwd: WRMS_ROOT,
      prompt:
        `you are wrms-tool-agent — you own EXTERNAL context for the mission "${mission}". ` +
        `gather outside truth: open jira tickets (FVA/FCA/WRMS), gchat/wa threads, github PR/CI state, sentry errors, vercel deploys, and git status across the wrms repos. ` +
        `report: what's relevant to the mission, what's blocking, and the single next action. do not write code — you are the scout. ` +
        `when you have an update, write {status, blocker, nextAction, lastUpdate} into ~/.aios/state/chat-agents/wrms-tool-agent/config.json so the control centre reflects it.`,
    },
    {
      id: "wrms-vendor-agent",
      label: "wrms-vendor-agent",
      role: "vendor app/api · digital payment + apk",
      cwd: `${WRMS_ROOT}/core/wrms-vendor-app-flutter`,
      prompt:
        `you are wrms-vendor-agent — you own the vendor app (this dir, flutter) and vendor-api (../wrms-vendor-api). ` +
        `mission: "${mission}". drive the digital-payment work in the vendor app + api and get to a built apk. ` +
        `verify it compiles (flutter build apk) before claiming done. ` +
        `write {status, blocker, nextAction, lastUpdate} into ~/.aios/state/chat-agents/wrms-vendor-agent/config.json as you progress so the control centre stays honest.`,
    },
    {
      id: "wrms-collector-agent",
      label: "wrms-collector-agent",
      role: "collector app/api · digital payment",
      cwd: `${WRMS_ROOT}/core/wrms-collector-flutter`,
      prompt:
        `you are wrms-collector-agent — you own the collector app (this dir, flutter) and collector-api (../wrms-collector-api). ` +
        `mission: "${mission}". handle any collector-side digital-payment work needed for the apk. ` +
        `verify it compiles before claiming done. ` +
        `write {status, blocker, nextAction, lastUpdate} into ~/.aios/state/chat-agents/wrms-collector-agent/config.json as you progress.`,
    },
  ];
}

/** Idempotent: creates the three WRMS control-centre agents if absent. Safe to
 *  call on every mount — createAgent returns the existing agent on id match. */
export function seedWrmsControlCentre(): void {
  for (const seed of wrmsAgentSeeds()) {
    createAgent({
      label: seed.label,
      mission: seed.role,
      engine: "claude",
      model: "claude-opus-4-8",
      permissionMode: "bypassPermissions",
      prompt: seed.prompt,
      cwd: seed.cwd,
      role: seed.role,
    });
  }
}

// ── seeded task backlog ──────────────────────────────────────────────────────
// Concrete, dispatchable jobs firaz wants to run from the shell himself (he asked
// to "seed them in"). Each targets one of the WRMS agents and opens a chat pane
// in the right repo, seeded with the task prompt. Static seeds = a reminder list;
// firing one doesn't consume it (re-runnable). Investigate-first framing so a
// dispatch never mutates prod without his sign-off.

export interface BoardTask {
  id: string;
  title: string;
  /** Display tag for which lane this belongs to. */
  lane: string;
  /** Working dir the dispatched chat opens in. */
  cwd: string;
  /** Opening prompt fired into the chat pane. */
  prompt: string;
}

/** The active mission, expressed AS a dispatchable task so it sits at the top of
 *  the backlog and can be fired like any other. Derived from getMission() so it
 *  tracks edits. Defaults into the vendor app (where the apk lives). */
export function missionTask(): BoardTask {
  const mission = getMission();
  return {
    id: "mission",
    title: mission,
    lane: "mission · vendor",
    cwd: `${WRMS_ROOT}/core/wrms-vendor-app-flutter`,
    prompt:
      `this is the active mission: "${mission}". drive it to DONE. ` +
      `it's the digital-payment apk — build the digital payment into the vendor app (this dir) + vendor-api (../wrms-vendor-api) and produce a built apk. ` +
      `verify it compiles (flutter build apk) before claiming done. report progress + any blocker.`,
  };
}

export function wrmsSeedTasks(): BoardTask[] {
  return [
    {
      id: "sin-w2e-outlets",
      title: "SIN-W2E imported outlets not visible in admin web",
      lane: "data · tool",
      cwd: WRMS_ROOT,
      prompt:
        "henry + i can't see the SIN-W2E imported outlets in wrms-admin-web. " +
        "investigate why (likely not activated, or wrong country/company/depot scoping, or is_active/is_deleted flag). " +
        "admin web lists outlets via the LoopBack wrms-api (/get-outlets, /search-outlets-query) with a `where` filter — check what default filter wrms-admin-web (core/wrms-admin-web, Outlets page) sends. " +
        "then query the DB: do the SIN-W2E rows exist? how many? what are their active/country/depot values? identify the exact fix (which column on which rows) but DO NOT apply it — report for me to confirm.",
    },
    {
      id: "wa-bot-health",
      title: "verify WA bot is replying — MY / SG / Brunei",
      lane: "bot · tool",
      cwd: WRMS_ROOT,
      prompt:
        "verify the FHE/WRMS whatsapp vendor bot is actually replying to users across all three countries: malaysia, singapore, brunei. " +
        "the stack is multi-tenant with per-country DBs. check each country's bot path: is inbound being received, is the bot generating + sending replies, any errors/stuck queues. " +
        "report per-country status (replying / not replying / partial) and the root cause + fix for any that are down. read-only first.",
    },
    {
      id: "sin-w2e-collections",
      title: "verify SIN-W2E list can make collections via WA bot",
      lane: "e2e · vendor",
      cwd: `${WRMS_ROOT}/core/wrms-vendor-api`,
      prompt:
        "end-to-end check: confirm the imported SIN-W2E outlet list can actually MAKE COLLECTIONS through the whatsapp bot. " +
        "trace the flow: outlet exists + active → vendor/outlet recognized by the bot via phone lookup → schedule/collection request writes correctly → collection record created against the right outlet/depot. " +
        "depends on the outlet-visibility + bot-health tasks. report where the chain breaks (if anywhere) with the specific fix. read-only / staging first — no prod writes without my confirm.",
    },
  ];
}

/** Reads the fs mirror (config.json per agent, possibly updated by the agent
 *  itself) and merges the status-board fields back into localStorage. This is
 *  what turns the board into a control CENTRE rather than a launcher — the
 *  oracle dispatches, the agent writes its status, this pulls it back. */
export async function syncAgentsFromDisk(): Promise<void> {
  let disk: unknown[];
  try {
    disk = await invoke<unknown[]>("agent_list");
  } catch {
    return; // outside tauri / no fs — keep localStorage as-is
  }
  if (!Array.isArray(disk)) return;
  const local = readStore();
  let changed = false;
  for (const raw of disk) {
    if (!raw || typeof raw !== "object") continue;
    const d = raw as Partial<AgentConfig>;
    if (!d.id) continue;
    const idx = local.findIndex((a) => a.id === d.id);
    if (idx < 0) continue; // only merge into agents we know
    const cur = local[idx];
    const merged: AgentConfig = { ...cur };
    if (d.status && d.status !== cur.status) merged.status = d.status;
    if (typeof d.blocker === "string" && d.blocker !== cur.blocker) merged.blocker = d.blocker;
    if (typeof d.nextAction === "string" && d.nextAction !== cur.nextAction) merged.nextAction = d.nextAction;
    if (typeof d.lastUpdate === "number" && d.lastUpdate !== cur.lastUpdate) merged.lastUpdate = d.lastUpdate;
    if (typeof d.role === "string" && d.role !== cur.role) merged.role = d.role;
    if (JSON.stringify(merged) !== JSON.stringify(cur)) {
      local[idx] = merged;
      changed = true;
    }
  }
  if (changed) writeStore(local);
}

// ── goal drivers + loops (read-only mission-control feeds) ───────────────────
// Source of truth lives on disk (the box's aios-goal-tick / aios-loop write it),
// NOT in localStorage — these are additive read-only views so firaz can see
// every active goal + running loop in the installed shell, alongside the WRMS
// lane. Outside tauri (web build) the invoke rejects and we return [] so the
// sections simply don't render.

/** One active goal driver — mirror of goals/active/<id>/state.json. */
export interface GoalDriver {
  id: string;
  goal: string;
  priority?: string;
  window?: string;
  kind?: string;
  status?: string;
  nextStep?: string;
  blocker?: string;
  progress?: unknown[];
  lastUpdate?: string;
}

/** Lists every active goal driver from `~/.aios/state/goals/active`. */
export async function listGoals(): Promise<GoalDriver[]> {
  try {
    const disk = await invoke<unknown[]>("goal_list");
    if (!Array.isArray(disk)) return [];
    return disk.filter(
      (g): g is GoalDriver => Boolean(g && typeof g === "object" && (g as GoalDriver).goal),
    );
  } catch {
    return [];
  }
}

/** One running loop — name, cadence, and its last log line. */
export interface LoopInfo {
  name: string;
  cadence: string;
  lastLog: string;
}

/** Lists active loops from `~/.aios/state/loops/*.meta` (+ last log line). */
export async function listLoops(): Promise<LoopInfo[]> {
  try {
    const disk = await invoke<unknown[]>("loop_list");
    if (!Array.isArray(disk)) return [];
    return disk.filter(
      (l): l is LoopInfo => Boolean(l && typeof l === "object" && (l as LoopInfo).name),
    );
  } catch {
    return [];
  }
}

// ── control-hook payload shapes (the `control-command` Tauri event) ──────────
// Emitted by control.rs on a valid POST. App.tsx listens and routes these.

export interface RunAgentCommand {
  cmd: "run-agent";
  agentId?: string;
  /** Inline overrides when the agent isn't persisted (a one-off poke). */
  model?: string;
  prompt?: string;
  cwd?: string;
}

export interface OpenPaneCommand {
  cmd: "open-pane";
  paneType?: string;
  key?: string;
  /** chat: initial prompt to auto-run (zero-paste handoff). shell: command to run. */
  seed?: string;
  /** working dir for the spawned pane. */
  cwd?: string;
  /** override the pane label. */
  label?: string;
}

export type ControlCommand = RunAgentCommand | OpenPaneCommand;
