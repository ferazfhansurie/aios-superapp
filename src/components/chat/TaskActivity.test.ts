import assert from "node:assert/strict";
import test from "node:test";

import { taskActivityItems } from "./taskActivityState.ts";

test("task activity keeps a stable chronological narrative including completed workers", () => {
  const items = taskActivityItems(
    [
      { id: "late", label: "late worker", status: "done", startedAt: 20, endedAt: 30 },
      { id: "early", label: "early worker", status: "running", startedAt: 10, lastLine: "reading auth.ts" },
    ],
    [{ id: "workflow", label: "release check", status: "failed", phases: [], startedAt: 15, endedAt: 18 }],
  );

  assert.deepEqual(items.map((item) => [item.id, item.status, item.preview]), [
    ["early", "updated", "reading auth.ts"],
    ["workflow", "failed", undefined],
    ["late", "done", undefined],
  ]);
});
