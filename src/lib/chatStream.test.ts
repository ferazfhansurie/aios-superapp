// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  coalesceChatStreamDeltas,
  finalizeStreamingTurns,
  reduceChatStreamEvent,
} from "./chatStream.ts";

let n = 0;
const uid = () => `t${++n}`;

test("coalesceChatStreamDeltas folds same-kind bursts before transcript reduction", () => {
  const text = (value) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: value } },
  });
  const thinking = (value) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: value } },
  });

  const result = coalesceChatStreamDeltas([
    text("one "),
    text("two"),
    thinking("check "),
    thinking("done"),
    text(" three"),
  ]);

  assert.equal(result.length, 3);
  assert.equal(result[0].event.delta.text, "one two");
  assert.equal(result[1].event.delta.thinking, "check done");
  assert.equal(result[2].event.delta.text, " three");
});

test("reduceChatStreamEvent appends text deltas into one streaming assistant turn", () => {
  n = 0;
  const first = reduceChatStreamEvent(
    { turns: [], streamingTurnId: null, thinkingTurnId: null },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } },
    { now: 100, uid },
  ).state;
  const second = reduceChatStreamEvent(
    first,
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
    { now: 110, uid },
  ).state;

  assert.deepEqual(second.turns, [{ kind: "assistant", id: "t1", text: "hello", streaming: true }]);
  assert.equal(second.streamingTurnId, "t1");
});

test("reduceChatStreamEvent closes a streamed assistant final without duplicating text", () => {
  n = 0;
  const base = { turns: [], streamingTurnId: null, thinkingTurnId: null };
  const first = reduceChatStreamEvent(
    base,
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } },
    { now: 100, uid },
  ).state;
  const streamed = reduceChatStreamEvent(
    first,
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
    { now: 110, uid },
  ).state;
  const final = reduceChatStreamEvent(
    streamed,
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    },
    { now: 200, uid },
  ).state;

  // The final text block overwrites the streamed bubble with the authoritative
  // text (identical here) AND settles it — streaming flips to false, no dupe.
  assert.deepEqual(final.turns, [{ kind: "assistant", id: "t1", text: "hello", streaming: false }]);
  assert.equal(final.streamingTurnId, null);
});

test("reduceChatStreamEvent overwrites streamed text with the authoritative final when deltas were lost", () => {
  n = 0;
  const base = { turns: [], streamingTurnId: null, thinkingTurnId: null };
  // Deltas arrive but are lost/coalesced — the bubble only ever shows "he llo".
  const d1 = reduceChatStreamEvent(
    base,
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "he " } } },
    { now: 100, uid },
  ).state;
  const d2 = reduceChatStreamEvent(
    d1,
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "llo" } } },
    { now: 110, uid },
  ).state;
  // The authoritative final is LONGER than the concatenated deltas.
  const final = reduceChatStreamEvent(
    d2,
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello there, full reply" }] },
    },
    { now: 200, uid },
  ).state;

  assert.deepEqual(final.turns, [
    { kind: "assistant", id: "t1", text: "hello there, full reply", streaming: false },
  ]);
  assert.equal(final.streamingTurnId, null);
});

test("reduceChatStreamEvent ignores undefined delta.text without a phantom turn", () => {
  n = 0;
  const result = reduceChatStreamEvent(
    { turns: [], streamingTurnId: null, thinkingTurnId: null },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta" } } },
    { now: 100, uid },
  );

  assert.equal(result.handled, true);
  assert.deepEqual(result.state.turns, []);
  assert.equal(result.state.streamingTurnId, null);
});

test("reduceChatStreamEvent settles thinking and adds tool cards on assistant final", () => {
  n = 0;
  const thinking = reduceChatStreamEvent(
    { turns: [], streamingTurnId: null, thinkingTurnId: null },
    {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "checking" } },
    },
    { now: 100, uid },
  ).state;
  const final = reduceChatStreamEvent(
    thinking,
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/App.tsx" } },
        ],
      },
    },
    { now: 400, uid },
  ).state;

  assert.deepEqual(final.turns, [
    { kind: "thinking", id: "t1", text: "checking", streaming: false, startedAt: 100, durationMs: 300 },
    { kind: "tool", id: "tool-1", name: "Read", input: { file_path: "src/App.tsx" } },
  ]);
  assert.equal(final.streamingTurnId, null);
  assert.equal(final.thinkingTurnId, null);
});

test("reduceChatStreamEvent patches tool results by tool_use_id", () => {
  const state = {
    streamingTurnId: null,
    thinkingTurnId: null,
    turns: [{ kind: "tool", id: "tool-1", name: "Bash", input: { command: "pwd" } }],
  };

  const next = reduceChatStreamEvent(
    state,
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done", is_error: false }],
      },
    },
    { now: 0, uid },
  ).state;

  assert.deepEqual(next.turns, [
    { kind: "tool", id: "tool-1", name: "Bash", input: { command: "pwd" }, result: "done", isError: false },
  ]);
});

