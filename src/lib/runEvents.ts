import type { ChatEvent } from "./chat";

export type RunPhase =
  | "thinking"
  | "writing"
  | "acting"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted";

export type RunEvent =
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
    };

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
}

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

function append(state: RunEventState, events: RunEvent[], phase: RunPhase): RunEventState {
  let activeActionId = state.activeActionId;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "action.started") {
      activeActionId = event.id;
      break;
    }
  }
  return {
    events: [...state.events, ...events],
    phase,
    activeActionId,
  };
}

/** Normalizes raw chat stream frames into a durable run timeline. */
export function reduceRunEvents(
  state: RunEventState,
  ev: ChatEvent,
  opts: RunEventOptions = {},
): RunEventState {
  const at = opts.now ?? Date.now();

  if (ev.type === "control_request" && ev.request?.subtype === "can_use_tool") {
    const id = ev.request_id ?? nextId("perm");
    return append(
      state,
      [
        {
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

  if (ev.type === "control_response") return state;

  if (ev.type === "stream_event") {
    const delta = ev.event?.delta;
    if (ev.event?.type !== "content_block_delta" || !delta) return state;
    if (delta.type === "thinking_delta" && delta.thinking) {
      return append(
        state,
        [
          {
            type: "reasoning",
            id: nextId("reasoning"),
            text: delta.thinking,
            streaming: true,
            at,
          },
        ],
        "thinking",
      );
    }
    if (delta.type === "text_delta" && delta.text) {
      return append(
        state,
        [{ type: "message.delta", id: nextId("msg"), text: delta.text, at }],
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
          type: "reasoning",
          id: nextId("reasoning"),
          text: block.thinking,
          streaming: false,
          at,
        });
      }
      if (block.type === "text" && block.text?.trim()) {
        out.push({ type: "message.delta", id: nextId("msg"), text: block.text, at });
      }
      if (block.type === "tool_use") {
        out.push({
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
              type: "run.failed",
              id: nextId("run"),
              message: ev.result ?? "run failed",
              at,
            }
          : {
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
      [{ type: "run.failed", id: nextId("run"), message: ev.text, at }],
      "failed",
    );
  }

  return state;
}
