// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MONEY_AGENTS,
  buildMoneyAgentChatSeed,
  loadMoneyAgentChatSession,
  saveMoneyAgentChatSession,
  summarizeMoneyAgentState,
} from "./moneyAgents.ts";

test("money agents define chatpane-backed operating briefs", () => {
  assert.deepEqual(
    MONEY_AGENTS.map((agent) => agent.id),
    ["firaz", "growth", "outreach"],
  );
  const seed = buildMoneyAgentChatSeed(MONEY_AGENTS.find((agent) => agent.id === "growth"));

  assert.match(seed, /you are the aios growth manager/);
  assert.match(seed, /workspace:/);
  assert.match(seed, /gpt-5\.3-codex-spark/);
  assert.match(seed, /first task:/);
  assert.doesNotMatch(seed, /tmux/i);
});

test("money agent chat sessions persist by agent id", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };

  saveMoneyAgentChatSession("growth", {
    sessionId: "claude-agent-session",
    title: "growth agents",
    updatedAt: 123,
  });

  assert.deepEqual(loadMoneyAgentChatSession("growth"), {
    sessionId: "claude-agent-session",
    title: "growth agents",
    updatedAt: 123,
  });
  assert.equal(loadMoneyAgentChatSession("outreach"), null);

  delete globalThis.localStorage;
});

test("summarizeMoneyAgentState returns goal-oriented status", () => {
  const summary = summarizeMoneyAgentState(MONEY_AGENTS.find((agent) => agent.id === "growth"), {
    status: { ok: true, drafted: 3, queued: 8 },
    queue: [{ status: "drafted" }, { status: "posted" }, { status: "ready-to-post" }],
    launchd: { running: true, lastExit: 0 },
  });

  assert.equal(summary.health, "running");
  assert.equal(summary.primaryMetric, "8 queued");
  assert.equal(summary.nextAction, "publish the next approved post at the scheduled slot");
});
