// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { buildAiosShellContext } from "./aiosContext.ts";

test("buildAiosShellContext names concrete shell-native controls", () => {
  const text = buildAiosShellContext({
    cwd: "/Users/firazfhansurie/Repo/firaz/aios/shell",
    paneKey: "k-chat",
    attachedMemoryCount: 2,
  });

  assert.match(text, /local tauri aios shell/);
  assert.match(text, /current project\/cwd: \/Users\/firazfhansurie\/Repo\/firaz\/aios\/shell/);
  assert.match(text, /current chat pane key: k-chat/);
  assert.match(text, /attached memory count for this turn: 2/);
  assert.match(text, /open browser pane/);
  assert.match(text, /open file pane/);
  assert.match(text, /spawn terminal pane/);
  assert.match(text, /run events are structured state/);
  assert.match(text, /command registry/);
});

test("buildAiosShellContext has an explicit unknown-cwd fallback", () => {
  const text = buildAiosShellContext();

  assert.match(text, /current project\/cwd: unknown/);
  assert.match(text, /current chat pane key: unknown/);
});
