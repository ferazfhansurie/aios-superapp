// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_IDLE_WIDGETS,
  moveIdleWidget,
  normalizeIdleWidgets,
  toggleIdleWidget,
} from "./idleDashboardLayout.ts";

test("normalizeIdleWidgets preserves valid custom order and backfills new defaults", () => {
  const widgets = normalizeIdleWidgets([
    { id: "apps", visible: false },
    { id: "pulse", visible: true },
    { id: "missing", visible: true },
    { id: "apps", visible: true },
  ]);

  assert.equal(widgets[0].id, "apps");
  assert.equal(widgets[0].visible, false);
  assert.equal(widgets[1].id, "pulse");
  assert.deepEqual(
    widgets.map((w) => w.id).sort(),
    DEFAULT_IDLE_WIDGETS.map((w) => w.id).sort(),
  );
});

test("moveIdleWidget reorders and clamps at edges", () => {
  const widgets = normalizeIdleWidgets([
    { id: "pulse" },
    { id: "projects" },
    { id: "apps" },
  ]);

  assert.equal(moveIdleWidget(widgets, "projects", -1)[0].id, "projects");
  assert.equal(moveIdleWidget(widgets, "pulse", -1)[0].id, "pulse");
});

test("toggleIdleWidget flips visibility only for the target widget", () => {
  const widgets = normalizeIdleWidgets([{ id: "pulse", visible: true }]);
  const next = toggleIdleWidget(widgets, "pulse");

  assert.equal(next.find((w) => w.id === "pulse")?.visible, false);
  assert.equal(next.find((w) => w.id === "projects")?.visible, true);
});
