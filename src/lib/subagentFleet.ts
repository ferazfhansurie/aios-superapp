import type { ChatEvent } from "./chat";

/**
 * Live sub-agent ("fleet") tracker for the chat pane.
 *
 * When the main agent calls the `Task` tool to spawn a sub-agent (or fans out
 * several in one `assistant` turn), claude's `--output-format stream-json`
 * surfaces it as a top-level `tool_use` block named `Task`. Every event the
 * sub-agent then emits — its own `assistant`/`user`/`stream_event` lines —
 * carries a top-level `parent_tool_use_id` equal to that Task block's id. The
 * Task finishes when a top-level `user` event delivers a `tool_result` whose
 * `tool_use_id` matches the Task block id (its `is_error` flag → failed).
 *
 * This reducer consumes the SAME `ChatEvent` stream the transcript already
 * reads and folds it into a list of `FleetAgent`s for the active turn. It is
 * deliberately self-contained and additive — it never touches the transcript
 * or run-event state, so if no Task ever spawns the fleet stays empty and the
 * UI renders nothing.
 *
 * Codex uses a different wire shape: agent fanout can appear as an ordinary
 * tool call, often through MCP, rather than claude's literal `Task` block. This
 * reducer treats tool names/inputs that identify Task/agent/subagent/multi-agent
 * work as fleet agents too. Explicit AIOS worker panes still arrive as synthetic
 * `aios_agent_spawned` events and render in the same fleet list.
 */

export type FleetStatus = "running" | "done" | "failed";

export interface FleetAgent {
  /** The Task tool_use block id — the join key for every nested event. */
  id: string;
  /** Human label: the Task `description`, falling back to `subagent_type`. */
  label: string;
  /** The sub-agent type (e.g. "general-purpose", "Explore"), if given. */
  subagentType?: string;
  status: FleetStatus;
  /** The most recent line of activity from inside the sub-agent (a text
   *  snippet or a "running <tool>" note) — the live "last line" preview. */
  lastLine?: string;
  /** Best-effort token total accumulated from the sub-agent's own usage. */
  tokens?: number;
  /** Stable pane key when this is a visible AIOS worker pane (`agent:<id>`). */
  paneKey?: string;
  /** When the spawn was first seen (ms epoch) — for ordering + duration. */
  startedAt: number;
  /** When it resolved (ms epoch), if it has. */
  endedAt?: number;
}

/**
 * A `Workflow`-tool run (the phase-tree fan-out behind `/workflows`).
 *
 * IMPORTANT — observability limit (verified against real captured transcripts,
 * 2026-06-20): the Workflow tool runs OPAQUELY in a background process. From the
 * `claude -p --output-format stream-json` stream we only ever see two things:
 *
 *   1. the `Workflow` tool_use block — its `input.script` is JS SOURCE whose
 *      `export const meta = { name, description, phases: [{title, detail}] }`
 *      declares the run's name + phase list. We parse those out of the source.
 *   2. a single `tool_result` — "Workflow launched in background. … Run ID: …
 *      Use /workflows to watch live progress."
 *
 * The fanned-out phase agents do NOT surface inline: they carry NO
 * `parent_tool_use_id` back to the Workflow block, emit no nested Task/assistant
 * lines in this stream, and write to a SEPARATE `subagents/workflows/wf_*`
 * transcript dir that only the `/workflows` TUI reads. So per-phase / per-agent
 * LIVE progress is NOT available here — we surface the run + its DECLARED phases
 * (from meta) and mark it "running in background", which is the faithful thing.
 */
export type WorkflowStatus = "running" | "done" | "failed";

export interface WorkflowPhase {
  title: string;
  detail?: string;
}

export interface FleetWorkflow {
  /** The Workflow tool_use block id — join key for its tool_result. */
  id: string;
  /** meta.name, falling back to meta.description / "workflow". */
  label: string;
  /** meta.description, when distinct from the label. */
  description?: string;
  /** Phases declared in the script's `meta.phases` (best-effort parse). */
  phases: WorkflowPhase[];
  status: WorkflowStatus;
  /** The "Run ID: wf_…" echoed back in the launch tool_result. */
  runId?: string;
  startedAt: number;
  endedAt?: number;
}

export interface FleetState {
  /** Insertion-ordered list of agents seen this turn. */
  agents: FleetAgent[];
  /** Insertion-ordered Workflow runs launched this turn (usually 0). */
  workflows: FleetWorkflow[];
}

export const emptyFleetState = (): FleetState => ({ agents: [], workflows: [] });

export interface FleetReduceOptions {
  now?: number;
}

/** Pull a top-level `parent_tool_use_id` off a raw stream line (loose — the
 *  field isn't in the typed `ChatEvent` shape but rides along on every nested
 *  sub-agent line). Returns null for main-agent lines. */
