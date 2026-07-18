// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

const calls: string[] = [];
const values = new Map<string, string>();
const storage = new Map<string, string>();
let storageThrows = false;
const style = {
  setProperty(name: string, value: string) {
    calls.push(name);
    values.set(name, value);
  },
};

Object.defineProperty(globalThis, "document", {
  value: { documentElement: { style, dataset: {} } },
  configurable: true,
});

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem(key: string) { return storage.get(key) ?? null; },
    setItem(key: string, value: string) {
      if (storageThrows) throw new DOMException("quota", "QuotaExceededError");
      storage.set(key, value);
    },
  },
  configurable: true,
});

const { ACCENT_PRESETS, applyAccent, applyTheme, deriveAccentVars, setAccent } = await import("./theme.ts");

test.beforeEach(() => {
  calls.length = 0;
  values.clear();
  storage.clear();
  storageThrows = false;
  document.documentElement.dataset = {};
});

test("orange preset is the Codex warning orange with black foreground", () => {
  assert.equal(ACCENT_PRESETS.orange, "#fb6a22");
  assert.equal(deriveAccentVars(ACCENT_PRESETS.orange).accentFg, "#000000");
});

test("applyAccent changes only the mutable accent family", () => {
  applyAccent("blue");

  for (const token of [
    "--color-accent",
    "--color-accent-hover",
    "--color-accent-dim",
    "--color-accent-soft",
    "--color-cursor",
    "--color-selection",
    "--color-accent-fg",
    "--color-accent-hover-fg",
  ]) assert.ok(calls.includes(token), `missing ${token}`);
  assert.ok(!calls.includes("--color-focus"));
  assert.ok(!calls.includes("--color-warning-accent"));
  assert.ok(!calls.includes("--color-warning-fg"));
  assert.ok(!calls.includes("--color-warning-soft"));
  assert.ok(!calls.includes("--color-success-accent"));
  assert.ok(!calls.includes("--color-danger-accent"));
  assert.ok(!calls.includes("--color-diff-add"));
  assert.ok(!calls.includes("--color-diff-delete"));
});

test("default orange keeps dark and light accent fills contrast-safe", () => {
  applyTheme("dark");
  applyAccent("orange");
  assert.equal(values.get("--color-accent"), "#fb6a22");
  assert.equal(values.get("--color-accent-fg"), "#000000");

  values.clear();
  applyTheme("light");
  assert.equal(values.get("--color-accent"), "#e25507");
  assert.equal(values.get("--color-accent-fg"), "#000000");
});

test("custom accents preserve their own safe foreground in light mode", () => {
  document.documentElement.dataset.theme = "light";
  applyAccent("#1745a8");
  assert.equal(values.get("--color-accent"), "#1745a8");
  assert.equal(values.get("--color-accent-fg"), "#ffffff");
});

test("custom accents retain safe black-or-white foreground selection", () => {
  assert.equal(deriveAccentVars("#f8d34a").accentFg, "#000000");
  assert.equal(deriveAccentVars("#1745a8").accentFg, "#ffffff");
});

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/.{2}/g)!.map((channel) => parseInt(channel, 16) / 255);
    const linear = channels.map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

test("#666666 switches to a contrast-safe hover foreground", () => {
  const vars = deriveAccentVars("#666666");
  assert.equal(vars.accentFg, "#ffffff");
  assert.equal(vars.accentHoverFg, "#000000");
  assert.ok(contrast(vars.accentFg, vars.accent) >= 4.5);
  assert.ok(contrast(vars.accentHoverFg, vars.accentHover) >= 4.5);
});

test("a custom accent survives dark-to-light transitions when persistence fails", () => {
  storageThrows = true;
  setAccent("#1745a8");
  assert.equal(values.get("--color-accent"), "#1745a8");

  applyTheme("dark");
  assert.equal(values.get("--color-accent"), "#1745a8");
  applyTheme("light");
  assert.equal(values.get("--color-accent"), "#1745a8");
  assert.equal(values.get("--color-accent-fg"), "#ffffff");
});
