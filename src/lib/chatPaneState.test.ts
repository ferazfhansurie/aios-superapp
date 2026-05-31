// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  cycleQueueSelection,
  queueMessage,
  removeQueuedMessage,
  resumeTitle,
  usageStack,
} from "./chatPaneState.ts";
import {
  isHttpPaneTarget,
  isPaneFileTarget,
  resolvePaneFileTarget,
  targetLabel,
} from "./paneRouting.ts";

test("usageStack separates the pre-chat baseline from this chat delta", () => {
  assert.deepEqual(usageStack(64, 61), {
    baseline: 61,
    session: 3,
    total: 64,
  });
});

test("usageStack never renders a negative session delta after a reset", () => {
  assert.deepEqual(usageStack(2, 98), {
    baseline: 2,
    session: 0,
    total: 2,
  });
});

test("queueMessage trims text and selects the newly queued item", () => {
  const next = queueMessage([], "  inspect the failed build  ");
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0]?.text, "inspect the failed build");
  assert.equal(next.selected, 0);
});

test("cycleQueueSelection wraps in both directions", () => {
  assert.equal(cycleQueueSelection(0, 3, 1), 1);
  assert.equal(cycleQueueSelection(2, 3, 1), 0);
  assert.equal(cycleQueueSelection(0, 3, -1), 2);
});

test("removeQueuedMessage removes the selected steer item and keeps selection valid", () => {
  const state = {
    items: [
      { id: "q1", text: "one" },
      { id: "q2", text: "two" },
      { id: "q3", text: "three" },
    ],
    selected: 1,
  };
  assert.deepEqual(removeQueuedMessage(state, "q2"), {
    items: [
      { id: "q1", text: "one" },
      { id: "q3", text: "three" },
    ],
    selected: 1,
  });
});

test("resumeTitle keeps claude's first-message title behavior unchanged", () => {
  assert.deepEqual(resumeTitle("  please inspect the build  ", "claude"), {
    title: "please inspect the build",
    meaningful: true,
  });
});

test("resumeTitle keeps low-signal codex openers provisional", () => {
  assert.deepEqual(resumeTitle("hi", "codex"), {
    title: "new codex chat",
    meaningful: false,
  });
});

test("resumeTitle compacts the first meaningful codex prompt", () => {
  assert.deepEqual(
    resumeTitle("can you please help me fix codex usage in the chatpane?", "codex"),
    {
      title: "fix codex usage in the chatpane",
      meaningful: true,
    },
  );
});

test("pane routing identifies browser links and local file targets", () => {
  assert.equal(isHttpPaneTarget("https://docs.anthropic.com/claude-code"), true);
  assert.equal(isPaneFileTarget("/Users/firaz/docs/research.md:12"), true);
  assert.equal(isPaneFileTarget("docs/research/codex-desktop-steal-list.md"), true);
  assert.equal(isPaneFileTarget("not a path"), false);
});

test("pane routing resolves markdown links relative to the current file", () => {
  assert.equal(
    resolvePaneFileTarget("../notes/todo.md#next", "/Users/firaz/project/docs/research/current.md"),
    "/Users/firaz/project/docs/notes/todo.md",
  );
  assert.equal(targetLabel("/Users/firaz/project/docs/notes/todo.md:44"), "todo.md");
});
