// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  commandToPaletteCommand,
  createCommand,
  runCommand,
} from "./commands.ts";

const ctx = { source: "test" };

/** Minimal valid CommandInput; override per test. */
function input(over = {}) {
  return { id: "x", label: "X", scope: "global", run: () => {}, ...over };
}

// ── createCommand: defaults ─────────────────────────────────────────────────

test("createCommand fills defaults for omitted fields", () => {
  const cmd = createCommand(input());
  assert.equal(cmd.danger, "none");
  assert.deepEqual(cmd.hotkeys, []);
  assert.deepEqual(cmd.keywords, []);
  assert.equal(typeof cmd.enabled, "function");
  assert.equal(cmd.enabled(ctx), true);
});

test("createCommand preserves explicitly provided fields", () => {
  const enabled = () => false;
  const cmd = createCommand(
    input({ danger: "destructive", hotkeys: ["mod+k"], keywords: ["a"], enabled }),
  );
  assert.equal(cmd.danger, "destructive");
  assert.deepEqual(cmd.hotkeys, ["mod+k"]);
  assert.deepEqual(cmd.keywords, ["a"]);
  assert.equal(cmd.enabled, enabled);
});

// ── createCommand: run-result normalization ─────────────────────────────────

test("a string run result becomes { ok: true, message }", async () => {
  const cmd = createCommand(input({ run: () => "done" }));
  assert.deepEqual(await cmd.run(ctx), { ok: true, message: "done" });
});

test("a void/undefined run result becomes { ok: true }", async () => {
  const cmd = createCommand(input({ run: () => {} }));
  assert.deepEqual(await cmd.run(ctx), { ok: true });
});

test("an explicit CommandResult passes through unchanged", async () => {
  const result = { ok: false, error: "nope" };
  const cmd = createCommand(input({ run: () => result }));
  assert.deepEqual(await cmd.run(ctx), result);
});

test("an async run is awaited and normalized", async () => {
  const cmd = createCommand(input({ run: async () => "later" }));
  assert.deepEqual(await cmd.run(ctx), { ok: true, message: "later" });
});

test("run receives the context and input value", async () => {
  let seen;
  const cmd = createCommand(input({ run: (c, v) => { seen = [c, v]; } }));
  await cmd.run(ctx, 42);
  assert.deepEqual(seen, [ctx, 42]);
});

// ── runCommand: the disabled gate (safety invariant) ────────────────────────

test("runCommand refuses a disabled command and never invokes its run", async () => {
  let ran = false;
  const cmd = createCommand(
    input({ danger: "destructive", enabled: () => false, run: () => { ran = true; } }),
  );
  const res = await runCommand(cmd, ctx);
  assert.deepEqual(res, { ok: false, error: "command disabled" });
  assert.equal(ran, false, "a disabled command's run must not execute");
});

test("runCommand executes an enabled command", async () => {
  const cmd = createCommand(input({ run: () => "ok" }));
  assert.deepEqual(await runCommand(cmd, ctx), { ok: true, message: "ok" });
});

// ── commandToPaletteCommand: field mapping ──────────────────────────────────

test("commandToPaletteCommand maps fields with sensible fallbacks", () => {
  const cmd = createCommand(
    input({ label: "Open", description: "opens it", scope: "file", keywords: ["a", "b"] }),
  );
  const pc = commandToPaletteCommand(cmd, { context: ctx });
  assert.equal(pc.id, "x");
  assert.equal(pc.title, "Open");
  assert.equal(pc.subtitle, "opens it"); // falls back to description
  assert.equal(pc.group, "file"); // falls back to scope
  assert.equal(pc.keywords, "a b"); // joined
  assert.equal(pc.actionLabel, undefined);
});

test("commandToPaletteCommand honors explicit subtitle/group/actionLabel", () => {
  const cmd = createCommand(input({ description: "desc", scope: "global" }));
  const pc = commandToPaletteCommand(cmd, {
    context: ctx,
    subtitle: "custom",
    group: "Pinned",
    actionLabel: "Run",
  });
  assert.equal(pc.subtitle, "custom");
  assert.equal(pc.group, "Pinned");
  assert.equal(pc.actionLabel, "Run");
});

test("the palette command's run dispatches through runCommand", async () => {
  let ran = false;
  const cmd = createCommand(input({ run: () => { ran = true; } }));
  const pc = commandToPaletteCommand(cmd, { context: ctx });
  pc.run();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ran, true);
});

test("a disabled command's palette run is gated too", async () => {
  let ran = false;
  const cmd = createCommand(input({ enabled: () => false, run: () => { ran = true; } }));
  const pc = commandToPaletteCommand(cmd, { context: ctx });
  pc.run();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ran, false);
});
