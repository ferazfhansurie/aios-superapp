// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  isHttpPaneTarget,
  isPaneFileTarget,
  normalizePaneFileTarget,
  resolvePaneFileTarget,
  targetLabel,
} from "./paneRouting.ts";

// ── isHttpPaneTarget ────────────────────────────────────────────────────────

test("isHttpPaneTarget recognises http(s) URLs (trimmed), nothing else", () => {
  assert.equal(isHttpPaneTarget("https://example.com"), true);
  assert.equal(isHttpPaneTarget("http://localhost:3000"), true);
  assert.equal(isHttpPaneTarget("  https://x.dev/path  "), true);
  assert.equal(isHttpPaneTarget("HTTPS://X.DEV"), true);
  assert.equal(isHttpPaneTarget("ftp://host/file"), false);
  assert.equal(isHttpPaneTarget("file:///a/b.ts"), false);
  assert.equal(isHttpPaneTarget("/abs/file.ts"), false);
});

// ── normalizePaneFileTarget ─────────────────────────────────────────────────

test("normalizePaneFileTarget trims and strips wrapping delimiters", () => {
  assert.equal(normalizePaneFileTarget("  /a/b.ts  "), "/a/b.ts");
  assert.equal(normalizePaneFileTarget("<src/App.tsx>"), "src/App.tsx");
  assert.equal(normalizePaneFileTarget('"src/App.tsx"'), "src/App.tsx");
  assert.equal(normalizePaneFileTarget("'src/App.tsx'"), "src/App.tsx");
  assert.equal(normalizePaneFileTarget("`src/App.tsx`"), "src/App.tsx");
});

test("normalizePaneFileTarget strips trailing :line and :line:col", () => {
  assert.equal(normalizePaneFileTarget("src/App.tsx:42"), "src/App.tsx");
  assert.equal(normalizePaneFileTarget("src/App.tsx:42:10"), "src/App.tsx");
});

test("normalizePaneFileTarget strips a trailing #fragment", () => {
  assert.equal(normalizePaneFileTarget("src/App.tsx#L40"), "src/App.tsx");
  assert.equal(normalizePaneFileTarget("src/App.tsx#L40-L48"), "src/App.tsx");
});

test("normalizePaneFileTarget decodes file:// URLs to a plain path", () => {
  assert.equal(
    normalizePaneFileTarget("file:///Users/firaz/a%20b.ts"),
    "/Users/firaz/a b.ts",
  );
  // fragment stripped before parse, line stripped after.
  assert.equal(normalizePaneFileTarget("file:///a/b.ts:30"), "/a/b.ts");
});

// ── isPaneFileTarget ────────────────────────────────────────────────────────

test("isPaneFileTarget accepts path-shaped targets", () => {
  assert.equal(isPaneFileTarget("/abs/file.ts"), true);
  assert.equal(isPaneFileTarget("~/notes.md"), true);
  assert.equal(isPaneFileTarget("./rel.ts"), true);
  assert.equal(isPaneFileTarget("../rel.ts"), true);
  assert.equal(isPaneFileTarget("src/App.tsx"), true); // RELATIVE_ROOTS
  assert.equal(isPaneFileTarget("docs/readme.md"), true);
  assert.equal(isPaneFileTarget("bare.ts"), true); // FILEISH_SEGMENT
  assert.equal(isPaneFileTarget("src/App.tsx:42"), true); // line suffix normalized off
});

test("isPaneFileTarget rejects prose, empties, and dotless non-rooted paths", () => {
  assert.equal(isPaneFileTarget(""), false);
  assert.equal(isPaneFileTarget("   "), false);
  assert.equal(isPaneFileTarget("just some words"), false); // whitespace
  assert.equal(isPaneFileTarget("randomword"), false); // no dot, no root, no slash
  assert.equal(isPaneFileTarget("foo/bar/baz"), false); // dir-ish, no ext, not a known root
});

// Characterization of the deliberately-permissive fileish shape. A bare dotted
// token (`example.com`) is indistinguishable from a bare filename (`config.json`)
// by shape alone, so both classify as file targets — URLs are caught earlier by
// isHttpPaneTarget, and the backend existence check is the real gate (a path
// that doesn't resolve never opens). Pin this so the contract is explicit.
test("isPaneFileTarget treats any bare dotted token as fileish (existence-gated downstream)", () => {
  assert.equal(isPaneFileTarget("config.json"), true);
  assert.equal(isPaneFileTarget("example.com"), true);
  assert.equal(isPaneFileTarget("a.b.c"), true);
  // the extension run is capped at 12 chars: 12 ok, 13 falls through.
  assert.equal(isPaneFileTarget("file.abcdefghijkl"), true);
  assert.equal(isPaneFileTarget("file.abcdefghijklm"), false);
});

// ── resolvePaneFileTarget ───────────────────────────────────────────────────

test("resolvePaneFileTarget resolves ./ and ../ against the base file's dir", () => {
  assert.equal(resolvePaneFileTarget("./util.ts", "/a/b/main.ts"), "/a/b/util.ts");
  assert.equal(resolvePaneFileTarget("../util.ts", "/a/b/main.ts"), "/a/util.ts");
  assert.equal(
    resolvePaneFileTarget("../../x/y.ts", "/a/b/c/main.ts"),
    "/a/x/y.ts",
  );
});

test("resolvePaneFileTarget leaves absolute, tilde, and non-dot-relative targets alone", () => {
  assert.equal(resolvePaneFileTarget("/abs.ts", "/a/b/main.ts"), "/abs.ts");
  assert.equal(resolvePaneFileTarget("~/x.ts", "/a/b/main.ts"), "~/x.ts");
  // bare relative (no ./ prefix) is NOT joined to the base — returned as-is.
  assert.equal(resolvePaneFileTarget("src/App.tsx", "/a/b/main.ts"), "src/App.tsx");
  // no base → nothing to resolve against.
  assert.equal(resolvePaneFileTarget("./util.ts", undefined), "./util.ts");
});

// ── targetLabel ─────────────────────────────────────────────────────────────

test("targetLabel returns the basename, normalizing decorations first", () => {
  assert.equal(targetLabel("/a/b/file.ts"), "file.ts");
  assert.equal(targetLabel("file.ts"), "file.ts");
  assert.equal(targetLabel("src/App.tsx:42"), "App.tsx");
  assert.equal(targetLabel("<docs/readme.md>"), "readme.md");
  assert.equal(targetLabel("/a/b/"), "b"); // trailing slash dropped
  assert.equal(targetLabel(""), "file"); // fallback
});

test("normalizePaneFileTarget collapses a lone wrapping delimiter to empty", () => {
  // a single-char delimiter satisfies startsWith == endsWith → slice(1,-1) === "".
  assert.equal(normalizePaneFileTarget('"'), "");
  assert.equal(normalizePaneFileTarget("'"), "");
});
