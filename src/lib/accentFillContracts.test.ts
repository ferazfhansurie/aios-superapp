// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const src = new URL("..", import.meta.url).pathname;
const fill = "bg-[var(--color-accent)]";
const fg = "text-[var(--color-accent-fg)]";
const hover = "hover:bg-[var(--color-accent-hover)]";
const hoverFg = "hover:text-[var(--color-accent-hover-fg)]";

const solidAccentFixtures = [
  ["App.tsx", false],
  ["components/MissionBoard.tsx", false],
  ["components/WrmsDevicePane.tsx", false],
  ["components/Composer.tsx", true],
  ["components/PaneErrorBoundary.tsx", true],
  ["components/AppAttachPane.tsx", true],
  ["components/AttachAppsPane.tsx", true],
  ["components/IdleControlCenter.tsx", true],
  ["components/OracleRoster.tsx", true],
  ["components/TerminalComposer.tsx", true],
  ["components/chat/ApprovalCards.tsx", true],
] as const;

function classStrings(source: string): string[] {
  return [...source.matchAll(/["'`]([^"'`\n]*bg-\[var\(--color-accent\)\][^"'`\n]*)["'`]/g)]
    .map((match) => match[1]);
}

function assertSolidFillContract(classes: string[]): void {
  for (const value of classes) {
    if (value.includes(fill)) {
      assert.ok(value.includes(fg), `solid accent fill lacks ${fg}: ${value}`);
      if (value.includes(hover)) {
        assert.ok(value.includes(hoverFg), `accent hover lacks ${hoverFg}: ${value}`);
      }
    }
  }
}

test("solid accent class contract is bidirectional and rejects hardcoded foregrounds", () => {
  assertSolidFillContract([`${fill} ${fg}`, `${fg} ${fill}`]);
  assert.throws(() => assertSolidFillContract([`${fill} text-white`]));
  assert.throws(() => assertSolidFillContract([`text-black ${fill}`]));
  assert.throws(() => assertSolidFillContract([`${fill} ${fg} ${hover}`]));
});

test("known solid accent controls carry foreground tokens in either class order", () => {
  for (const [relativePath, hasHover] of solidAccentFixtures) {
    const source = readFileSync(join(src, relativePath), "utf8");
    const classes = classStrings(source);
    assert.ok(
      classes.some((value) => value.includes(fill) && value.includes(fg)),
      `${relativePath} lacks a solid accent fill with ${fg}`,
    );
    if (hasHover) {
      assert.ok(
        classes.some((value) => value.includes(fill) && value.includes(hover) && value.includes(hoverFg)),
        `${relativePath} lacks ${hoverFg} for its accent hover fill`,
      );
    }
  }
});

test("css accent fills are constrained to decorative status dots", () => {
  const css = readFileSync(join(src, "App.css"), "utf8");
  const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*background:\s*var\(--color-accent\);[^{}]*\}/g)]
    .map((match) => match[1].trim());
  assert.deepEqual(selectors, [".status-dot--hot"]);
});
