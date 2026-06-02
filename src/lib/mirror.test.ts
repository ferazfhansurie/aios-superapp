// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { buildMirrorSnapshot, mirrorPaneCapabilities } from "./mirror.ts";

test("mirror snapshot exposes web-safe pane state and controls", () => {
  const snapshot = buildMirrorSnapshot({
    panes: [
      { key: "chat-1", label: "chat", kind: { type: "chat" } },
      { key: "web-1", label: "youtube", kind: { type: "browser", url: "https://youtube.com" } },
      { key: "file-1", label: "secret", kind: { type: "editor", path: "/Users/firaz/secret.ts", name: "secret.ts" } },
    ],
    hiddenKeys: ["file-1"],
    activeKey: "web-1",
    maximizedKey: "web-1",
    sidebarOpen: false,
    overviewOpen: false,
    settingsOpen: true,
    now: 123,
  });

  assert.equal(snapshot.schema, "aios.mirror.v1");
  assert.equal(snapshot.desktop.visiblePanesCount, 2);
  assert.equal(snapshot.panes[1].active, true);
  assert.equal(snapshot.panes[1].renderMode, "visual");
  assert.equal(snapshot.panes[1].resource, "https://youtube.com");
  assert.equal(snapshot.panes[2].resource, "secret.ts");
  assert.equal(snapshot.panes[2].hidden, true);
  assert.ok(snapshot.controls.ui.includes("chat.stop"));
  assert.ok(snapshot.controls.confirmRequired.includes("pane.close"));
});

test("mirror gives chat and browser different control surfaces", () => {
  assert.deepEqual(
    mirrorPaneCapabilities({ type: "chat" }).filter((cap) => cap === "stop" || cap === "detach"),
    ["stop", "detach"],
  );
  assert.ok(mirrorPaneCapabilities({ type: "browser" }).includes("navigate"));
});
