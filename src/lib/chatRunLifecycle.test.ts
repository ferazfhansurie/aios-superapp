import assert from "node:assert/strict";
import test from "node:test";

import {
  canStartNormalSend,
  canSendNormally,
  canSteer,
  initialChatRunLifecycle,
  reduceChatRunLifecycle,
} from "./chatRunLifecycle.ts";
import type { ChatRunLifecycle, ChatRunLifecycleEvent } from "./chatRunLifecycle.ts";

// These are compile-time API guards. A transport adapter must attach the active
// local run id before it can dispatch any non-start lifecycle event.
const taggedRunningEvent: ChatRunLifecycleEvent = { type: "running", runId: "run-1" };
void taggedRunningEvent;
// @ts-expect-error running events require a run id
const untaggedRunningEvent: ChatRunLifecycleEvent = { type: "running" };
void untaggedRunningEvent;
// @ts-expect-error terminal events require a run id
const untaggedTerminalEvent: ChatRunLifecycleEvent = { type: "completed" };
void untaggedTerminalEvent;

function runIdOf(state: ChatRunLifecycle): string {
  if (state.phase === "idle") throw new Error("expected an active or terminal run");
  return state.runId;
}

test("run lifecycle only becomes runnable after a terminal event", () => {
  let state = initialChatRunLifecycle();
  assert.equal(canSendNormally(state), true);
  assert.equal(canSteer(state), false);

  state = reduceChatRunLifecycle(state, { type: "starting" });
  assert.equal(state.phase, "starting");
  assert.equal(canSendNormally(state), false);
  assert.equal(canSteer(state), false);

  state = reduceChatRunLifecycle(state, { type: "running", runId: runIdOf(state), turnId: "turn-1" });
  assert.equal(state.phase, "running");
  assert.equal(state.turnId, "turn-1");
  assert.equal(canSteer(state), true);

  state = reduceChatRunLifecycle(state, { type: "interrupting", runId: runIdOf(state) });
  assert.equal(state.phase, "interrupting");
  assert.equal(canSendNormally(state), false);
  assert.equal(canSteer(state), false);

  state = reduceChatRunLifecycle(state, { type: "completed", runId: runIdOf(state) });
  assert.equal(state.phase, "completed");
  assert.equal(canSendNormally(state), true);
  assert.equal(canSteer(state), false);
});

test("interrupting stays non-runnable until a terminal event", () => {
  let state = reduceChatRunLifecycle(initialChatRunLifecycle(), { type: "starting" });
  state = reduceChatRunLifecycle(state, { type: "running", runId: runIdOf(state), turnId: "turn-7" });
  state = reduceChatRunLifecycle(state, { type: "interrupting", runId: runIdOf(state) });

  state = reduceChatRunLifecycle(state, { type: "running", runId: runIdOf(state), turnId: "turn-7" });
  assert.equal(state.phase, "interrupting");
  assert.equal(canSendNormally(state), false);
  assert.equal(canSteer(state), false);
});

test("a stop requested during startup becomes visibly interrupting and ignores a late running frame", () => {
  let state = reduceChatRunLifecycle(initialChatRunLifecycle(), { type: "starting" });
  const runId = runIdOf(state);

  state = reduceChatRunLifecycle(state, { type: "interrupting", runId });
  assert.equal(state.phase, "interrupting");
  assert.equal(canStartNormalSend(state), false);

  state = reduceChatRunLifecycle(state, { type: "running", runId, turnId: "late-turn" });
  assert.equal(state.phase, "interrupting");
});

test("starting cannot reset an in-flight or interrupting run", () => {
  let state = reduceChatRunLifecycle(initialChatRunLifecycle(), { type: "starting" });
  const repeatedStart = reduceChatRunLifecycle(state, { type: "starting" });
  assert.equal(repeatedStart, state);

  state = reduceChatRunLifecycle(state, { type: "running", runId: runIdOf(state), turnId: "turn-8" });
  const liveStart = reduceChatRunLifecycle(state, { type: "starting" });
  assert.equal(liveStart, state);

  state = reduceChatRunLifecycle(state, { type: "interrupting", runId: runIdOf(state) });
  const stoppingStart = reduceChatRunLifecycle(state, { type: "starting" });
  assert.equal(stoppingStart, state);
});

