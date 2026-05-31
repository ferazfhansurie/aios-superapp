// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { commandToPaletteCommand, createCommand, runCommand } from "./commands.ts";

test("command registry commands expose metadata and disabled state", () => {
  const command = createCommand({
    id: "pane.close",
    label: "close pane",
    description: "close the active pane",
    scope: "pane",
    danger: "destructive",
    enabled: (ctx) => Boolean(ctx.activePaneKey),
    run: () => ({ ok: true }),
  });

  assert.equal(command.id, "pane.close");
  assert.equal(command.danger, "destructive");
  assert.equal(command.enabled({ activePaneKey: null }), false);
  assert.equal(command.enabled({ activePaneKey: "pane-1" }), true);
});

test("commandToPaletteCommand preserves one command id for palette execution", async () => {
  const calls: string[] = [];
  const command = createCommand({
    id: "app.settings.open",
    label: "settings",
    description: "open settings",
    scope: "global",
    keywords: ["preferences", "theme"],
    run: (ctx) => {
      calls.push(ctx.source);
      return { ok: true, message: "opened" };
    },
  });

  const palette = commandToPaletteCommand(command, {
    context: { source: "palette" },
    group: "app",
    actionLabel: "open",
  });

  assert.equal(palette.id, "app.settings.open");
  assert.equal(palette.title, "settings");
  assert.equal(palette.subtitle, "open settings");
  assert.equal(palette.keywords, "preferences theme");

  await palette.run();
  assert.deepEqual(calls, ["palette"]);
});

test("runCommand returns disabled result instead of executing", async () => {
  let ran = false;
  const command = createCommand({
    id: "run.focused",
    label: "run focused project",
    scope: "global",
    enabled: () => false,
    run: () => {
      ran = true;
      return { ok: true };
    },
  });

  const result = await runCommand(command, { source: "test" });

  assert.equal(result.ok, false);
  assert.equal(result.error, "command disabled");
  assert.equal(ran, false);
});
