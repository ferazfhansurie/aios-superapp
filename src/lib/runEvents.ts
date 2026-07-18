import type { ChatEvent } from "./chat";

export type RunPhase =
  | "thinking"
  | "writing"
  | "acting"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted";

export interface RunEventMeta {
  runId?: string;
  parentId?: string;
}

export type RunEvent = RunEventMeta & (
  | {
      type: "reasoning";
      id: string;
      text: string;
      streaming: boolean;
      at: number;
    }
  | {
      type: "message.delta";
      id: string;
      text: string;
      at: number;
    }
  | {
      type: "action.started";
      id: string;
      name: string;
      input: Record<string, unknown>;
      at: number;
    }
  | {
      type: "action.completed";
      id: string;
      output: string;
      isError?: boolean;
      at: number;
    }
  | {
      type: "permission.requested";
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      at: number;
    }
  | {
      type: "permission.decided";
      id: string;
      decision: "allow" | "allow_always" | "deny";
      at: number;
    }
  | {
      type: "run.completed";
      id: string;
      durationMs?: number;
      tokens?: number;
      cost?: number;
      at: number;
    }
  | {
      type: "run.failed";
      id: string;
      message: string;
      at: number;
    }
  | {
      type: "run.interrupted";
      id: string;
      at: number;
    }
);

export interface RunEventState {
  events: RunEvent[];
  phase: RunPhase;
  activeActionId?: string;
}

export const emptyRunEventState = (): RunEventState => ({
  events: [],
  phase: "completed",
});

export interface RunEventOptions {
  now?: number;
  runId?: string;
}

export type RunActionKind = "read" | "search" | "edit" | "command" | "browse" | "agent" | "other";
export type RunActionStatus = "running" | "completed" | "failed";

export interface RunActionProjection {
  id: string;
  runId?: string;
  parentId?: string;
  name: string;
  kind: RunActionKind;
  status: RunActionStatus;
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  target?: string;
  detail?: string;
}

export interface RunPermissionProjection {
  id: string;
  runId?: string;
  toolName: string;
  target?: string;
  requestedAt: number;
  decidedAt?: number;
  status: "pending" | "decided";
  decision?: "allow" | "allow_always" | "deny";
}

export interface RunReference {
  type: "changed" | "artifact";
  path: string;
  actionId?: string;
  label?: string;
}

export interface RunProjection {
  runId?: string;
  phase: RunPhase;
  actions: RunActionProjection[];
  activeActionIds: string[];
  permissions: RunPermissionProjection[];
  references: RunReference[];
  agents: RunAgentProjection[];
}

export interface RunAgentProjection {
  id: string;
  parentId?: string;
  label: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  actionIds: string[];
  target?: string;
  detail?: string;
}

export interface ProjectRunOptions {
  phase: RunPhase;
  now?: number;
  artifacts?: Array<{ path: string; name?: string }>;
  agents?: Array<{
    id: string;
    parentId?: string;
    label: string;
    status: "running" | "done" | "failed";
    startedAt: number;
    endedAt?: number;
    paneKey?: string;
    lastLine?: string;
  }>;
}

const DEFAULT_PERSISTED_EVENT_LIMIT = 500;

let eventSeq = 0;

const nextId = (prefix: string): string => `${prefix}${++eventSeq}`;

function resultToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x) => {
        if (typeof x === "string") return x;
        if (x && typeof x === "object" && "text" in x) {
          return String((x as { text?: unknown }).text ?? "");
        }
        return JSON.stringify(x);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function tokensFromUsage(usage: Record<string, unknown> | undefined): number | undefined {
  if (!usage) return undefined;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
  const cacheCreate =
    typeof usage.cache_creation_input_tokens === "number"
      ? usage.cache_creation_input_tokens
      : 0;
  const total = output + input + cacheRead + cacheCreate;
  return total > 0 ? total : undefined;
}

// Bound the live in-memory event log. Serialization already caps at
// DEFAULT_PERSISTED_EVENT_LIMIT, but the in-memory array grew unbounded across a
// long session (slow memory leak + an ever-growing slice on every persist). Keep
// a generous tail (> the persisted limit) so the visible recent timeline is
// unaffected.
const MAX_IN_MEMORY_EVENTS = 1000;

function append(state: RunEventState, events: RunEvent[], phase: RunPhase): RunEventState {
  let activeActionId = state.activeActionId;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "action.started") {
      activeActionId = event.id;
      break;
    }
  }
  const merged = [...state.events, ...events];
  return {
    events:
      merged.length > MAX_IN_MEMORY_EVENTS
        ? merged.slice(-MAX_IN_MEMORY_EVENTS)
        : merged,
    phase,
    activeActionId,
  };
}