test("tool_use without an id still gets its result attached via fallback", () => {
  // Engine omits block.id — the tool_use turn gets a random uid (t1 here).
  n = 0;
  const afterToolUse = reduceChatStreamEvent(
    { turns: [], streamingTurnId: null, thinkingTurnId: null },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    },
    { now: 100, uid },
  ).state;
  // result references a totally different id — would never match by id.
  const next = reduceChatStreamEvent(
    afterToolUse,
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "some-other-id", content: "files", is_error: false }] },
    },
    { now: 200, uid },
  ).state;

  assert.equal(next.turns.length, 1);
  assert.deepEqual(next.turns[0], {
    kind: "tool",
    id: "t1",
    name: "Bash",
    input: { command: "ls" },
    result: "files",
    isError: false,
  });
});

test("unmatched tool_result attaches to the pending tool turn", () => {
  const state = {
    streamingTurnId: null,
    thinkingTurnId: null,
    turns: [{ kind: "tool", id: "tool-A", name: "Read", input: { file_path: "a.ts" } }],
  };
  const next = reduceChatStreamEvent(
    state,
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "nope", content: "contents", is_error: false }] },
    },
    { now: 0, uid },
  ).state;

  assert.deepEqual(next.turns, [
    { kind: "tool", id: "tool-A", name: "Read", input: { file_path: "a.ts" }, result: "contents", isError: false },
  ]);
});

test("unmatched tool_result with no pending tool turn leaves state unchanged", () => {
  const state = {
    streamingTurnId: null,
    thinkingTurnId: null,
    turns: [{ kind: "assistant", id: "a1", text: "hi", streaming: false }],
  };
  const result = reduceChatStreamEvent(
    state,
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "ghost", content: "orphan", is_error: false }] },
    },
    { now: 0, uid },
  );

  assert.equal(result.handled, true);
  assert.deepEqual(result.state.turns, [{ kind: "assistant", id: "a1", text: "hi", streaming: false }]);
});

test("matched tool_use+tool_result by id still works (regression)", () => {
  const state = {
    streamingTurnId: null,
    thinkingTurnId: null,
    turns: [{ kind: "tool", id: "tool-1", name: "Bash", input: { command: "pwd" } }],
  };
  const next = reduceChatStreamEvent(
    state,
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done", is_error: false }] },
    },
    { now: 0, uid },
  ).state;

  assert.deepEqual(next.turns, [
    { kind: "tool", id: "tool-1", name: "Bash", input: { command: "pwd" }, result: "done", isError: false },
  ]);
});

test("unmatched tool_result attaches to most recent pending tool turn, not an already-resolved one", () => {
  const state = {
    streamingTurnId: null,
    thinkingTurnId: null,
    turns: [
      { kind: "tool", id: "tool-1", name: "Read", input: { file_path: "a.ts" }, result: "first", isError: false },
      { kind: "tool", id: "tool-2", name: "Read", input: { file_path: "b.ts" } },
    ],
  };
  const next = reduceChatStreamEvent(
    state,
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "unmatched", content: "second", is_error: false }] },
    },
    { now: 0, uid },
  ).state;

  assert.deepEqual(next.turns, [
    { kind: "tool", id: "tool-1", name: "Read", input: { file_path: "a.ts" }, result: "first", isError: false },
    { kind: "tool", id: "tool-2", name: "Read", input: { file_path: "b.ts" }, result: "second", isError: false },
  ]);
});

test("finalizeStreamingTurns closes live assistant and thinking blocks", () => {
  const next = finalizeStreamingTurns(
    {
      streamingTurnId: "a1",
      thinkingTurnId: "th1",
      turns: [
        { kind: "assistant", id: "a1", text: "hi", streaming: true },
        { kind: "thinking", id: "th1", text: "work", streaming: true, startedAt: 100 },
      ],
    },
    250,
  );

  assert.deepEqual(next, {
    streamingTurnId: null,
    thinkingTurnId: null,
    turns: [
      { kind: "assistant", id: "a1", text: "hi", streaming: false },
      { kind: "thinking", id: "th1", text: "work", streaming: false, startedAt: 100, durationMs: 150 },
    ],
  });
});

