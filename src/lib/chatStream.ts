import type { ChatEvent } from "./chat.ts";

export type ChatTurn =
  | { kind: "user"; id: string; text: string; steered?: boolean; images?: string[] }
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
  // The streaming bubble is almost always the LAST turn — check it first to
  // avoid an O(turns) findIndex scan per token (O(n²) over a turn). Fall back
  // to the linear scan only if the tail isn't our streaming bubble.
  let idx = -1;
  if (id) {
    const last = turns.length - 1;
    if (last >= 0 && turns[last].id === id && turns[last].kind === "thinking") {
      idx = last;
    } else {
      idx = turns.findIndex((t) => t.id === id);
    }
  }
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
  // The streaming bubble is almost always the LAST turn — check it first to
  // avoid an O(turns) findIndex scan per token (O(n²) over a turn). Fall back
  // to the linear scan only if the tail isn't our streaming bubble.
  let idx = -1;
  if (id) {
    const last = turns.length - 1;
    if (last >= 0 && turns[last].id === id && turns[last].kind === "assistant") {
      idx = last;
    } else {
      idx = turns.findIndex((t) => t.id === id);
    }
  }
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
  // The final `message.content[].text` is the source of truth. If a bubble
  // streamed via deltas, OVERWRITE it with the authoritative text rather than
  // trusting the concatenated deltas — a lost/coalesced delta would otherwise
  // permanently truncate the displayed reply. Multiple final text/thinking
  // blocks land on the same streaming bubble in order (first overwrites, rest
  // append) so nothing is dropped.
  let streamTextSettled = false;
  let thinkingTextSettled = false;
  for (const block of ev.message?.content ?? []) {
    if (block.type === "text") {
      const full = (block.text ?? "").trim();
      if (full && next.streamingTurnId != null) {
        const idx = turns.findIndex((t) => t.id === next.streamingTurnId);
        if (idx >= 0 && turns[idx].kind === "assistant") {
          const turn = turns[idx] as Extract<ChatTurn, { kind: "assistant" }>;
          turns[idx] = {
            ...turn,
            text: streamTextSettled ? `${turn.text}\n${full}` : full,
            streaming: false,
          };
          streamTextSettled = true;
          continue;
        }
      }
      if (full) {
        turns.push({ kind: "assistant", id: options.uid(), text: full, streaming: false });
      }
    }
    if (block.type === "thinking") {
      const full = (block.thinking ?? "").trim();
      if (full && next.thinkingTurnId != null) {
        const idx = turns.findIndex((t) => t.id === next.thinkingTurnId);
        if (idx >= 0 && turns[idx].kind === "thinking") {
          const turn = turns[idx] as Extract<ChatTurn, { kind: "thinking" }>;
          turns[idx] = {
            ...turn,
            text: thinkingTextSettled ? `${turn.text}\n${full}` : full,
            streaming: false,
          };
          thinkingTextSettled = true;
          continue;
        }
      }
      if (full) {
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
    // Primary match: a tool turn whose id equals tool_use_id.
    let targetIdx = ref != null ? turns.findIndex((t) => t.kind === "tool" && t.id === ref) : -1;
    // Order-based fallback: codex/opencode normalized output sometimes omits
    // block.id on tool_use (so the turn got a random uid) or sends a
    // tool_use_id that lines up with nothing. Rather than silently dropping the
    // result, attach it to the most recent tool turn that has no result yet.
    // Only target result-less turns so we never overwrite an already-attached
    // result via the fallback.
    if (targetIdx < 0) {
      for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        if (turn.kind === "tool" && turn.result == null) {
          targetIdx = i;
          break;
        }
      }
    }
    if (targetIdx < 0) continue; // genuinely no pending tool turn — leave unchanged
    const next = [...turns];
    const turn = next[targetIdx] as Extract<ChatTurn, { kind: "tool" }>;
    next[targetIdx] = { ...turn, result: text, isError: block.is_error };
    turns = next;
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
