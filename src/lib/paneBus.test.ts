import assert from "node:assert/strict";
import test from "node:test";

import { taskSpawnContext } from "./paneBus.ts";

test("task spawn context forwards only validated task ownership to children", () => {
  assert.deepEqual(taskSpawnContext("task:k-chat-owner"), { taskId: "task:k-chat-owner" });
  assert.deepEqual(taskSpawnContext(undefined), {});
  assert.deepEqual(taskSpawnContext("task:not allowed space"), {});
});