test("the first terminal result wins and terminal events are idempotent", () => {
  let state = reduceChatRunLifecycle(initialChatRunLifecycle(), { type: "starting" });
  state = reduceChatRunLifecycle(state, { type: "running", runId: runIdOf(state), turnId: "turn-3" });
  state = reduceChatRunLifecycle(state, { type: "failed", runId: runIdOf(state), reason: "network lost" });

  const duplicate = reduceChatRunLifecycle(state, { type: "completed", runId: runIdOf(state) });
  assert.equal(duplicate, state);
  assert.deepEqual(duplicate, {
    phase: "failed",
    runId: state.runId,
    turnId: "turn-3",
    terminal: { type: "failed", reason: "network lost" },
  });

  assert.equal(canSendNormally(duplicate), true);
  assert.equal(canSteer(duplicate), false);
});

test("session exit is terminal and records its reason", () => {
  let state = reduceChatRunLifecycle(initialChatRunLifecycle(), { type: "starting" });
  const runId = runIdOf(state);
  state = reduceChatRunLifecycle(state, { type: "exited", runId, reason: "child exited" });

  assert.deepEqual(state, {
    phase: "exited",
    runId,
    terminal: { type: "exited", reason: "child exited" },
  });
  assert.equal(canSendNormally(state), true);
  assert.equal(canSteer(state), false);
});

test("normal sends are allowed only from idle or a terminal lifecycle", () => {
  const idle = initialChatRunLifecycle();
  const starting = reduceChatRunLifecycle(idle, { type: "starting" });
  const running = reduceChatRunLifecycle(starting, { type: "running", runId: runIdOf(starting), turnId: "turn-9" });
  const interrupting = reduceChatRunLifecycle(running, { type: "interrupting", runId: runIdOf(running) });

  for (const state of [idle, starting, running, interrupting]) {
    assert.equal(canStartNormalSend(state), state.phase === "idle", state.phase);
  }

  for (const type of ["completed", "failed", "interrupted", "exited"] as const) {
    const terminal = reduceChatRunLifecycle(running, { type, runId: runIdOf(running) });
    assert.equal(canStartNormalSend(terminal), true, type);
    assert.equal(canSendNormally(terminal), true, `${type} compatibility alias`);
  }
});

test("steering is allowed only while the lifecycle is running", () => {
  const idle = initialChatRunLifecycle();
  const starting = reduceChatRunLifecycle(idle, { type: "starting" });
  const running = reduceChatRunLifecycle(starting, { type: "running", runId: runIdOf(starting) });
  const interrupting = reduceChatRunLifecycle(running, { type: "interrupting", runId: runIdOf(running) });

  assert.equal(canSteer(running), true, "a running lifecycle is backend-confirmed authority");
  for (const state of [
    idle,
    starting,
    interrupting,
    reduceChatRunLifecycle(running, { type: "completed", runId: runIdOf(running) }),
    reduceChatRunLifecycle(running, { type: "failed", runId: runIdOf(running) }),
    reduceChatRunLifecycle(running, { type: "interrupted", runId: runIdOf(running) }),
    reduceChatRunLifecycle(running, { type: "exited", runId: runIdOf(running) }),
  ]) {
    assert.equal(canSteer(state), false, state.phase);
  }
});

test("a stale terminal event from run a cannot close the later run b", () => {
  let runA = reduceChatRunLifecycle(initialChatRunLifecycle(), { type: "starting" });
  assert.equal(typeof runA.runId, "string");
  runA = reduceChatRunLifecycle(runA, { type: "running", runId: runIdOf(runA), turnId: "turn-a" });

  const completedA = reduceChatRunLifecycle(runA, {
    type: "completed",
    runId: runIdOf(runA),
  });
  const runB = reduceChatRunLifecycle(completedA, { type: "starting" });
  assert.equal(typeof runB.runId, "string");
  assert.notEqual(runB.runId, runA.runId);
  assert.equal("turnId" in runB, false, "new starts clear the previous turn identity");
  assert.equal("terminal" in runB, false, "new starts clear the previous terminal outcome");

  const staleFailure = reduceChatRunLifecycle(runB, {
    type: "failed",
    runId: runIdOf(runA),
    reason: "late process exit",
  });
  assert.equal(staleFailure, runB);

  const completedB = reduceChatRunLifecycle(runB, {
    type: "completed",
    runId: runIdOf(runB),
  });
  assert.equal(completedB.phase, "completed");
  assert.equal(completedB.runId, runIdOf(runB));
});
