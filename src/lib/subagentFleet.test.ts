// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { emptyFleetState, reduceFleet } from "./subagentFleet.ts";

test("Task tool_use spawns a running fleet agent with a label", () => {
  let s = emptyFleetState();
  s = reduceFleet(
    s,
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Task",
            input: { description: "audit auth flow", subagent_type: "Explore" },
          },
        ],
      },
    },
    { now: 100 },
  );
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].id, "toolu_1");
  assert.equal(s.agents[0].label, "audit auth flow");
  assert.equal(s.agents[0].subagentType, "Explore");
  assert.equal(s.agents[0].status, "running");
});

test("parallel Task blocks in one assistant turn spawn multiple agents", () => {
  let s = emptyFleetState();
  s = reduceFleet(
    s,
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "Task", input: { description: "one" } },
          { type: "tool_use", id: "b", name: "Task", input: { subagent_type: "general-purpose" } },
        ],
      },
    },
    { now: 1 },
  );
  assert.equal(s.agents.length, 2);
  assert.equal(s.agents[1].label, "general-purpose");
});

test("nested assistant text (parent_tool_use_id) updates the agent's last line + tokens", () => {
  let s = emptyFleetState();
  s = reduceFleet(s, {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "p", name: "Task", input: { description: "work" } }] },
  });
  s = reduceFleet(s, {
    type: "assistant",
    parent_tool_use_id: "p",
    message: {
      content: [{ type: "text", text: "found the bug in foo.ts" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  });
  assert.equal(s.agents[0].lastLine, "found the bug in foo.ts");
  assert.equal(s.agents[0].tokens, 150);
});

test("main-agent tool_result for the Task id marks it done", () => {
  let s = emptyFleetState();
  s = reduceFleet(s, {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "p", name: "Task", input: { description: "x" } }] },
  });
  s = reduceFleet(s, {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "p", content: "summary" }] },
  });
  assert.equal(s.agents[0].status, "done");
});

test("a tool_result with is_error marks the agent failed", () => {
  let s = emptyFleetState();
  s = reduceFleet(s, {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "p", name: "Task", input: { description: "x" } }] },
  });
  s = reduceFleet(s, {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "p", is_error: true, content: "boom" }] },
  });
  assert.equal(s.agents[0].status, "failed");
});

test("ordinary (non-Task) tool calls never register a fleet agent", () => {
  let s = emptyFleetState();
  s = reduceFleet(s, {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }] },
  });
  assert.equal(s.agents.length, 0);
});

test("codex-shaped tool calls (bash/edit/websearch) yield an empty fleet", () => {
  let s = emptyFleetState();
  for (const name of ["bash", "edit", "websearch", "mcp", "codex_action"]) {
    s = reduceFleet(s, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: name, name, input: {} }] },
    });
  }
  assert.equal(s.agents.length, 0);
});

test("codex mcp multi-agent tool call registers a visible fleet agent", () => {
  let s = emptyFleetState();
  s = reduceFleet(
    s,
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "codex-agent-1",
            name: "mcp",
            input: {
              server: "multi-agent tools",
              tool: "spawn_agent",
              description: "audit the resume picker",
            },
          },
        ],
      },
    },
    { now: 7 },
  );
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].id, "codex-agent-1");
  assert.equal(s.agents[0].label, "audit the resume picker");
  assert.equal(s.agents[0].subagentType, "multi-agent tools");
  assert.equal(s.agents[0].status, "running");
});

test("a stray tool_result for an unknown id does not throw or mutate", () => {
  const s0 = emptyFleetState();
  const s1 = reduceFleet(s0, {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "ghost" }] },
  });
  assert.equal(s1, s0); // same reference — no-op
});

// ── Workflow (the /workflows phase-tree fan-out) ──────────────────────────────

const WF_SCRIPT = `
export const meta = {
  name: 'predeploy-review',
  description: "Adversarial pre-deploy review of this session's changes",
  phases: [
    { title: 'Review', detail: '7 independent reviewers, one per dimension' },
    { title: 'Verify', detail: 'adversarially verify each finding' },
  ],
}
const REPO = '/repo'
`;

test("Workflow tool_use registers a running workflow with parsed meta + phases", () => {
  let s = emptyFleetState();
  s = reduceFleet(
    s,
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "wf1", name: "Workflow", input: { script: WF_SCRIPT } },
        ],
      },
    },
    { now: 10 },
  );
  assert.equal(s.workflows.length, 1);
  assert.equal(s.agents.length, 0);
  const w = s.workflows[0];
  assert.equal(w.id, "wf1");
  assert.equal(w.label, "predeploy-review");
  assert.equal(w.status, "running");
  assert.equal(w.phases.length, 2);
  assert.equal(w.phases[0].title, "Review");
  assert.equal(w.phases[0].detail, "7 independent reviewers, one per dimension");
  assert.equal(w.phases[1].title, "Verify");
});

test("a successful Workflow launch result stays running and captures the run id", () => {
  let s = emptyFleetState();
  s = reduceFleet(s, {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "wf1", name: "Workflow", input: { script: WF_SCRIPT } }] },
  });
  s = reduceFleet(s, {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "wf1",
          content:
            "Workflow launched in background. Task ID: abc\nRun ID: wf_b56f7eef-ac8\nUse /workflows to watch live progress.",
        },
      ],
    },
  });
  // launch is an ACK, not a completion — workflow keeps running in background.
  assert.equal(s.workflows[0].status, "running");
  assert.equal(s.workflows[0].runId, "wf_b56f7eef-ac8");
});

test("a failed Workflow launch marks the workflow failed", () => {
  let s = emptyFleetState();
  s = reduceFleet(s, {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "wf1", name: "Workflow", input: { script: WF_SCRIPT } }] },
  });
  s = reduceFleet(s, {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "wf1", is_error: true, content: "bad script" }] },
  });
  assert.equal(s.workflows[0].status, "failed");
});

test("Workflow with no parseable phases registers with an empty phase list", () => {
  let s = emptyFleetState();
  s = reduceFleet(s, {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "wf1", name: "Workflow", input: { script: "export const meta = { name: 'x' }" } },
      ],
    },
  });
  assert.equal(s.workflows[0].label, "x");
  assert.equal(s.workflows[0].phases.length, 0);
});

test("Workflow falls back to scriptPath input + description label", () => {
  let s = emptyFleetState();
  s = reduceFleet(s, {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "wf1", name: "Workflow", input: { scriptPath: "export const meta = { description: 'resumed run' }" } },
      ],
    },
  });
  assert.equal(s.workflows[0].label, "resumed run");
});

test("Task agents and a Workflow can coexist in one turn", () => {
  let s = emptyFleetState();
  s = reduceFleet(s, {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "Task", input: { description: "explore" } },
        { type: "tool_use", id: "wf1", name: "Workflow", input: { script: WF_SCRIPT } },
      ],
    },
  });
  assert.equal(s.agents.length, 1);
  assert.equal(s.workflows.length, 1);
});

test("nested agent activity preserves the workflows array (no clobber)", () => {
  let s = emptyFleetState();
  s = reduceFleet(s, {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "Task", input: { description: "x" } },
        { type: "tool_use", id: "wf1", name: "Workflow", input: { script: WF_SCRIPT } },
      ],
    },
  });
  s = reduceFleet(s, {
    type: "assistant",
    parent_tool_use_id: "t1",
    message: { content: [{ type: "text", text: "looking" }], usage: { output_tokens: 5 } },
  });
  assert.equal(s.workflows.length, 1);
  assert.equal(s.agents[0].lastLine, "looking");
});
