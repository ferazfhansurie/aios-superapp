// @ts-nocheck -- executed directly by node's test runner.
import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskRailModel } from "./taskRailState.ts";

test("task rail model groups tools while preserving nested fleet hierarchy", () => {
  const model = buildTaskRailModel({
    phase: "acting",
    events: [
      { type: "action.started", id: "read-1", name: "Read", input: { file_path: "src/a.ts" }, at: 10 },
      { type: "action.completed", id: "read-1", output: "ok", at: 20 },
      { type: "action.started", id: "bash-1", parentId: "agent-child", name: "Bash", input: { command: "pnpm test" }, at: 30 },
    ],
    agents: [
      { id: "agent-parent", label: "audit", status: "running", startedAt: 5 },
      { id: "agent-child", parentId: "agent-parent", label: "tests", status: "running", startedAt: 8, lastLine: "running suite" },
    ],
    workflows: [],
    artifacts: [],
    now: 40,
  });

  assert.equal(model.strip.phaseLabel, "acting");
  assert.equal(model.strip.currentAction, "Bash · pnpm test");
  assert.deepEqual(model.actionGroups.map((group) => [group.kind, group.actions.length]), [
    ["read", 1],
    ["command", 1],
  ]);
  assert.equal(model.agents[0].id, "agent-parent");
  assert.equal(model.agents[0].children[0].id, "agent-child");
  assert.equal(model.agents[0].children[0].actions[0].id, "bash-1");
});

test("task rail strip calls out waiting approvals and artifacts", () => {
  const model = buildTaskRailModel({
    phase: "waiting",
    events: [{ type: "permission.requested", id: "p1", toolName: "Bash", input: { command: "git push" }, at: 10 }],
    agents: [],
    workflows: [],
    artifacts: [{ path: "outputs/release.pdf", name: "release.pdf", kind: "pdf" }],
    now: 15,
  });

  assert.equal(model.strip.currentAction, "approval needed · Bash");
  assert.equal(model.pendingApprovals, 1);
  assert.deepEqual(model.references.map((reference) => reference.path), ["outputs/release.pdf"]);
});
