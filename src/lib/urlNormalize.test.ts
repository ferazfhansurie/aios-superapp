// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { isLikelySearch, normalizeUrl } from "./urlNormalize.ts";

// ── dev/loopback shapes → direct navigation over http:// (NEVER a search) ──

test("localhost:3000 navigates directly with http://", () => {
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000");
});

test("bare localhost (no port) navigates with http://", () => {
  assert.equal(normalizeUrl("localhost"), "http://localhost");
  assert.equal(normalizeUrl("localhost/admin"), "http://localhost/admin");
});

test("127.0.0.1:8080 navigates with http://", () => {
  assert.equal(normalizeUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
});

test("0.0.0.0[:port] navigates with http://", () => {
  assert.equal(normalizeUrl("0.0.0.0"), "http://0.0.0.0");
  assert.equal(normalizeUrl("0.0.0.0:5173"), "http://0.0.0.0:5173");
});

test("[::1]:3000 navigates with http://", () => {
  assert.equal(normalizeUrl("[::1]:3000"), "http://[::1]:3000");
});

test("*.local mDNS hosts navigate with http://", () => {
  assert.equal(normalizeUrl("myapp.local"), "http://myapp.local");
  assert.equal(normalizeUrl("raspberrypi.local:8080"), "http://raspberrypi.local:8080");
  assert.equal(normalizeUrl("dev.myapp.local/path"), "http://dev.myapp.local/path");
});

test("raw IPs (with or without port) navigate with http://", () => {
  assert.equal(normalizeUrl("192.168.1.10:3000"), "http://192.168.1.10:3000");
  assert.equal(normalizeUrl("192.168.1.10"), "http://192.168.1.10");
  assert.equal(normalizeUrl("10.0.0.5/status"), "http://10.0.0.5/status");
});

test("any bare host:port with a numeric port navigates with http://", () => {
  assert.equal(normalizeUrl("myapp:8080"), "http://myapp:8080");
  assert.equal(normalizeUrl("example.com:8080"), "http://example.com:8080");
  assert.equal(normalizeUrl("myapp:3000/dashboard"), "http://myapp:3000/dashboard");
});

// ── explicit scheme → as-is ─────────────────────────────────────────────────

test("explicit scheme passes through untouched", () => {
  assert.equal(normalizeUrl("https://x.dev/path"), "https://x.dev/path");
  assert.equal(normalizeUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrl("file:///Users/firaz/doc.pdf"), "file:///Users/firaz/doc.pdf");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
});

test("explicit http:// on a public host is NOT upgraded to https", () => {
  assert.equal(normalizeUrl("http://example.com"), "http://example.com");
});

// ── dotted public host, no spaces → https:// ────────────────────────────────

test("example.com gets https://", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("sub.domain.dev/path?q=1"), "https://sub.domain.dev/path?q=1");
});

// ── everything else → search engine ────────────────────────────────────────

test("plain words go to the search engine", () => {
  assert.equal(
    normalizeUrl("how to cook rice"),
    "https://www.google.com/search?q=how%20to%20cook%20rice",
  );
});

test("a dotted host followed by more words is a search, not a navigation", () => {
  assert.equal(
    normalizeUrl("example.com is down"),
    "https://www.google.com/search?q=example.com%20is%20down",
  );
});

test("bare filesystem paths are not URL shapes today — they go to search", () => {
  // file paths reach the pane via the drop handler (file:// is built there);
  // typed absolute paths have never been navigable from the address bar.
  assert.equal(
    normalizeUrl("/Users/firaz/doc.pdf"),
    "https://www.google.com/search?q=%2FUsers%2Ffiraz%2Fdoc.pdf",
  );
});

test("empty / whitespace input normalizes to empty", () => {
  assert.equal(normalizeUrl(""), "");
  assert.equal(normalizeUrl("   "), "");
});

// ── isLikelySearch mirrors the same heuristics ──────────────────────────────

test("isLikelySearch agrees with normalizeUrl's branches", () => {
  assert.equal(isLikelySearch("how to cook rice"), true);
  assert.equal(isLikelySearch("example.com is down"), true);
  assert.equal(isLikelySearch("localhost:3000"), false);
  assert.equal(isLikelySearch("127.0.0.1:8080"), false);
  assert.equal(isLikelySearch("myapp.local"), false);
  assert.equal(isLikelySearch("192.168.1.10:3000"), false);
  assert.equal(isLikelySearch("example.com"), false);
  assert.equal(isLikelySearch("https://x.dev/path"), false);
  assert.equal(isLikelySearch(""), false);
});
