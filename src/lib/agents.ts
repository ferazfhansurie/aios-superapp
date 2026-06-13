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
}

export type ControlCommand = RunAgentCommand | OpenPaneCommand;