function appendStreamingEvent(
  state: RunEventState,
  event: Extract<RunEvent, { type: "reasoning" | "message.delta" }>,
  phase: RunPhase,
): RunEventState {
  const last = state.events[state.events.length - 1];
  if (last?.type === event.type) {
    const merged = {
      ...last,
      text: last.text + event.text,
      at: event.at,
      ...(event.type === "reasoning" ? { streaming: event.streaming } : {}),
    } as RunEvent;
    return {
      ...state,
      events: [...state.events.slice(0, -1), merged],
      phase,
    };
  }
  return append(state, [event], phase);
}

function actionKind(name: string): RunActionKind {
  const key = name.toLowerCase();
  if (/read|view|open/.test(key)) return "read";
  if (/grep|glob|find|search/.test(key)) return "search";
  if (/edit|write|patch|notebook/.test(key)) return "edit";
  if (/bash|shell|terminal|command|exec/.test(key)) return "command";
  if (/browser|navigate|fetch|web/.test(key)) return "browse";
  if (/task|agent|workflow/.test(key)) return "agent";
  return "other";
}

function inputString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function actionTarget(name: string, input: Record<string, unknown>): string | undefined {
  return inputString(
    input,
    "file_path", "path", "command", "pattern", "query", "url", "description", "target",
  ) ?? (Object.keys(input).length ? name : undefined);
}

/** Fold the append-only event log into the single authoritative render model.
 * Pairing by id keeps simultaneous tools live independently; callers may add
 * durable task artifacts without teaching the stream reducer about UI cards. */
export function projectRun(events: RunEvent[], options: ProjectRunOptions): RunProjection {
  const now = options.now ?? Date.now();
  const actions = new Map<string, RunActionProjection>();
  const actionOrder: string[] = [];
  const permissions = new Map<string, RunPermissionProjection>();
  const permissionOrder: string[] = [];
  let runId: string | undefined;

  for (const event of events) {
    runId = event.runId ?? runId;
    if (event.type === "action.started") {
      if (!actions.has(event.id)) actionOrder.push(event.id);
      actions.set(event.id, {
        id: event.id,
        ...(event.runId ? { runId: event.runId } : {}),
        ...(event.parentId ? { parentId: event.parentId } : {}),
        name: event.name,
        kind: actionKind(event.name),
        status: "running",
        startedAt: event.at,
        durationMs: Math.max(0, now - event.at),
        ...(actionTarget(event.name, event.input) ? { target: actionTarget(event.name, event.input) } : {}),
        ...(Object.keys(event.input).length ? { detail: resultToText(event.input) } : {}),
      });
    } else if (event.type === "action.completed") {
      const action = actions.get(event.id);
      if (action) {
        actions.set(event.id, {
          ...action,
          status: event.isError ? "failed" : "completed",
          endedAt: event.at,
          durationMs: Math.max(0, event.at - action.startedAt),
          ...(event.output ? { detail: event.output } : {}),
        });
      }
    } else if (event.type === "permission.requested") {
      if (!permissions.has(event.id)) permissionOrder.push(event.id);
      permissions.set(event.id, {
        id: event.id,
        ...(event.runId ? { runId: event.runId } : {}),
        toolName: event.toolName,
        ...(actionTarget(event.toolName, event.input) ? { target: actionTarget(event.toolName, event.input) } : {}),
        requestedAt: event.at,
        status: "pending",
      });
    } else if (event.type === "permission.decided") {
      const permission = permissions.get(event.id);
      if (permission) permissions.set(event.id, {
        ...permission,
        status: "decided",
        decision: event.decision,
        decidedAt: event.at,
      });
    }
  }

  const projectedActions = actionOrder.map((id) => actions.get(id)!).map((action) =>
    action.status === "running" ? { ...action, durationMs: Math.max(0, now - action.startedAt) } : action,
  );
  const references: RunReference[] = projectedActions
    .filter((action) => action.kind === "edit" && action.target)
    .map((action) => ({ type: "changed", path: action.target!, actionId: action.id }));
  for (const artifact of options.artifacts ?? []) {
    if (!references.some((reference) => reference.path === artifact.path)) {
      references.push({ type: "artifact", path: artifact.path, ...(artifact.name ? { label: artifact.name } : {}) });
    }
  }
  return {
    runId,
    phase: options.phase,
    actions: projectedActions,
    activeActionIds: projectedActions.filter((action) => action.status === "running").map((action) => action.id),
    permissions: permissionOrder.map((id) => permissions.get(id)!),
    references,
    agents: (options.agents ?? []).map((agent) => ({
      id: agent.id,
      ...(agent.parentId ? { parentId: agent.parentId } : {}),
      label: agent.label,
      status: agent.status === "done" ? "completed" : agent.status,
      startedAt: agent.startedAt,
      ...(agent.endedAt != null ? { endedAt: agent.endedAt } : {}),
      durationMs: Math.max(0, (agent.endedAt ?? now) - agent.startedAt),
      actionIds: projectedActions.filter((action) => action.parentId === agent.id).map((action) => action.id),
      ...(agent.paneKey ? { target: agent.paneKey } : {}),
      ...(agent.lastLine ? { detail: agent.lastLine } : {}),
    })),
  };
}

