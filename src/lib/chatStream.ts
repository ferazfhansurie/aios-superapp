import type { ChatEvent } from "./chat.ts";

export type ChatTurn =
  | { kind: "user"; id: string; text: string; steered?: boolean }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | {
      kind: "thinking";
      id: string;
      text: string;
      streaming: boolean;
      startedAt?: number;
      durationMs?: number;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
      result?: string;
      isError?: boolean;
    }
  | {
      kind: "approval";
      id: string;
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      decision?: "allow" | "allow_always" | "deny";
    }
  | {
      kind: "result";
      id: string;
      text: string;
      cost?: number;
      tokens?: number;
      durationMs?: number;
    };

export interface ChatStreamState {
  turns: ChatTurn[];
  streamingTurnId: string | null;
  thinkingTurnId: string | null;
}

export interface ChatStreamReduceOptions {
  now: number;
  uid: () => string;
}

export interface ChatStreamReduceResult {
  handled: boolean;
  state: ChatStreamState;
}

export function resultToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b
          ? String((b as { text: unknown }).text)
          : JSON.stringify(b),
      )
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

function appendThinkingDelta(
  state: ChatStreamState,
  text: string,
  options: ChatStreamReduceOptions,
): ChatStreamState {
  const turns = [...state.turns];
  const id = state.thinkingTurnId;
  const idx = id ? turns.findIndex((t) => t.id === id) : -1;
  if (idx >= 0 && turns[idx].kind === "thinking") {
    const turn = turns[idx] as Extract<ChatTurn, { kind: "thinking" }>;
    turns[idx] = { ...turn, text: turn.text + text, streaming: true };
    return { ...state, turns };
  }
  const nextId = options.uid();
  turns.push({
    kind: "thinking",
    id: nextId,
    text,
    streaming: true,
    startedAt: options.now,
  });
  return { ...state, turns, thinkingTurnId: nextId };
}

function appendAssistantDelta(
  state: ChatStreamState,
  text: string,
  options: ChatStreamReduceOptions,
): ChatStreamState {
  const turns = [...state.turns];
  const id = state.streamingTurnId;
  const idx = id ? turns.findIndex((t) => t.id === id) : -1;
  if (idx >= 0 && turns[idx].kind === "assistant") {
    const turn = turns[idx] as Extract<ChatTurn, { kind: "assistant" }>;
    turns[idx] = { ...turn, text: turn.text + text, streaming: true };
    return { ...state, turns };
  }
  const nextId = options.uid();
  turns.push({ kind: "assistant", id: nextId, text, streaming: true });
  return { ...state, turns, streamingTurnId: nextId };
}

function settleThinking(state: ChatStreamState, now: number): ChatStreamState {
  const id = state.thinkingTurnId;
  if (!id) return state;
  return {
    ...state,
    turns: state.turns.map((turn) =>
      turn.id === id && turn.kind === "thinking"
        ? {
            ...turn,
            streaming: false,
            durationMs: turn.startedAt != null ? now - turn.startedAt : undefined,
          }
        : turn,
    ),
  };
}

function reduceAssistantEvent(
  state: ChatStreamState,
  ev: ChatEvent,
  options: ChatStreamReduceOptions,
): ChatStreamState {
  let next = settleThinking(state, options.now);
  const turns = [...next.turns];
  for (const block of ev.message?.content ?? []) {
    if (block.type === "text") {
      const full = (block.text ?? "").trim();
      if (full && next.streamingTurnId == null) {
        turns.push({ kind: "assistant", id: options.uid(), text: full, streaming: false });
      }
    }
    if (block.type === "thinking") {
      const full = (block.thinking ?? "").trim();
      if (full && next.thinkingTurnId == null) {
        turns.push({ kind: "thinking", id: options.uid(), text: full, streaming: false });
      }
    }
    if (block.type === "tool_use") {
      const toolId = block.id ?? options.uid();
      if (!turns.some((turn) => turn.kind === "tool" && turn.id === toolId)) {
        turns.push({
          kind: "tool",
          id: toolId,
          name: block.name ?? "tool",
          input: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }
  }
  next = { turns, streamingTurnId: null, thinkingTurnId: null };
  return next;
}

function reduceToolResultEvent(state: ChatStreamState, ev: ChatEvent): ChatStreamState {
  let turns = state.turns;
  for (const block of ev.message?.content ?? []) {
    if (block.type !== "tool_result") continue;
    const ref = block.tool_use_id;
    const text = resultToText(block.content);
    turns = turns.map((turn) =>
      turn.kind === "tool" && turn.id === ref
        ? { ...turn, result: text, isError: block.is_error }
        : turn,
    );
  }
  return { ...state, turns };
}

export function finalizeStreamingTurns(
  state: ChatStreamState,
  now: number,
): ChatStreamState {
  return {
    turns: state.turns.map((turn) => {
      if (turn.kind === "assistant" && turn.streaming) return { ...turn, streaming: false };
      if (turn.kind === "thinking" && turn.streaming) {
        return {
          ...turn,
          streaming: false,
          durationMs: turn.startedAt != null ? now - turn.startedAt : turn.durationMs,
        };
      }
      return turn;
    }),
    streamingTurnId: null,
    thinkingTurnId: null,
  };
}

export function reduceChatStreamEvent(
  state: ChatStreamState,
  ev: ChatEvent,
  options: ChatStreamReduceOptions,
): ChatStreamReduceResult {
  if (ev.type === "stream_event") {
    const event = ev.event;
    if (!event || event.type !== "content_block_delta") {
      return { handled: false, state };
    }
    if (event.delta?.type === "thinking_delta") {
      const tok = event.delta.thinking ?? "";
      return tok
        ? { handled: true, state: appendThinkingDelta(state, tok, options) }
        : { handled: true, state };
    }
    if (event.delta?.type === "text_delta") {
      const tok = event.delta.text ?? "";
      return tok
        ? { handled: true, state: appendAssistantDelta(state, tok, options) }
        : { handled: true, state };
    }
    return { handled: false, state };
  }
  if (ev.type === "assistant") {
    return { handled: true, state: reduceAssistantEvent(state, ev, options) };
  }
  if (ev.type === "user") {
    return { handled: true, state: reduceToolResultEvent(state, ev) };
  }
  return { handled: false, state };
}
