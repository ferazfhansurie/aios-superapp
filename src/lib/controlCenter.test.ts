// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildJarvisBriefing,
  formatRelativeRunAge,
  summarizeAgentFleet,
  summarizeNotifications,
} from "./controlCenter.ts";

test("summarizeAgentFleet surfaces running, blocked, and approval state", () => {
  const fleet = summarizeAgentFleet([
    {
      id: "growth",
      label: "growth",
      health: "needs-steer",
      primaryMetric: "3 queued",
      currentJob: "image asset missing",
      nextAction: "approve asset fix",
      schedule: "daily",
      lastRunAt: Date.now() - 60_000,
    },
    {
      id: "outreach",
      label: "outreach",
      health: "scheduled",
      primaryMetric: "6 leads",
      currentJob: "zapeus",
      nextAction: "prepare evidence",
      schedule: "daily",
      lastRunAt: Date.now() - 120_000,
    },
  ]);

  assert.equal(fleet.total, 2);
  assert.equal(fleet.needsControl, 1);
  assert.equal(fleet.runningOrScheduled, 1);
  assert.match(fleet.headline, /control needed/);
});

test("formatRelativeRunAge produces compact dashboard labels", () => {
  assert.equal(formatRelativeRunAge(null, 1000), "never");
  assert.equal(formatRelativeRunAge(1000 - 60_000, 1000), "1m ago");
  assert.equal(formatRelativeRunAge(1000 - 2 * 60 * 60_000, 1000), "2h ago");
});

test("summarizeNotifications prioritizes unread warnings", () => {
  const summary = summarizeNotifications([
    { id: "n1", source: "chat", title: "read", level: "info", read: true, at: 100 },
    { id: "n2", source: "monitor", title: "approval needed", level: "warning", read: false, at: 200 },
    { id: "n3", source: "system", title: "done", level: "success", read: false, at: 300 },
  ]);

  assert.equal(summary.unreadCount, 2);
  assert.equal(summary.importantCount, 1);
  assert.equal(summary.items[0].title, "approval needed");
});

test("buildJarvisBriefing converts notifications into next conversation prompts", () => {
  const briefing = buildJarvisBriefing({
    agents: [],
    notifications: [
      {
        id: "n1",
        source: "chat",
        title: "growth needs approval",
        body: "image asset missing",
        level: "warning",
        read: false,
        at: 100,
      },
    ],
    focus: { title: "aios shell", detail: "dashboard work" },
  });

  assert.match(briefing.primaryPrompt, /growth needs approval/);
  assert.equal(briefing.unreadCount, 1);
  assert.equal(briefing.talkPrompt.includes("image asset missing"), true);
});