// Validates the round-2 rAF coalescing assumption: applying a batch of stream
// deltas in one folded pass (the flushPending path in ChatPane) must produce the
// EXACT same state as applying them one at a time as they arrive. If the reducer
// ever became order/timing-sensitive in a way that broke this, batching would
// silently corrupt the transcript.
function applyOneByOne(events) {
  let state = { turns: [], streamingTurnId: null, thinkingTurnId: null };
  for (const e of events) {
    const r = reduceChatStreamEvent(state, e, { now: 100, uid });
    if (r.handled) state = r.state;
  }
  return state;
}
function applyFolded(events) {
  // mirrors flushPending: fold all events through the reducer in a single pass
  return events.reduce(
    (state, e) => {
      const r = reduceChatStreamEvent(state, e, { now: 100, uid });
      return r.handled ? r.state : state;
    },
    { turns: [], streamingTurnId: null, thinkingTurnId: null },
  );
}

test("batched delta fold equals one-by-one application (rAF coalescing safety)", () => {
  const mk = (text) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });
  const mkThink = (thinking) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
  });
  const events = [
    mkThink("let me "),
    mkThink("think"),
    mk("Hel"),
    mk("lo "),
    mk("wor"),
    mk("ld"),
  ];

  n = 0;
  const seq = applyOneByOne(events);
  n = 0;
  const folded = applyFolded(events);

  assert.deepEqual(folded.turns, seq.turns, "folded turns must match sequential");
  assert.equal(folded.streamingTurnId, seq.streamingTurnId);
  assert.equal(folded.thinkingTurnId, seq.thinkingTurnId);
  // and the actual content is intact
  const assistant = folded.turns.find((t) => t.kind === "assistant");
  const thinking = folded.turns.find((t) => t.kind === "thinking");
  assert.equal(assistant.text, "Hello world");
  assert.equal(thinking.text, "let me think");
});

test("batched fold then assistant-final reconciliation keeps authoritative text", () => {
  const mk = (text) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });
  // deltas drop a chunk (simulating a coalesced/lost token), final is authoritative
  const deltas = [mk("Par"), mk("tial")]; // -> "Partial"
  n = 0;
  let state = applyFolded(deltas);
  const final = reduceChatStreamEvent(
    state,
    { type: "assistant", message: { content: [{ type: "text", text: "Partial but actually complete" }] } },
    { now: 200, uid },
  );
  const assistant = final.state.turns.find((t) => t.kind === "assistant");
  assert.equal(assistant.text, "Partial but actually complete", "final must win over batched deltas");
  assert.equal(assistant.streaming, false);
});

// End-to-end pipeline replay: a realistic full claude turn (thinking -> text ->
// assistant final -> AskUserQuestion tool_use -> auto-dismiss tool_result),
// validating that everything rounds 1-4 touched composes correctly — including
// that the AskUserQuestion payload the QuestionCard renders survives intact.
test("full-turn replay: thinking, text, assistant final, AskUserQuestion", () => {
  n = 0;
  let state = { turns: [], streamingTurnId: null, thinkingTurnId: null };
  const push = (ev, now = 100) => {
    const r = reduceChatStreamEvent(state, ev, { now, uid });
    if (r.handled) state = r.state;
  };
  const delta = (kind, text) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: kind === "think" ? { type: "thinking_delta", thinking: text } : { type: "text_delta", text } },
  });

  push(delta("think", "deciding"));
  push(delta("text", "Here are "));
  push(delta("text", "your options."));
  // authoritative assistant final (reconciliation must win, settle streaming)
  push({ type: "assistant", message: { content: [{ type: "text", text: "Here are your options." }] } }, 150);
  // AskUserQuestion tool call — the headline feature's source data
  push({
    type: "assistant",
    message: { content: [{
      type: "tool_use", id: "toolu_q1", name: "AskUserQuestion",
      input: { questions: [{ question: "Tea or coffee?", header: "Drink", multiSelect: false, options: [{ label: "Tea" }, { label: "Coffee" }] }] },
    }] },
  }, 160);
  // headless auto-dismiss result
  push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_q1", content: "Answer questions?", is_error: true }] } }, 161);

  const assistant = state.turns.find((t) => t.kind === "assistant");
  const thinking = state.turns.find((t) => t.kind === "thinking");
  const auq = state.turns.find((t) => t.kind === "tool" && t.name === "AskUserQuestion");

  assert.equal(assistant.text, "Here are your options.");
  assert.equal(assistant.streaming, false, "final must settle the bubble");
  assert.equal(thinking.text, "deciding");
  assert.ok(auq, "AskUserQuestion must be a tool turn (so ChatPane renders a QuestionCard)");
  assert.equal(auq.input.questions[0].question, "Tea or coffee?");
  assert.equal(auq.input.questions[0].options.length, 2, "QuestionCard needs the options intact");
  assert.equal(auq.isError, true, "auto-dismiss result attaches (card hides this, doesn't render the error)");
  assert.equal(state.streamingTurnId, null);
  assert.equal(state.thinkingTurnId, null);
});
