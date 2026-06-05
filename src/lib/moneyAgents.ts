export type MoneyAgentHealth = "running" | "scheduled" | "needs-steer" | "failed" | "unknown";

export interface MoneyAgentConfig {
  id: string;
  label: string;
  shortLabel: string;
  launchdLabel: string;
  statePath: string;
  queuePath: string;
  stdoutPath: string;
  stderrPath: string;
  cwd: string;
  mission: string;
  schedule?: string;
}

export interface MoneyAgentLaunchdState {
  running: boolean;
  lastExit: number | null;
}

export interface MoneyAgentRawState {
  status?: Record<string, any> | null;
  queue?: any[] | Record<string, any> | null;
  launchd?: MoneyAgentLaunchdState | null;
}

export interface MoneyAgentSummary {
  id: MoneyAgentConfig["id"];
  label: string;
  health: MoneyAgentHealth;
  primaryMetric: string;
  nextAction: string;
  currentJob: string;
  schedule?: string;
  lastRunAt?: number | null;
}

export interface MoneyAgentDetail extends MoneyAgentSummary {
  mission: string;
  schedule: string;
  stdoutPath: string;
  stderrPath: string;
  statePath: string;
  queuePath: string;
  logTail: string[];
}

export interface MoneyAgentChatSession {
  sessionId: string;
  title: string;
  updatedAt: number;
}

const home = "/Users/firazfhansurie";
const aiosOutputs = `${home}/Repo/firaz/adletic/aios-firaz/outputs`;
const customAgentsKey = "aios.chatAgents.custom";
const lastScheduledRunKey = (id: string) => `aios.chatAgents.lastScheduledRun:${id}`;

export const AGENT_CHAT_MODEL = "gpt-5.3-codex-spark";

export const MONEY_AGENTS: MoneyAgentConfig[] = [
  {
    id: "firaz",
    label: "firaz",
    shortLabel: "firaz",
    launchdLabel: "aios.chatpane.firaz",
    statePath: `${home}/.aios/state/chat-agents/firaz/status.json`,
    queuePath: `${home}/.aios/state/chat-agents/firaz/queue.json`,
    stdoutPath: `${home}/Library/Logs/aios-chat-agents/firaz-out.log`,
    stderrPath: `${home}/Library/Logs/aios-chat-agents/firaz-err.log`,
    cwd: `${home}/Repo/firaz/adletic/aios-firaz`,
    mission: "firaz's personal aios cofounder loop, goals, shell control, and execution follow-through",
    schedule: "always-on",
  },
  {
    id: "growth",
    label: "growth agents",
    shortLabel: "growth",
    launchdLabel: "com.firaz.aios-growth-agents",
    statePath: `${home}/.aios/state/growth-agents/status.json`,
    queuePath: `${home}/.aios/state/growth-agents/queue/social-posts.json`,
    stdoutPath: `${home}/Library/Logs/aios-growth-agents/out.log`,
    stderrPath: `${home}/Library/Logs/aios-growth-agents/err.log`,
    cwd: `${aiosOutputs}/aios-growth-agents`,
    mission: "threads, landing page, discord, and support loop",
    schedule: "daily work blocks",
  },
  {
    id: "outreach",
    label: "agency outreach",
    shortLabel: "outreach",
    launchdLabel: "com.firaz.aios-agency-outreach-scout",
    statePath: `${home}/.aios/state/outreach/agencies/status.json`,
    queuePath: `${home}/.aios/state/outreach/agencies/queue.json`,
    stdoutPath: `${home}/Library/Logs/aios-growth-agents/agency-scout-out.log`,
    stderrPath: `${home}/Library/Logs/aios-growth-agents/agency-scout-err.log`,
    cwd: `${aiosOutputs}/aios-agency-outreach-scout`,
    mission: "research, qualify, demo, and draft agency leads",
    schedule: "daily work blocks",
  },
];

