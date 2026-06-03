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

  assert.ok(text.length < 420, `context is too large: ${text.length}`);
  assert.match(text, /local tauri shell/);
  assert.match(text, /cwd: \/Users\/firazfhansurie\/Repo\/firaz\/aios\/shell/);
  assert.match(text, /pane: k-chat/);
  assert.match(text, /attached memory: 2/);
  assert.match(text, /open browser\/file\/editor\/terminal\/chat\/status panes/);
  assert.match(text, /reattach runs/);
  assert.match(text, /run events/);
  assert.doesNotMatch(text, /spawnable pane types/);
  assert.doesNotMatch(text, /native actions available/);
});

test("buildAiosShellContext has an explicit unknown-cwd fallback", () => {
  const text = buildAiosShellContext();

  assert.match(text, /cwd: unknown/);
  assert.match(text, /pane: unknown/);
});
