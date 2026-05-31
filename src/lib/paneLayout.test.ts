// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { gridTrackStorageKey, movePane } from "./paneLayout.ts";

test("movePane reorders panes and returns selected destination", () => {
  const state = movePane(["a", "b", "c"], 1, -1);

  assert.deepEqual(state.items, ["b", "a", "c"]);
  assert.equal(state.selected, 0);
});

test("movePane clamps at edges", () => {
  assert.deepEqual(movePane(["a", "b"], 0, -1), { items: ["a", "b"], selected: 0 });
  assert.deepEqual(movePane(["a", "b"], 1, 1), { items: ["a", "b"], selected: 1 });
});

test("gridTrackStorageKey scopes persisted sizes by grid shape", () => {
  assert.equal(gridTrackStorageKey("aios.grid", 2, 3), "aios.grid:2x3");
});