function parentToolUseId(ev: ChatEvent): string | null {
  const raw = ev as Record<string, unknown>;
  const v = raw.parent_tool_use_id ?? raw.parentToolUseId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function str(input: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!input) return undefined;
  const v = input[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function toolIdentity(name: string, input: Record<string, unknown> | undefined): string {
  return [
    name,
    str(input, "name"),
    str(input, "tool"),
    str(input, "tool_name"),
    str(input, "server"),
    str(input, "description"),
    str(input, "query"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isAgentTool(name: string, input: Record<string, unknown> | undefined): boolean {
  const id = toolIdentity(name, input);
  if (/\b(task|subagent|sub-agent|multi[-_ ]?agent|parallel[-_ ]?agent|spawn[-_ ]?agent)\b/.test(id)) {
    return true;
  }
  return /\bagent\b/.test(id) && !/\b(user[-_ ]?agent|browser[-_ ]?agent|agent[-_ ]?message)\b/.test(id);
}

function tokensFromUsage(usage: Record<string, unknown> | undefined): number | undefined {
  if (!usage) return undefined;
  const n = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
  const total =
    n("output_tokens") +
    n("input_tokens") +
    n("cache_read_input_tokens") +
    n("cache_creation_input_tokens");
  return total > 0 ? total : undefined;
}

/** Flatten a tool_result `content` (string | array-of-blocks) into plain text. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x) =>
        typeof x === "string"
          ? x
          : x && typeof x === "object" && "text" in x
            ? String((x as { text?: unknown }).text ?? "")
            : "",
      )
      .join("\n");
  }
  return "";
}

/** Pull the first single/double-quoted string value for `key:` out of JS source
 *  (the Workflow `meta` is JS, not JSON, so we can't JSON.parse it). Best-effort
 *  + intentionally forgiving — a miss just means a thinner label. */
function metaString(src: string, key: string): string | undefined {
  const m = new RegExp(`${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(src);
  if (!m) return undefined;
  // unescape the common \' \" \\ \n we may have captured
  const v = m[2].replace(/\\(['"`\\])/g, "$1").replace(/\\n/g, " ").trim();
  return v.length > 0 ? v : undefined;
}

/** Best-effort parse of a Workflow script's `meta.phases` array. The script is
 *  JS source, so we scan the `phases:` array region for `title:`/`detail:`
 *  string literals rather than parsing JS. Returns [] if none are found. */
function parseWorkflowPhases(src: string): WorkflowPhase[] {
  const start = src.search(/phases\s*:\s*\[/);
  if (start < 0) return [];
  // find the matching close bracket from the opening `[`
  const open = src.indexOf("[", start);
  if (open < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const region = end > open ? src.slice(open + 1, end) : src.slice(open + 1);
  const phases: WorkflowPhase[] = [];
  // split on top-level `},{` object boundaries inside the array
  const re = /\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    const title = metaString(m[1], "title");
    if (!title) continue;
    const detail = metaString(m[1], "detail");
    phases.push(detail ? { title, detail } : { title });
  }
  return phases;
}

/** Parse the launch tool_result text for the echoed "Run ID: wf_…". */
function parseRunId(text: string): string | undefined {
  const m = /Run ID:\s*(\S+)/.exec(text);
  return m ? m[1] : undefined;
}

/** A short one-line preview of what a sub-agent event represents. */
function previewFromBlock(block: { type: string; text?: string; name?: string; input?: Record<string, unknown>; thinking?: string }): string | undefined {
  if (block.type === "text" && block.text?.trim()) {
    return block.text.trim().replace(/\s+/g, " ").slice(0, 120);
  }
  if (block.type === "thinking" && block.thinking?.trim()) {
    return block.thinking.trim().replace(/\s+/g, " ").slice(0, 120);
  }
  if (block.type === "tool_use" && block.name) {
    const target =
      str(block.input, "description") ??
      str(block.input, "file_path") ??
      str(block.input, "path") ??
      str(block.input, "command") ??
      str(block.input, "pattern") ??
      str(block.input, "query") ??
      str(block.input, "url");
    return target ? `${block.name}: ${target}`.slice(0, 120) : block.name;
  }
  return undefined;
}

function updateAgent(
  state: FleetState,
  id: string,
  patch: (a: FleetAgent) => FleetAgent,
): FleetState {
  const idx = state.agents.findIndex((a) => a.id === id);
  if (idx < 0) return state;
  const next = state.agents.slice();
  next[idx] = patch(next[idx]);
  return { ...state, agents: next };
}

function updateWorkflow(
  state: FleetState,
  id: string,
  patch: (w: FleetWorkflow) => FleetWorkflow,
): FleetState {
  const idx = state.workflows.findIndex((w) => w.id === id);
  if (idx < 0) return state;
  const next = state.workflows.slice();
  next[idx] = patch(next[idx]);
  return { ...state, workflows: next };
}

/** Fold one stream event into the fleet state. Returns the same reference when
 *  nothing changed (cheap to call on every event). */
export function reduceFleet(
  state: FleetState,
  ev: ChatEvent,
  opts: FleetReduceOptions = {},
): FleetState {
  const now = opts.now ?? Date.now();

  if (ev.type === "aios_agent_spawned") {
    const raw = ev as Record<string, unknown>;
    const paneKey = typeof raw.paneKey === "string" ? raw.paneKey : undefined;
    const id = paneKey || (typeof raw.id === "string" ? raw.id : "");
    if (!id) return state;
    const label =
      typeof raw.label === "string" && raw.label.trim()
        ? raw.label.trim()
        : id.replace(/^agent:/, "");
    const cwd = typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd.trim() : "";
    const lastLine = cwd ? `opened worker pane in ${cwd}` : "opened worker pane";
    if (state.agents.some((a) => a.id === id)) {
      return updateAgent(state, id, (a) => ({
        ...a,
        status: "running",
        lastLine,
        paneKey: paneKey ?? a.paneKey,
      }));
    }
    return {
      ...state,
      agents: [
        ...state.agents,
        {
          id,
          label,
          subagentType: "aios-agent",
          status: "running",
          lastLine,
          paneKey,
          startedAt: now,
        },
      ],
    };
  }

  // 1) Spawn detection — a main-agent `assistant` turn with Task tool_use
  //    block(s). parent_tool_use_id must be null/absent (it's the parent).
  if (ev.type === "assistant" && parentToolUseId(ev) == null) {
    let next = state;
    for (const block of ev.message?.content ?? []) {
      if (block.type !== "tool_use") continue;
      const name = (block.name ?? "").toLowerCase();
      const id = block.id;
      if (!id) continue;

      // Workflow run (the /workflows phase-tree fan-out). Runs opaquely in a
      // background process — only the launch block + a launch tool_result reach
      // this stream — so we capture its declared meta (name + phases) and mark
      // it running. Per-agent live progress is NOT observable here (see header).
      if (name === "workflow") {
        if (next.workflows.some((w) => w.id === id)) continue;
        const script =
          str(block.input, "script") ?? str(block.input, "scriptPath") ?? "";
        const metaName = metaString(script, "name");
        const description = metaString(script, "description");
        const label = metaName ?? description ?? "workflow";
        next = {
          ...next,
          workflows: [
            ...next.workflows,
            {
              id,
              label,
              description:
                description && description !== label ? description : undefined,
              phases: parseWorkflowPhases(script),
              status: "running",
              startedAt: now,
            },
          ],
        };
        continue;
      }

      if (!isAgentTool(name, block.input)) continue;
      if (next.agents.some((a) => a.id === id)) continue;
      const subagentType =
        str(block.input, "subagent_type") ??
        str(block.input, "agent_type") ??
        str(block.input, "server") ??
        str(block.input, "tool");
      const label =
        str(block.input, "description") ??
        str(block.input, "task") ??
        str(block.input, "prompt") ??
        str(block.input, "query") ??
        subagentType ??
        "sub-agent";
      next = {
        ...next,
        agents: [
          ...next.agents,
          { id, label, subagentType, status: "running", startedAt: now },
        ],
      };
    }
    return next;
  }

  // 2) Completion — a main-agent `user` turn carrying the Task's tool_result.
  if (ev.type === "user" && parentToolUseId(ev) == null) {
    let next = state;
    for (const block of ev.message?.content ?? []) {
      if (block.type !== "tool_result") continue;
      const id = block.tool_use_id;
      if (!id) continue;
      const failed = block.is_error === true;

      // A Workflow's tool_result is a LAUNCH ack ("launched in background … Run
      // ID: …"), not a completion — the run keeps going opaquely afterward. So a
      // successful launch stays "running" (we just capture the runId); only a
      // failed launch resolves it. There's no completion signal in this stream.
      if (next.workflows.some((w) => w.id === id)) {
        const runId = parseRunId(resultText(block.content));
        next = updateWorkflow(next, id, (w) =>
          w.status === "running"
            ? failed
              ? { ...w, status: "failed", endedAt: now }
              : { ...w, runId: runId ?? w.runId }
            : w,
        );
        continue;
      }

      if (!next.agents.some((a) => a.id === id)) continue;
      next = updateAgent(next, id, (a) =>
        a.status === "running"
          ? { ...a, status: failed ? "failed" : "done", endedAt: now }
          : a,
      );
    }
    return next;
  }

  // 3) Nested sub-agent activity — any line tagged with our parent id. Refresh
  //    the owning agent's last-line preview + accumulate tokens.
  const parent = parentToolUseId(ev);
  if (!parent || !state.agents.some((a) => a.id === parent)) return state;

  if (ev.type === "assistant") {
    let preview: string | undefined;
    for (const block of ev.message?.content ?? []) {
      const p = previewFromBlock(block);
      if (p) preview = p;
    }
    const tok = tokensFromUsage(ev.message?.usage);
    if (preview == null && tok == null) return state;
    return updateAgent(state, parent, (a) => ({
      ...a,
      lastLine: preview ?? a.lastLine,
      tokens: tok != null ? Math.max(a.tokens ?? 0, tok) : a.tokens,
    }));
  }

  if (ev.type === "stream_event") {
    const delta = ev.event?.delta;
    const text = delta?.type === "text_delta" ? delta.text : undefined;
    if (!text) return state;
    return updateAgent(state, parent, (a) => ({
      ...a,
      // append a little, keep it a single trailing snippet
      lastLine: ((a.lastLine ?? "") + text).replace(/\s+/g, " ").slice(-120),
    }));
  }

  return state;
}
