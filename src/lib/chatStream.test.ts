// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeStreamingTurns,
  reduceChatStreamEvent,
} from "./chatStream.ts";

let n = 0;
const uid = () => `t${++n}`;

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

  assert.deepEqual(final.turns, [{ kind: "assistant", id: "t1", text: "hello", streaming: true }]);
  assert.equal(final.streamingTurnId, null);
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