function normalizeAgentId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^aios-/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function loadCustomMoneyAgents(): MoneyAgentConfig[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(customAgentsKey) || "[]") as Partial<MoneyAgentConfig>[];
    return raw.reduce<MoneyAgentConfig[]>((agents, agent) => {
        const id = normalizeAgentId(String(agent.id || agent.label || ""));
        if (!id || !agent.label) return agents;
        const label = String(agent.label).trim();
        const mission = String(agent.mission || "custom aios chatpane agent").trim();
        agents.push({
          id,
          label,
          shortLabel: String(agent.shortLabel || id).trim(),
          launchdLabel: `aios.chatpane.${id}`,
          statePath: String(agent.statePath || `${home}/.aios/state/chat-agents/${id}/status.json`),
          queuePath: String(agent.queuePath || `${home}/.aios/state/chat-agents/${id}/queue.json`),
          stdoutPath: String(agent.stdoutPath || `${home}/Library/Logs/aios-chat-agents/${id}-out.log`),
          stderrPath: String(agent.stderrPath || `${home}/Library/Logs/aios-chat-agents/${id}-err.log`),
          cwd: String(agent.cwd || `${home}`),
          mission,
          schedule: String(agent.schedule || "manual").trim(),
        });
        return agents;
      }, []);
  } catch {
    return [];
  }
}

export function loadConfiguredMoneyAgents(): MoneyAgentConfig[] {
  // Default: NO agents. The shell ships with an empty sidebar — only agents the
  // user explicitly creates show up. `MONEY_AGENTS` stays as a catalog of known
  // ids (for seed/role lookups), but is no longer auto-populated.
  const seen = new Set<string>();
  return loadCustomMoneyAgents().filter((agent) => {
    if (seen.has(agent.id)) return false;
    seen.add(agent.id);
    return true;
  });
}

/** Removes a user-created agent and its persisted chat session / schedule state.
 *  Built-in catalog agents (MONEY_AGENTS) aren't shown by default, so this only
 *  ever needs to drop a custom agent. No-op if the id isn't a custom agent. */
export function removeMoneyAgent(id: string): void {
  if (typeof localStorage === "undefined") return;
  const next = loadCustomMoneyAgents().filter((agent) => agent.id !== id);
  localStorage.setItem(customAgentsKey, JSON.stringify(next));
  try {
    localStorage.removeItem(agentChatSessionKey(id));
    localStorage.removeItem(lastScheduledRunKey(id));
  } catch {
    /* ignore */
  }
}

export function createMoneyAgent(input: {
  label: string;
  mission?: string;
  schedule?: string;
  cwd?: string;
}): MoneyAgentConfig | null {
  if (typeof localStorage === "undefined") return null;
  const label = input.label.trim();
  const id = normalizeAgentId(label);
  if (!id) return null;
  const existing = loadConfiguredMoneyAgents().find((agent) => agent.id === id);
  if (existing) return existing;
  const agent: MoneyAgentConfig = {
    id,
    label,
    shortLabel: id,
    launchdLabel: `aios.chatpane.${id}`,
    statePath: `${home}/.aios/state/chat-agents/${id}/status.json`,
    queuePath: `${home}/.aios/state/chat-agents/${id}/queue.json`,
    stdoutPath: `${home}/Library/Logs/aios-chat-agents/${id}-out.log`,
    stderrPath: `${home}/Library/Logs/aios-chat-agents/${id}-err.log`,
    cwd: input.cwd?.trim() || home,
    mission: input.mission?.trim() || "custom aios chatpane agent",
    schedule: input.schedule?.trim() || "manual",
  };
  const next = [...loadCustomMoneyAgents(), agent];
  localStorage.setItem(customAgentsKey, JSON.stringify(next));
  return agent;
}

export function moneyAgentById(id: string): MoneyAgentConfig | undefined {
  return loadConfiguredMoneyAgents().find((agent) => agent.id === id);
}

const agentChatSessionKey = (id: string) => `aios.moneyAgent.chatSession:${id}`;

export function loadMoneyAgentChatSession(id: string): MoneyAgentChatSession | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(agentChatSessionKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MoneyAgentChatSession>;
    if (!parsed.sessionId || !parsed.title) return null;
    return {
      sessionId: parsed.sessionId,
      title: parsed.title,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveMoneyAgentChatSession(id: string, session: MoneyAgentChatSession): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(agentChatSessionKey(id), JSON.stringify(session));
  } catch {
    /* ignore */
  }
}

