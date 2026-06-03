// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyRunEventState,
  parseRunEventState,
  reduceRunEvents,
  serializeRunEventState,
} from "./runEvents.ts";

test("reduceRunEvents captures thinking and text deltas as structured events", () => {
  let state = emptyRunEventState();
  state = reduceRunEvents(
    state,
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "checking files" },
      },
    },
    { now: 10 },
  );
  state = reduceRunEvents(
    state,
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "done" },
      },
    },
    { now: 11 },
  );

  assert.equal(state.phase, "writing");
  assert.deepEqual(
    state.events.map((event) => ({
      type: event.type,
      text: event.text,
      at: event.at,
    })),
    [
      { type: "reasoning", text: "checking files", at: 10 },
      { type: "message.delta", text: "done", at: 11 },
    ],
  );
});

test("reduceRunEvents captures tool lifecycle", () => {
  let state = emptyRunEventState();
  state = reduceRunEvents(
    state,
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "pnpm test" },
          },
        ],
      },
    },
    { now: 20 },
  );
  state = reduceRunEvents(
    state,
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "ok",
          },
        ],
      },
    },
    { now: 25 },
  );

  assert.equal(state.phase, "acting");
  assert.equal(state.activeActionId, undefined);
  assert.deepEqual(state.events, [
    {
      type: "action.started",
      id: "toolu_1",
      name: "Bash",
      input: { command: "pnpm test" },
      at: 20,
    },
    {
      type: "action.completed",
      id: "toolu_1",
      output: "ok",
      isError: undefined,
      at: 25,
    },
  ]);
});

test("reduceRunEvents captures permission requests and completion metadata", () => {
  let state = emptyRunEventState();
  state = reduceRunEvents(
    state,
    {
      type: "control_request",
      request_id: "req_1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "git push" },
      },
    },
    { now: 30 },
  );
  state = reduceRunEvents(
    state,
    {
      type: "result",
      duration_ms: 1234,
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    { now: 40 },
  );

  assert.equal(state.phase, "completed");
  assert.deepEqual(state.events, [
    {
      type: "permission.requested",
      id: "req_1",
      toolName: "Bash",
      input: { command: "git push" },
      at: 30,
    },
    {
      type: "run.completed",
      id: state.events[1].id,
      durationMs: 1234,
      tokens: 15,
      cost: 0.01,
      at: 40,
    },
  ]);
});

test("run event state serializes with a bounded event tail", () => {
  let state = emptyRunEventState();
  state = reduceRunEvents(
    state,
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "one" },
      },
    },
    { now: 1 },
  );
  state = reduceRunEvents(
    state,
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "two" },
      },
    },
    { now: 2 },
  );

  const restored = parseRunEventState(serializeRunEventState(state, 1));

  assert.equal(restored?.phase, "writing");
  assert.equal(restored?.events.length, 1);
  assert.equal(restored?.events[0].type, "message.delta");
  assert.equal(restored?.events[0].at, 2);
});

test("run event state parser rejects malformed storage", () => {
  assert.equal(parseRunEventState("not json"), null);
  assert.equal(parseRunEventState(JSON.stringify({ phase: "writing", events: "bad" })), null);
  assert.deepEqual(
    parseRunEventState(
      JSON.stringify({
        phase: "not-real",
        events: [{ type: "run.completed", id: "run1", at: 10 }],
      }),
    ),
    {
      phase: "completed",
      events: [{ type: "run.completed", id: "run1", at: 10 }],
      activeActionId: undefined,
    },
  );
});
