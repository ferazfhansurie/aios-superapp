// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { createAgentController } from "./agentController.ts";

test("agent controller lists panes and executes safe ui actions", async () => {
  const calls: string[] = [];
  const controller = createAgentController({
    getPanes: () => [{ key: "p1", label: "chat", type: "chat", hidden: false, active: false }],
    focusPane: (key) => calls.push(`focus:${key}`),
    hidePane: (key) => calls.push(`hide:${key}`),
    maximizePane: (key) => calls.push(`max:${key}`),
    closePane: (key) => calls.push(`close:${key}`),
    setSidebarOpen: (open) => calls.push(`sidebar:${open}`),
    setOverviewOpen: (open) => calls.push(`overview:${open}`),
    setSettingsOpen: (open) => calls.push(`settings:${open}`),
    stopChat: (key) => calls.push(`stop:${key}`),
    detachChat: (key) => calls.push(`detach:${key}`),
    audit: (entry) => calls.push(`audit:${entry.actionType}:${entry.ok}`),
  });

  assert.deepEqual(await controller.dispatch({ source: "test", action: { type: "pane.list" } }), {
    ok: true,
    data: [{ key: "p1", label: "chat", type: "chat", hidden: false, active: false }],
  });
  assert.deepEqual(await controller.dispatch({ source: "test", action: { type: "pane.focus", paneKey: "p1" } }), {
    ok: true,
    message: "focused",
  });
  assert.deepEqual(calls, ["audit:pane.list:true", "focus:p1", "audit:pane.focus:true"]);
});

test("agent controller blocks external and destructive actions without confirmation", async () => {
  const calls: string[] = [];
  const controller = createAgentController({
    getPanes: () => [],
    focusPane: () => calls.push("focus"),
    hidePane: () => calls.push("hide"),
    maximizePane: () => calls.push("max"),
    closePane: () => calls.push("close"),
    setSidebarOpen: () => calls.push("sidebar"),
    setOverviewOpen: () => calls.push("overview"),
    setSettingsOpen: () => calls.push("settings"),
    stopChat: () => calls.push("stop"),
    detachChat: () => calls.push("detach"),
    audit: (entry) => calls.push(`audit:${entry.actionType}:${entry.ok}`),
  });

  assert.deepEqual(await controller.dispatch({ source: "test", action: { type: "pane.close", paneKey: "p1" } }), {
    ok: false,
    error: "requires confirmation",
    level: "destructive",
  });
  assert.deepEqual(calls, ["audit:pane.close:false"]);
});
