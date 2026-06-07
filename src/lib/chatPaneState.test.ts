// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatContextCapsule,
  composerContextChips,
  contextLedger,
  cycleQueueSelection,
  moveQueuedMessage,
  queueMessage,
  removeQueuedMessage,
  resumeTitle,
  sendContract,
  stopStrategy,
  updateQueuedMessage,
  usageStack,
} from "./chatPaneState.ts";
import {
  isHttpPaneTarget,
  isPaneFileTarget,
  resolvePaneFileTarget,
  targetLabel,
} from "./paneRouting.ts";

test("buildChatContextCapsule keeps live context compact and factual", () => {
  const capsule = buildChatContextCapsule({
    cwd: "/Users/firazfhansurie/Repo/firaz/aios-shell",
    engine: "codex",
    modelLabel: "gpt-5.5",
    contextBudget: "agent",
    userText: "make chatpane know what i mean without bloating every prompt",
    workspace: {
      activePane: { key: "p1", label: "chat", type: "chat", detail: "aios-shell" },
      openPanes: [
        { key: "p1", label: "chat", type: "chat", detail: "aios-shell" },
        { key: "p2", label: "browser", type: "browser", detail: "https://claude.ai" },
        { key: "p3", label: "files", type: "files", detail: "/Users/firazfhansurie/Repo/firaz/aios-shell" },
      ],
      projects: [
        { name: "aios-shell", root: "/Users/firazfhansurie/Repo/firaz/aios-shell", kind: "tauri" },
      ],
    },
    memories: [
      {
        title: "more better philosophy",
        type: "preference",
        description: "firaz wants more and better until density hurts",
        reasons: ["title matches `better`"],
        vault: "home",
      },
    ],
    recentTurns: [
      { kind: "user", text: "browser still doesnt show suggested sites" },
      { kind: "assistant", text: "fixed the browser suggestions" },
    ],
  });

  assert.match(capsule, /^<aios_context>/);
  assert.match(capsule, /active_pane: chat \[chat\]/);
  assert.match(capsule, /memory_hits:/);
  assert.match(capsule, /projects: aios-shell\/tauri/);
  assert.match(capsule, /recent_thread:/);
  assert.ok(capsule.length <= 1500);
});

test("buildChatContextCapsule hard-trims lean mode", () => {
  const capsule = buildChatContextCapsule({
    cwd: "/repo",
    engine: "claude",
    modelLabel: "opus",
    contextBudget: "lean",
    userText: "x".repeat(5000),
    memories: Array.from({ length: 20 }, (_, i) => ({
      title: `memory ${i}`,
      type: "reference",
      preview: "y".repeat(500),
    })),
    recentTurns: Array.from({ length: 20 }, (_, i) => ({
      kind: i % 2 ? "assistant" : "user",
      text: "z".repeat(500),
    })) as any,
  });

  assert.ok(capsule.length <= 760);
  assert.match(capsule, /truncated: true|<\/aios_context>/);
});

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

test("updateQueuedMessage edits text and drops blank queued rows", () => {
  const state = {
    items: [
      { id: "q1", text: "one" },
      { id: "q2", text: "two" },
    ],
    selected: 1,
  };

  assert.deepEqual(updateQueuedMessage(state, "q2", "  run tests again  "), {
    items: [
      { id: "q1", text: "one" },
      { id: "q2", text: "run tests again" },
    ],
    selected: 1,
  });
  assert.deepEqual(updateQueuedMessage(state, "q2", "   "), {
    items: [{ id: "q1", text: "one" }],
    selected: 0,
  });
});

test("moveQueuedMessage reorders queued rows and tracks the moved row", () => {
  const state = {
    items: [
      { id: "q1", text: "one" },
      { id: "q2", text: "two" },
      { id: "q3", text: "three" },
    ],
    selected: 1,
  };

  assert.deepEqual(moveQueuedMessage(state, "q2", -1), {
    items: [
      { id: "q2", text: "two" },
      { id: "q1", text: "one" },
      { id: "q3", text: "three" },
    ],
    selected: 0,
  });
  assert.deepEqual(moveQueuedMessage(state, "q2", 1), {
    items: [
      { id: "q1", text: "one" },
      { id: "q3", text: "three" },
      { id: "q2", text: "two" },
    ],
    selected: 2,
  });
});

test("sendContract makes streaming send behavior explicit", () => {
  assert.deepEqual(
    sendContract({
      streaming: true,
      hasDraft: true,
      hasImages: false,
      engine: "codex",
      started: true,
    }),
    {
      mode: "steer",
      label: "steer",
      title: "inject into the running codex turn",
      disabled: false,
    },
  );
  assert.deepEqual(
    sendContract({
      streaming: true,
      hasDraft: true,
      hasImages: false,
      engine: "claude",
      started: true,
    }).mode,
    "queue",
  );
  assert.equal(
    sendContract({
      streaming: false,
      hasDraft: false,
      hasImages: false,
      engine: "codex",
      started: true,
    }).disabled,
    true,
  );
});

test("stopStrategy: codex interrupts (turn/interrupt), only opencode kill-restarts", () => {
  // Round-1 parity: codex gained a real turn/interrupt, so it stops like claude
  // (keep the persistent app-server + thread); only opencode lacks a control
  // protocol and still needs a kill-and-restart.
  assert.equal(stopStrategy("codex"), "interrupt");
  assert.equal(stopStrategy("opencode"), "kill-and-restart");
  assert.equal(stopStrategy("claude"), "interrupt");
});

test("composerContextChips exposes the control contract at a glance", () => {
  assert.deepEqual(
    composerContextChips({
      cwd: "/Users/firaz/Repo/firaz/aios/shell",
      modelLabel: "gpt-5.3 codex spark",
      effortLabel: "low",
      permissionLabel: "full access",
      engine: "codex",
      contextBudget: "lean",
      queuedCount: 2,
      imageCount: 1,
      planMode: true,
      hasGoal: true,
    }),
    [
      { id: "cwd", label: "shell" },
      { id: "engine", label: "codex" },
      { id: "model", label: "gpt-5.3 codex spark" },
      { id: "effort", label: "low" },
      { id: "permission", label: "full access" },
      { id: "budget", label: "lean" },
      { id: "attachments", label: "1 image" },
      { id: "queue", label: "2 queued" },
      { id: "plan", label: "plan" },
      { id: "goal", label: "goal" },
    ],
  );
});

test("contextLedger estimates pre-send context buckets and warns on expensive modes", () => {
  const lean = contextLedger({
    draft: "ship the status pane",
    goal: "",
    planMode: false,
    memoryCount: 0,
    imageCount: 0,
    queuedCount: 0,
    contextBudget: "lean",
  });
  assert.deepEqual(
    lean.map((b) => [b.id, b.level]),
    [["budget", "quiet"], ["draft", "normal"]],
  );

  const heavy = contextLedger({
    draft: "x".repeat(6000),
    goal: "keep improving aios",
    planMode: true,
    memoryCount: 4,
    imageCount: 2,
    queuedCount: 5,
    contextBudget: "ultracode",
  });
  assert.equal(heavy.find((b) => b.id === "budget")?.level, "warning");
  assert.equal(heavy.find((b) => b.id === "draft")?.level, "warning");
  assert.equal(heavy.find((b) => b.id === "memory")?.level, "warning");
  assert.equal(heavy.find((b) => b.id === "images")?.level, "warning");
  assert.equal(heavy.find((b) => b.id === "queue")?.level, "warning");
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