/** Revision used by the durable task cockpit. Word-by-word token changes do
 * not need a deep-cloned workspace publish; phase/tool/result boundaries do. */
export function taskSnapshotRevision(state: RunEventState): string {
  for (let index = state.events.length - 1; index >= 0; index--) {
    const event = state.events[index];
    if (event.type === "reasoning" || event.type === "message.delta") continue;
    return `${state.phase}:${event.type}:${event.id}:${event.at}`;
  }
  return `${state.phase}:none`;
}

/** Normalizes raw chat stream frames into a durable run timeline. */
export function reduceRunEvents(
  state: RunEventState,
  ev: ChatEvent,
  opts: RunEventOptions = {},
): RunEventState {
  const at = opts.now ?? Date.now();
  const raw = ev as Record<string, unknown>;
  const eventRunId = opts.runId ?? (typeof ev.runId === "string" ? ev.runId : undefined);
  const parentId = typeof raw.parent_tool_use_id === "string"
    ? raw.parent_tool_use_id
    : typeof raw.parentToolUseId === "string" ? raw.parentToolUseId : undefined;
  const meta: RunEventMeta = {
    ...(eventRunId ? { runId: eventRunId } : {}),
    ...(parentId ? { parentId } : {}),
  };

  if (ev.type === "control_request" && ev.request?.subtype === "can_use_tool") {
    const id = ev.request_id ?? nextId("perm");
    return append(
      state,
      [
        {
          ...meta,
          type: "permission.requested",
          id,
          toolName: String(ev.request.tool_name ?? "tool"),
          input: ev.request.input ?? {},
          at,
        },
      ],
      "waiting",
    );
  }

  if (ev.type === "control_response") {
    const requestId = ev.response?.request_id ?? ev.request_id;
    const rawDecision = ev.response?.decision ?? ev.response?.behavior;
    const decision = rawDecision === "allow_always" || rawDecision === "deny" ? rawDecision : rawDecision === "allow" ? "allow" : undefined;
    return typeof requestId === "string" && decision
      ? append(state, [{ ...meta, type: "permission.decided", id: requestId, decision, at }], state.phase)
      : state;
  }

  if (ev.type === "stream_event") {
    const delta = ev.event?.delta;
    if (ev.event?.type !== "content_block_delta" || !delta) return state;
    if (delta.type === "thinking_delta" && delta.thinking) {
      return appendStreamingEvent(
        state,
        {
          ...meta,
          type: "reasoning",
          id: nextId("reasoning"),
          text: delta.thinking,
          streaming: true,
          at,
        },
        "thinking",
      );
    }
    if (delta.type === "text_delta" && delta.text) {
      return appendStreamingEvent(
        state,
        { ...meta, type: "message.delta", id: nextId("msg"), text: delta.text, at },
        "writing",
      );
    }
    return state;
  }

  if (ev.type === "assistant") {
    const out: RunEvent[] = [];
    for (const block of ev.message?.content ?? []) {
      if (block.type === "thinking" && block.thinking?.trim()) {
        out.push({
          ...meta,
          type: "reasoning",
          id: nextId("reasoning"),
          text: block.thinking,
          streaming: false,
          at,
        });
      }
      if (block.type === "text" && block.text?.trim()) {
        out.push({ ...meta, type: "message.delta", id: nextId("msg"), text: block.text, at });
      }
      if (block.type === "tool_use") {
        out.push({
          ...meta,
          type: "action.started",
          id: block.id ?? nextId("tool"),
          name: block.name ?? "tool",
          input: block.input ?? {},
          at,
        });
      }
    }
    return out.length ? append(state, out, out.some((e) => e.type === "action.started") ? "acting" : "writing") : state;
  }

  if (ev.type === "user") {
    const out: RunEvent[] = [];
    for (const block of ev.message?.content ?? []) {
      if (block.type === "tool_result") {
        out.push({
          ...meta,
          type: "action.completed",
          id: block.tool_use_id ?? nextId("tool"),
          output: resultToText(block.content),
          isError: block.is_error,
          at,
        });
      }
    }
    return out.length
      ? { ...append(state, out, "acting"), activeActionId: undefined }
      : state;
  }

  if (ev.type === "result") {
    const failed = Boolean(ev.is_error);
    return append(
      state,
      [
        failed
          ? {
              ...meta,
              type: "run.failed",
              id: nextId("run"),
              message: ev.result ?? "run failed",
              at,
            }
          : {
              ...meta,
              type: "run.completed",
              id: nextId("run"),
              durationMs: ev.duration_ms,
              tokens: tokensFromUsage(ev.usage),
              cost: ev.total_cost_usd,
              at,
            },
      ],
      failed ? "failed" : "completed",
    );
  }

  if (ev.type === "aios_stderr" && ev.text) {
    return append(
      state,
      [{ ...meta, type: "run.failed", id: nextId("run"), message: ev.text, at }],
      "failed",
    );
  }

  return state;
}

