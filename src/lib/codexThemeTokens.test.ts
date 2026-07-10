// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../App.css", import.meta.url), "utf8");

function tokenBlock(selector: string): string {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `missing ${selector} token layer`);
  const end = css.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated ${selector} token layer`);
  return css.slice(start, end + 2);
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  assert.ok(match, `missing ${name}`);
  return match[1].trim();
}

test("dark token layers use the calibrated Codex ground, surfaces, and borders", () => {
  const fallback = tokenBlock("@theme");
  const dark = tokenBlock('html[data-theme="dark"]');

  for (const block of [fallback, dark]) {
    assert.equal(token(block, "--color-bg"), "#000");
    assert.equal(token(block, "--color-pane"), "#181818");
    assert.equal(token(block, "--color-panel"), "#181818");
    assert.equal(token(block, "--color-panel-2"), "#212121");
    assert.equal(token(block, "--color-border"), "#ffffff14");
    assert.equal(token(block, "--color-border-light"), "#ffffff0a");
    assert.equal(token(block, "--color-border-strong"), "#ffffff29");
  }
});

test("dark immutable semantic roles use the calibrated values", () => {
  const dark = tokenBlock('html[data-theme="dark"]');

  assert.equal(token(dark, "--color-focus"), "#339cffb3");
  assert.equal(token(dark, "--color-warning-accent"), "#fb6a22");
  assert.equal(token(dark, "--color-warning-fg"), "#000");
  assert.equal(token(dark, "--color-warning-soft"), "#fb6a221f");
  assert.equal(token(dark, "--color-success-accent"), "#04b84c");
  assert.equal(token(dark, "--color-danger-accent"), "#fa423e");
  assert.equal(token(dark, "--color-diff-add"), "#04b84c1f");
  assert.equal(token(dark, "--color-diff-delete"), "#fa423e1f");
});

test("light immutable semantic roles have paired values", () => {
  const light = tokenBlock('html[data-theme="light"]');

  assert.equal(token(light, "--color-focus"), "#0285ffb3");
  assert.equal(token(light, "--color-warning-accent"), "#e25507");
  assert.equal(token(light, "--color-warning-fg"), "#000");
  assert.equal(token(light, "--color-warning-soft"), "#ffe7d9");
  assert.equal(token(light, "--color-success-accent"), "#00a240");
  assert.equal(token(light, "--color-danger-accent"), "#e02e2a");
  assert.equal(token(light, "--color-diff-add"), "#00a2401f");
  assert.equal(token(light, "--color-diff-delete"), "#e02e2a1f");
});
