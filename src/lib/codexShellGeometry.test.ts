// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../App.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const agents = readFileSync(new URL("../components/AgentsSection.tsx", import.meta.url), "utf8");

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

function rule(selector: string): string {
  const match = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing ${selector} primitive`);
  return match[1];
}

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

function componentsLayer(): string {
  const start = css.indexOf("@layer components {");
  assert.notEqual(start, -1, "missing Tailwind components layer");
  let depth = 0;
  let opened = false;
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === "{") {
      depth += 1;
      opened = true;
    }
    if (css[index] === "}") depth -= 1;
    if (opened && depth === 0) return css.slice(start, index + 1);
  }
  assert.fail("unterminated Tailwind components layer");
}

test("global geometry aliases preserve the calibrated spacing and radii", () => {
  const fallback = tokenBlock("@theme");

  assert.equal(token(fallback, "--aios-space-1"), "4px");
  assert.equal(token(fallback, "--aios-radius-row"), "10px");
  assert.equal(token(fallback, "--aios-radius-card"), "15px");
  assert.equal(token(fallback, "--aios-radius-bubble"), "20px");
  assert.equal(token(fallback, "--aios-radius-composer"), "30px");
});

test("shared primitives map active shell surfaces to semantic geometry roles", () => {
  assert.match(rule(".shell-row"), /border-radius:\s*var\(--aios-radius-row\)/);
  assert.match(rule(".shell-card"), /border-radius:\s*var\(--aios-radius-card\)/);
  assert.match(rule(".shell-hover:hover"), /background:\s*var\(--color-hover\)/);
  assert.doesNotMatch(rule(".shell-row"), /color\s*:/);
  assert.doesNotMatch(css, /\.shell-(bubble|composer|elevated|active)\b/);
  assert.match(componentsLayer(), /\.shell-card/);
});

test("shared focus has one immutable, visible keyboard-focus API", () => {
  const focusWithin = rule(".shell-focus:focus-within");
  const focusVisible = rule(".shell-focus:focus-visible");

  assert.match(focusWithin, /border-color:\s*var\(--color-focus\)/);
  assert.match(focusVisible, /outline:\s*2px solid var\(--color-focus\)/);
  assert.doesNotMatch(focusWithin, /--color-accent/);
  assert.doesNotMatch(css, /\.focus-accent/);
});

test("PaneCard retains its explicit accent drop-target utility over shell geometry", () => {
  const paneCard = between(app, "const PaneCard = memo(function PaneCard", "\nfunction Splash");

  assert.match(paneCard, /shell-card shell-pane/);
  assert.match(paneCard, /pane-header !h-7 !px-2\.5/);
  assert.match(paneCard, /surface-pop absolute right-0 top-6/);
  assert.match(paneCard, /shell-row shell-hover shell-focus/);
  assert.match(paneCard, /dropTarget\s*\?\s*"border-\[var\(--color-accent\)\]"/);
});

test("AgentsSection consumes shell roles without mutable accent focus or text-role overrides", () => {
  const agentForm = between(agents, "const form = creating", "\n  const body");

  assert.match(agentForm, /className="shell-card/);
  assert.ok((agentForm.match(/shell-row shell-focus/g) ?? []).length >= 4);
  assert.match(agentForm, /shell-row shell-hover shell-focus[^"`]*text-\[var\(--color-muted\)\]/);
  assert.doesNotMatch(agentForm, /\bfocus(?:-(?:visible|within))?:[^\s"`]*accent/);
  assert.doesNotMatch(app, /\bfocus(?:-(?:visible|within))?:[^\s"`]*accent/);
});
