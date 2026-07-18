// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { decideAiosProvider } from "./aiosRouterPolicy.ts";

test("AIOS keeps the Claude Code harness while fresh 5h usage is below 100%", () => {
  for (const pct of [0, 1, 50, 99, 99.99]) {
    assert.equal(decideAiosProvider({ claudeFiveHourPct: pct, claudeHardLimited: false }), "claude");
  }
});

test("AIOS routes Codex when Claude 5h usage reaches 100%", () => {
  assert.equal(decideAiosProvider({ claudeFiveHourPct: 100, claudeHardLimited: false }), "codex");
});

test("AIOS keeps the Claude Code harness when the Claude meter is unknown", () => {
  assert.equal(decideAiosProvider({ claudeFiveHourPct: null, claudeHardLimited: false }), "claude");
});

test("an authoritative Claude hard limit overrides a stale sub-100 meter", () => {
  assert.equal(decideAiosProvider({ claudeFiveHourPct: 42, claudeHardLimited: true }), "codex");
});

test("a stale zero from the same window cannot clear an earlier hard limit", () => {
  assert.equal(decideAiosProvider({ claudeFiveHourPct: 0, claudeHardLimited: true, resetWindowAdvanced: false }), "codex");
});

test("a zero meter in a new reset window clears an earlier hard limit", () => {
  assert.equal(decideAiosProvider({ claudeFiveHourPct: 0, claudeHardLimited: true, resetWindowAdvanced: true }), "claude");
});
