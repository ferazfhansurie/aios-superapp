// @ts-nocheck -- node test globals are not part of the app tsconfig.
import assert from "node:assert/strict";
import test from "node:test";

import {
  clearPaneHistory,
  describePaneHistoryItem,
  hydratePaneHistoryStore,
  loadPaneHistory,
  recordPaneHistory,
} from "./paneHistory.ts";

const store = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  },
  configurable: true,
});

Object.defineProperty(globalThis, "window", {
  value: {
    dispatchEvent: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  },
  configurable: true,
});

const badInstructionsTitle =
  "# AGENTS.md instructions for /Users/firazfhansurie <INSTRUCTIONS> <critical_persona> you are AIOS";

const resumeKind = {
  type: "chat" as const,
  cwd: "/Users/firazfhansurie",
  resume: {
    id: "019ec098-83a8-7c32-9509-6866c3f5db19",
    title: badInstructionsTitle,
    engine: "codex",
    model: "gpt-5.3-codex-spark",
  },
};

test.beforeEach(() => {
  store.clear();
});

test("pane history gives resumed chats short useful labels instead of instruction dumps", () => {
  const item = describePaneHistoryItem(resumeKind, badInstructionsTitle);

  assert.equal(item.label, "resumed chat · firazfhansurie");
  assert.equal(item.indicator, "resume");
  assert.match(item.detail, /codex session · 019ec098/);
  assert.doesNotMatch(item.label, /agents\.md|instructions|critical_persona/i);
  assert.doesNotMatch(item.detail, /agents\.md|instructions|critical_persona/i);
});

test("pane history collapses repeated opens of the same resumed chat session", () => {
  recordPaneHistory(resumeKind, badInstructionsTitle);
  recordPaneHistory(resumeKind, badInstructionsTitle);
  recordPaneHistory(resumeKind, badInstructionsTitle);

  const items = loadPaneHistory();
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "resumed chat · firazfhansurie");
  assert.equal(items[0].kind.type, "chat");
  if (items[0].kind.type === "chat") {
    assert.equal(items[0].kind.resume?.title, "resumed chat · firazfhansurie");
  }
});

test("pane history cleans and dedupes existing stored bad resume rows on load", () => {
  const rows = [0, 1, 2].map((n) => ({
    id: `h-old-${n}`,
    label: badInstructionsTitle,
    detail: `${badInstructionsTitle} · 019ec098-83a8-7c32-9509-6866c3f5db19`,
    indicator: "resume",
    openedAt: 10_000 - n,
    kind: resumeKind,
  }));
  localStorage.setItem("aios.pane.history.v1", JSON.stringify(rows));

  const items = loadPaneHistory();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "h-old-0");
  assert.equal(items[0].label, "resumed chat · firazfhansurie");
  assert.match(items[0].detail, /codex session · 019ec098/);
});

test("clearPaneHistory works with the test storage", () => {
  recordPaneHistory({ type: "browser", url: "https://example.com" }, "example");
  assert.equal(loadPaneHistory().length, 1);
  clearPaneHistory();
  assert.equal(loadPaneHistory().length, 0);
});

test("hydratePaneHistoryStore keeps the instant cache when tauri db is unavailable", async () => {
  recordPaneHistory({ type: "browser", url: "https://example.com" }, "example");

  const items = await hydratePaneHistoryStore();

  assert.equal(items.length, 1);
  assert.equal(items[0].label, "example");
});
