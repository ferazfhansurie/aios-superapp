// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { CORE_PANE_TYPES, gridTrackStorageKey, isCorePaneKind, migrateLayoutPanes, movePane, newPaneKey } from "./paneLayout.ts";

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

test("core pane policy keeps only browser, chat, terminal, files, history, and mission surfaces", () => {
  assert.deepEqual([...CORE_PANE_TYPES], ["browser", "chat", "files", "history", "oracle", "shell", "tmux", "mission"]);
  for (const type of ["browser", "chat", "files", "oracle", "shell", "tmux", "mission"]) {
    assert.equal(isCorePaneKind(type), true, `${type} should be core`);
  }
  for (const type of ["app", "appcast", "apps", "bridges", "chrome", "editor", "file", "git", "memory", "money-agents", "notes", "notifications", "plugins", "pulse"]) {
    assert.equal(isCorePaneKind(type), false, `${type} should be cut from the runtime shell`);
  }
});

test("newPaneKey mints k-<kind>-<shortid> and respects the taken set", () => {
  const key = newPaneKey("shell");
  assert.match(key, /^k-shell-[a-z0-9]+$/);
  // kind is sanitized so the key stays tmux-session-safe
  assert.match(newPaneKey("Money Agents!"), /^k-money-agents-[a-z0-9]+$/);
  assert.match(newPaneKey("///"), /^k-pane-[a-z0-9]+$/);
  // uniqueness against an existing layout
  const taken = new Set([key]);
  assert.notEqual(newPaneKey("shell", taken), key);
});

test("migrateLayoutPanes assigns keys ONCE to keyless entries and flags the change", () => {
  const { panes, changed } = migrateLayoutPanes([
    { label: "terminal", kind: { type: "shell", cwd: "/tmp" } },
    { label: "browser", kind: { type: "browser", url: "https://x.com" } },
  ]);
  assert.equal(changed, true);
  assert.equal(panes.length, 2);
  assert.match(panes[0].key, /^k-shell-/);
  assert.match(panes[1].key, /^k-browser-/);
  assert.notEqual(panes[0].key, panes[1].key);
  // payload survives untouched
  assert.deepEqual(panes[0].kind, { type: "shell", cwd: "/tmp" });
  assert.equal(panes[1].label, "browser");
});

test("migrateLayoutPanes passes through existing keys untouched (changed=false)", () => {
  const saved = [
    { key: "k12-ab3f", label: "terminal", kind: { type: "shell" } }, // legacy key shape
    { key: "k-chat-x7q2p1", label: "chat", kind: { type: "chat", cwd: "/x" } },
  ];
  const { panes, changed } = migrateLayoutPanes(saved);
  assert.equal(changed, false);
  assert.deepEqual(
    panes.map((p) => p.key),
    ["k12-ab3f", "k-chat-x7q2p1"],
  );
});

test("migrateLayoutPanes drops non-core panes and persists the cleanup", () => {
  const { panes, changed } = migrateLayoutPanes([
    {
      key: "k-git-aaaa",
      label: "git",
      kind: { type: "git", root: "/repo" },
    },
    {
      key: "k-editor-bbbb",
      label: "editor",
      kind: { type: "editor", path: "/repo/a.ts", name: "a.ts" },
    },
    {
      key: "k-chat-good",
      label: "chat",
      kind: { type: "chat", cwd: "/repo", modelId: "x" },
    },
    { key: "k-history-good", label: "history", kind: { type: "history" } },
    { key: "k-browser-good", label: "browser", kind: { type: "browser", url: "https://x.com" } },
    { key: "k-memory-cccc", label: "memory", kind: { type: "memory" } },
  ]);
  assert.equal(changed, true);
  assert.deepEqual(
    panes.map((p) => p.kind.type),
    ["chat", "history", "browser"],
  );
  assert.equal(panes[0].key, "k-chat-good");
  assert.equal(panes[0].kind.cwd, "/repo");
});

test("migrateLayoutPanes tolerates junk without nuking valid entries", () => {
  const { panes, changed } = migrateLayoutPanes([
    null,
    42,
    { label: "no kind here" },
    { key: "k-shell-good1", label: "ok", kind: { type: "shell" } },
  ]);
  // skips never set changed (a parse oddity must not rewrite stored data)
  assert.equal(changed, false);
  assert.equal(panes.length, 1);
  assert.equal(panes[0].key, "k-shell-good1");
});

test("migrateLayoutPanes returns empty for non-array input", () => {
  assert.deepEqual(migrateLayoutPanes(null), { panes: [], changed: false });
  assert.deepEqual(migrateLayoutPanes({ not: "an array" }), { panes: [], changed: false });
});

test("migrateLayoutPanes minted keys never collide with keys already in the layout", () => {
  // run enough iterations that a collision-prone impl would trip
  for (let i = 0; i < 50; i++) {
    const { panes } = migrateLayoutPanes([
      { key: "k-shell-fixed", label: "a", kind: { type: "shell" } },
      { label: "b", kind: { type: "shell" } },
      { label: "c", kind: { type: "shell" } },
    ]);
    const keys = panes.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length);
  }
});
