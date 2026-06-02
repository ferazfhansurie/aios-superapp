// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  agentActionPolicy,
  auditAgentAction,
  parseAgentAction,
} from "./agentActions.ts";

test("parseAgentAction accepts safe pane and view actions", () => {
  assert.deepEqual(parseAgentAction({ type: "view.show_overview" }), {
    ok: true,
    action: { type: "view.show_overview" },
  });
  assert.deepEqual(parseAgentAction({ type: "pane.focus", paneKey: "pane-1" }), {
    ok: true,
    action: { type: "pane.focus", paneKey: "pane-1" },
  });
});

test("parseAgentAction rejects unknown or malformed actions", () => {
  assert.deepEqual(parseAgentAction({ type: "pty.write", text: "rm -rf /" }), {
    ok: false,
    error: "unsupported agent action",
  });
  assert.deepEqual(parseAgentAction({ type: "pane.focus" }), {
    ok: false,
    error: "pane.focus requires paneKey",
  });
});

test("agentActionPolicy default-allows ui/read actions only", () => {
  assert.deepEqual(agentActionPolicy({ type: "pane.list" }), {
    allowed: true,
    level: "readonly",
  });
  assert.deepEqual(agentActionPolicy({ type: "browser.navigate", paneKey: "b1", url: "https://example.com" }), {
    allowed: false,
    level: "external",
    reason: "requires confirmation",
  });
  assert.deepEqual(agentActionPolicy({ type: "chat.stop", paneKey: "chat-1" }), {
    allowed: true,
    level: "ui",
  });
});

test("auditAgentAction records source, target, and result without payload bloat", () => {
  assert.deepEqual(
    auditAgentAction({
      source: "chatpane",
      action: { type: "pane.focus", paneKey: "pane-1" },
      result: { ok: true, message: "focused" },
      now: 1_000,
    }),
    {
      ts: 1_000,
      source: "chatpane",
      actionType: "pane.focus",
      target: "pane-1",
      ok: true,
      message: "focused",
    },
  );
});