export function loadMoneyAgentLastScheduledRun(id: string): number | null {
  if (typeof localStorage === "undefined") return null;
  const value = Number(localStorage.getItem(lastScheduledRunKey(id)) || "0");
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function buildMoneyAgentChatSeed(agent: MoneyAgentConfig): string {
  const role = (() => {
    if (agent.id === "firaz") {
      return "you are aios, firaz's ai co-founder. run inside the local tauri shell chatpane, keep goals moving, and use pane-native actions before terminal work.";
    }
    if (agent.id === "growth") {
      return "you are the aios growth manager. run the threads, landing page, discord, and support growth loop for firaz.";
    }
    if (agent.id === "outreach") {
      return "you are the aios agency outreach operator. research, qualify, draft, and nurture marketing agency leads for firaz.";
    }
    return `you are the aios ${agent.label} agent. execute this mission for firaz from a chatpane: ${agent.mission}.`;
  })();
  const guardrail = (() => {
    if (agent.id === "outreach") {
      return "do not blast or send whatsapp messages. prepare researched targets, evidence, and high-signal drafts, then write a pending approval item for the shell control plane.";
    }
    if (agent.id === "growth") {
      return "do not autopost weak content. build hooks and post ideas firaz would actually publish, then write a pending approval item for the shell control plane when risk is non-trivial.";
    }
    if (agent.id === "firaz") {
      return "do not open terminal/oracle panes as the primary interface. use the existing chatpane session as the agent home, and only use terminal for concrete tools.";
    }
    return "do not execute irreversible external actions. produce concrete next steps, artifacts, observable run state, and pending approval items for the shell control plane.";
  })();

  return [
    role,
    "",
    "context:",
    `- agent: ${agent.label}`,
    `- mission: ${agent.mission}`,
    `- model: ${AGENT_CHAT_MODEL}`,
    `- schedule: ${agent.schedule || "manual"}`,
    `- workspace: ${agent.cwd}`,
    `- state file: ${agent.statePath}`,
    `- queue file: ${agent.queuePath}`,
    "",
    "operating rules:",
    "- act like a live goal-moving operator, not a logger.",
    "- start by inspecting current state, queue, recent outputs, and repo context before proposing work.",
    "- do not ask firaz to continue, approve, or tell you what to do next inside this agent chat.",
    "- treat this chat as an ordered execution log for the aios shell to monitor and control.",
    "- continue autonomously inside your policy limits; when blocked, write a concise pending approval item instead of asking a question.",
    "- report concrete next actions, current blockers, and what moves the goal.",
    `- ${guardrail}`,
    "- if work needs background execution, create/steer the right local process and report exactly where it is observable.",
    "",
    "first task:",
    "load your current state, take the next useful action, and leave an ordered status entry for the shell control plane.",
  ].join("\n");
}

export function buildMoneyAgentRunCommand(agent: { label: string }, reason = "manual"): string {
  return [
    `run a ${reason} sales pulse for ${agent.label}.`,
    "",
    "goal: get sales for aios, the shell app that monitors, controls, creates, schedules, and runs chatpane agents.",
    "",
    "do now:",
    "- inspect your current state, queue, prior outputs, and relevant local context.",
    "- choose the single highest-leverage revenue action for today.",
    "- produce the artifact or draft inside this chatpane.",
    "- do not ask firaz what to do next.",
    "- if approval is needed, write a pending approval item for the shell control plane.",
    "- report blocker, next step, and the control decision needed.",
  ].join("\n");
}

function queueCount(queue: MoneyAgentRawState["queue"]): number {
  if (Array.isArray(queue)) return queue.length;
  if (queue && typeof queue === "object") {
    const values = Object.values(queue);
    const firstArray = values.find(Array.isArray);
    if (Array.isArray(firstArray)) return firstArray.length;
  }
  return 0;
}

export function summarizeMoneyAgentState(
  agent: MoneyAgentConfig,
  raw: MoneyAgentRawState,
): MoneyAgentSummary {
  const status = raw.status ?? {};
  const launchd = raw.launchd;
  const queued = typeof status.queued === "number" ? status.queued : queueCount(raw.queue);
  const dryRun = Boolean(status.dryRun ?? status.mode === "dry-run");
  const next = status.next ?? status.agents?.["social-media-agent"]?.next;
  const nextName = next?.name ?? next?.id ?? next?.route ?? "";

  let health: MoneyAgentHealth = "unknown";
  if (launchd?.lastExit && launchd.lastExit !== 0) health = "failed";
  else if (launchd?.running) health = dryRun ? "needs-steer" : "running";
  else if (launchd && launchd.lastExit === 0) health = "scheduled";
  else if (status.ok === true) health = dryRun ? "needs-steer" : "running";

  if (agent.id === "firaz") {
    return {
      id: agent.id,
      label: agent.label,
      health: health === "unknown" ? "running" : health,
      primaryMetric: AGENT_CHAT_MODEL.replace("gpt-", ""),
      currentJob: "personal goals and shell control",
      nextAction: "open the existing firaz chatpane agent",
      schedule: agent.schedule || "manual",
      lastRunAt: loadMoneyAgentLastScheduledRun(agent.id),
    };
  }

  if (agent.id === "growth") {
    return {
      id: agent.id,
      label: agent.label,
      health,
      primaryMetric: `${queued} queued`,
      currentJob: nextName || "waiting for next content slot",
      nextAction: dryRun
        ? "approve autopost policy or keep reviewed drafts only"
        : "publish the next approved post at the scheduled slot",
      schedule: agent.schedule || "manual",
      lastRunAt: loadMoneyAgentLastScheduledRun(agent.id),
    };
  }

  const prospects = Number(status.prospects ?? 0);
  const bespokeDemos = Number(status.bespokeDemos ?? 0);
  const lead = status.next?.name ?? "next qualified agency";
  return {
    id: agent.id,
    label: agent.label,
    health,
    primaryMetric: `${queued || prospects} leads`,
    currentJob: `${lead}${bespokeDemos ? ` · ${bespokeDemos} demos` : ""}`,
    nextAction: dryRun
      ? "review the next whatsapp draft before any send"
      : "send only reviewed, high-signal whatsapp outreach",
    schedule: agent.schedule || "manual",
    lastRunAt: loadMoneyAgentLastScheduledRun(agent.id),
  };
}

async function readJson(path: string): Promise<any | null> {
  try {
    const { readTextFile } = await import("./fs");
    return JSON.parse(await readTextFile(path));
  } catch {
    return null;
  }
}

export async function loadMoneyAgentSummaries(): Promise<MoneyAgentSummary[]> {
  const rows = await Promise.all(
    loadConfiguredMoneyAgents().map(async (agent) => {
      const [status, queue] = await Promise.all([
        readJson(agent.statePath),
        readJson(agent.queuePath),
      ]);
      return summarizeMoneyAgentState(agent, { status, queue });
    }),
  );
  return rows;
}

async function tailText(path: string, maxLines = 28): Promise<string[]> {
  try {
    const { readTextFile } = await import("./fs");
    return (await readTextFile(path)).split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

export async function loadMoneyAgentDetails(): Promise<MoneyAgentDetail[]> {
  return Promise.all(
    loadConfiguredMoneyAgents().map(async (agent) => {
      const [status, queue, stdout, stderr] = await Promise.all([
        readJson(agent.statePath),
        readJson(agent.queuePath),
        tailText(agent.stdoutPath, 18),
        tailText(agent.stderrPath, 10),
      ]);
      return {
        ...summarizeMoneyAgentState(agent, { status, queue }),
        mission: agent.mission,
        schedule: agent.schedule || "manual",
        stdoutPath: agent.stdoutPath,
        stderrPath: agent.stderrPath,
        statePath: agent.statePath,
        queuePath: agent.queuePath,
        logTail: [...stdout, ...stderr].slice(-28),
      };
    }),
  );
}