export function serializeRunEventState(
  state: RunEventState,
  limit = DEFAULT_PERSISTED_EVENT_LIMIT,
): string {
  const safeLimit = Math.max(0, limit);
  const events = safeLimit === 0 ? [] : state.events.slice(-safeLimit);
  return JSON.stringify({
    events,
    phase: state.phase,
    activeActionId: state.activeActionId,
  });
}

export function parseRunEventState(raw: string | null | undefined): RunEventState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RunEventState>;
    if (!Array.isArray(parsed.events)) return null;
    const phase = isRunPhase(parsed.phase) ? parsed.phase : "completed";
    return {
      events: parsed.events.filter(isRunEvent),
      phase,
      activeActionId:
        typeof parsed.activeActionId === "string" ? parsed.activeActionId : undefined,
    };
  } catch {
    return null;
  }
}

function isRunPhase(value: unknown): value is RunPhase {
  return (
    value === "thinking" ||
    value === "writing" ||
    value === "acting" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
  );
}

function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as { type?: unknown; id?: unknown; at?: unknown };
  if (typeof event.type !== "string" || typeof event.id !== "string") return false;
  if (typeof event.at !== "number") return false;
  return (
    event.type === "reasoning" ||
    event.type === "message.delta" ||
    event.type === "action.started" ||
    event.type === "action.completed" ||
    event.type === "permission.requested" ||
    event.type === "permission.decided" ||
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.interrupted"
  );
}

// ── localStorage hygiene: bound the per-session run-event logs ────────────────
// Each chat session persists its replay log under `aios.chat.run-events:<id>`.
// These are write-guarded (a quota throw on persist is swallowed) but never
// pruned, so they accumulate across hundreds of sessions until the ~5MB origin
// quota is full — at which point the NEXT unguarded setItem anywhere in the app
// throws QuotaExceededError uncaught, React unmounts, and the window goes blank.
// (Seen 2026-06-19: 10MB of run-events → blank boot.) Call this once at boot,
// BEFORE React mounts, so the store is slim before any new writes. Drops the
// oldest entries (localStorage iteration order ≈ insertion order in WebKit)
// until the combined run-event payload is under `maxBytes`. Never throws.
export function pruneRunEventStores(maxBytes = 2_000_000): void {
  try {
    if (typeof localStorage === "undefined") return;
    const prefix = "aios.chat.run-events:";
    const entries: Array<{ key: string; bytes: number }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      entries.push({ key, bytes: (localStorage.getItem(key) ?? "").length });
    }
    let total = entries.reduce((sum, e) => sum + e.bytes, 0);
    let i = 0;
    while (total > maxBytes && i < entries.length) {
      try {
        localStorage.removeItem(entries[i].key);
      } catch {
        /* ignore */
      }
      total -= entries[i].bytes;
      i++;
    }
  } catch {
    /* hygiene must never break boot */
  }
}
