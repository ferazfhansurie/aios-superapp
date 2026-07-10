// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatContextCapsule,
  chatStreamFlushDelay,
  composeWireMessage,
  composerContextChips,
  contextLedger,
  modePrefixFor,
  cycleQueueSelection,
  describeModelSwitch,
  moveQueuedMessage,
  queueMessage,
  removeQueuedMessage,
  resumeTitle,
  sendContract,
  shouldApplyResumeProp,
  stopStrategy,
  updateQueuedMessage,
  usageStack,
} from "./chatPaneState.ts";

test("hidden chat streams use a slower flush cadence", () => {
  assert.equal(chatStreamFlushDelay(false), null);
  assert.equal(chatStreamFlushDelay(true), 240);
});
import * as chatPaneState from "./chatPaneState.ts";
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

test("model-aware effort selection prefers saved, then current, then model default", () => {
  assert.equal(typeof chatPaneState.resolveModelEffort, "function");
  const sol = {
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "low",
  };

  assert.equal(
    chatPaneState.resolveModelEffort(sol, "high", "max"),
    "max",
  );
  assert.equal(
    chatPaneState.resolveModelEffort(sol, "high", "unsupported"),
    "high",
  );
  assert.equal(
    chatPaneState.resolveModelEffort(sol, "unsupported", null),
    "low",
  );
});

test("effort slider snaps and moves across only the selected model's stops", () => {
  assert.equal(typeof chatPaneState.nearestEffortIndex, "function");
  assert.equal(typeof chatPaneState.moveEffortIndex, "function");

  assert.equal(chatPaneState.nearestEffortIndex(0, 6), 0);
  assert.equal(chatPaneState.nearestEffortIndex(0.51, 6), 3);
  assert.equal(chatPaneState.nearestEffortIndex(1, 5), 4);
  assert.equal(chatPaneState.moveEffortIndex(2, "ArrowRight", 6), 3);
  assert.equal(chatPaneState.moveEffortIndex(0, "ArrowLeft", 6), 0);
  assert.equal(chatPaneState.moveEffortIndex(2, "Home", 6), 0);
  assert.equal(chatPaneState.moveEffortIndex(2, "End", 6), 5);
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
  // claude steers mid-turn now (stdin injection, verified vs claude 2.1.170) —
  // with or without images (the stdin user line carries image content blocks).
  assert.deepEqual(
    sendContract({
      streaming: true,
      hasDraft: true,
      hasImages: false,
      engine: "claude",
      started: true,
    }),
    {
      mode: "steer",
      label: "steer",
      title: "inject into the running claude turn",
      disabled: false,
    },
  );
  assert.equal(
    sendContract({
      streaming: true,
      hasDraft: false,
      hasImages: true,
      engine: "claude",
      started: true,
    }).mode,
    "steer",
  );
  // codex turn/steer is text-only — an image-carrying draft queues instead.
  assert.equal(
    sendContract({
      streaming: true,
      hasDraft: true,
      hasImages: true,
      engine: "codex",
      started: true,
    }).mode,
    "queue",
  );
  // opencode has no live mid-turn process → queue.
  assert.equal(
    sendContract({
      streaming: true,
      hasDraft: true,
      hasImages: false,
      engine: "opencode",
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

test("shouldApplyResumeProp ignores the pane's own live session echo", () => {
  const own = new Set(["live-123"]);

  assert.equal(shouldApplyResumeProp("live-123", own), false);
  assert.equal(shouldApplyResumeProp("history-456", own), true);
  assert.equal(shouldApplyResumeProp("", own), false);
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

test("describeModelSwitch clears + announces on a real switch, no-ops on same model", () => {
  // re-picking the active model: no clear, no notice
  assert.deepEqual(describeModelSwitch("claude-opus-4-8", { id: "claude-opus-4-8", label: "Opus 4.8" }), {
    shouldClear: false,
    notice: null,
  });
  // switching within an engine (claude → claude sibling): clears + announces
  assert.deepEqual(describeModelSwitch("claude-opus-4-8", { id: "claude-sonnet-4-6", label: "Sonnet 4.6" }), {
    shouldClear: true,
    notice: "switched to Sonnet 4.6 — fresh chat",
  });
  // switching engine (claude → codex): clears + announces
  assert.deepEqual(describeModelSwitch("claude-opus-4-8", { id: "gpt-5-codex", label: "Codex" }), {
    shouldClear: true,
    notice: "switched to Codex — fresh chat",
  });
});

test("composeWireMessage sends codex the typed text VERBATIM (no AIOS framing)", () => {
  // codex titles the shared ~/.codex thread from its first user message, so no
  // agent/ultracode/plan/goal/memory prefix may leak into the wire text.
  const typed = "add retry backoff to the fetch helper";
  for (const budget of ["lean", "agent", "ultracode"] as const) {
    assert.equal(
      composeWireMessage({
        display: typed,
        engine: "codex",
        effectiveBudget: budget,
        goal: "ship the collector rewrite",
        planMode: true,
        wirePrefix: "Relevant AIOS memory context:\n1. foo\n\n",
      }),
      typed,
      `codex wire must equal typed text for budget=${budget}`,
    );
  }
});

test("modePrefixFor returns no mode prefix for codex, banners for others", () => {
  assert.equal(modePrefixFor("codex", "agent"), "");
  assert.equal(modePrefixFor("codex", "ultracode"), "");
  // claude (native subagents) gets the orchestrate banners
  assert.match(modePrefixFor("claude", "agent"), /^Agent mode is ON\. For any task/);
  assert.match(modePrefixFor("claude", "ultracode"), /^Ultracode mode is ON\./);
  // opencode (direct tools, no fan-out) gets the DIRECT banners, never codex-empty
  assert.match(modePrefixFor("opencode", "agent"), /direct file-edit and shell tools/);
  assert.match(modePrefixFor("opencode", "ultracode"), /^Ultracode mode is ON\./);
  // lean budget = no mode banner for anyone
  assert.equal(modePrefixFor("claude", "lean"), "");
});

test("composeWireMessage keeps the full prefix stack for non-codex engines", () => {
  const wire = composeWireMessage({
    display: "do the thing",
    engine: "claude",
    effectiveBudget: "agent",
    goal: "win the deal",
    planMode: true,
    wirePrefix: "MEM\n\n",
  });
  // outermost-first: agent banner → plan → goal → wirePrefix → typed text
  assert.match(wire, /^Agent mode is ON\./);
  assert.ok(wire.includes("Plan first:"));
  assert.ok(wire.includes("Ongoing goal (keep pursuing this"));
  assert.ok(wire.includes("win the deal"));
  assert.ok(wire.endsWith("MEM\n\ndo the thing"));
});
