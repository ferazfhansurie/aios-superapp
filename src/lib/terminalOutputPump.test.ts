// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { createTerminalOutputPump } from "./terminalOutputPump.ts";

test("terminal output pump permits only one in-flight xterm write and preserves order", () => {
  const scheduled = [];
  const writes = [];
  const pump = createTerminalOutputPump({
    write: (text, done) => writes.push({ text, done }),
    schedule: (callback) => (scheduled.push(callback), callback),
    cancel: () => {},
  });

  pump.push("a");
  pump.push("b");
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.deepEqual(writes.map((write) => write.text), ["ab"]);

  pump.push("c");
  pump.push("d");
  while (scheduled.length) scheduled.shift()();
  assert.deepEqual(writes.map((write) => write.text), ["ab"]);

  writes[0].done();
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.deepEqual(writes.map((write) => write.text), ["ab", "cd"]);
});

test("terminal output pump uses the slower hidden cadence", () => {
  const delays = [];
  const pump = createTerminalOutputPump({
    write: (_text, done) => done(),
    schedule: (_callback, delay) => (delays.push(delay), delay),
    cancel: () => {},
    visibleDelayMs: 24,
    hiddenDelayMs: 240,
  });

  pump.setHidden(true);
  pump.push("background output");
  assert.deepEqual(delays, [240]);
});
