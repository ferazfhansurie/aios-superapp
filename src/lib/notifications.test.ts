// @ts-nocheck -- node runs this directly with --experimental-strip-types.
import assert from "node:assert/strict";
import test from "node:test";

import {
  clearAllNotifications,
  emitPaneNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  pushNotification,
  subscribeNotifications,
  unreadNotificationCount,
} from "./notifications.ts";

const memory = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear(),
};

test("pushNotification persists newest-first unread notifications", () => {
  memory.clear();
  clearAllNotifications();

  const first = pushNotification({ kind: "chat.done", title: "chat finished" }, { now: 10 });
  const second = pushNotification({ kind: "download.complete", title: "screenshot saved" }, { now: 20 });

  assert.equal(first.read, false);
  assert.equal(second.read, false);
  assert.deepEqual(
    listNotifications().map((n) => n.title),
    ["screenshot saved", "chat finished"],
  );
  assert.equal(unreadNotificationCount(), 2);
});

test("notifications can be marked read and cleared", () => {
  memory.clear();
  clearAllNotifications();
  const item = pushNotification({ kind: "system", title: "ready" }, { now: 10 });

  markNotificationRead(item.id);
  assert.equal(unreadNotificationCount(), 0);

  pushNotification({ kind: "system", title: "next" }, { now: 20 });
  markAllNotificationsRead();
  assert.equal(unreadNotificationCount(), 0);

  clearAllNotifications();
  assert.equal(listNotifications().length, 0);
});

test("notification subscribers receive updates", () => {
  memory.clear();
  clearAllNotifications();
  const counts: number[] = [];
  const off = subscribeNotifications((items) => counts.push(items.length));

  pushNotification({ kind: "system", title: "one" }, { now: 10 });
  pushNotification({ kind: "system", title: "two" }, { now: 20 });
  off();
  pushNotification({ kind: "system", title: "three" }, { now: 30 });

  assert.deepEqual(counts, [1, 2]);
});

test("emitPaneNotification records a pane target", () => {
  memory.clear();
  clearAllNotifications();

  const item = emitPaneNotification(
    {
      paneId: "browser-1",
      paneLabel: "browser",
      title: "screenshot saved",
      body: "saved page.png",
      level: "success",
    },
    { now: 40 },
  );

  assert.equal(item.kind, "pane");
  assert.equal(item.sourceLabel, "browser");
  assert.deepEqual(item.target, { type: "pane", key: "browser-1" });
  assert.equal(item.title, "screenshot saved");
  assert.equal(item.level, "success");
});

test("chat.needs_input dedupes per session — replaces rather than stacks", () => {
  memory.clear();
  clearAllNotifications();

  pushNotification(
    { kind: "chat.needs_input", title: "blocked", target: { type: "chat", sessionId: 7 } },
    { now: 10 },
  );
  pushNotification(
    { kind: "chat.needs_input", title: "still blocked", target: { type: "chat", sessionId: 7 } },
    { now: 20 },
  );
  // a different session is independent
  pushNotification(
    { kind: "chat.needs_input", title: "other", target: { type: "chat", sessionId: 8 } },
    { now: 30 },
  );

  const list = listNotifications().filter((n) => n.kind === "chat.needs_input");
  assert.equal(list.length, 2);
  const seven = list.find((n) => n.target?.type === "chat" && n.target.sessionId === 7);
  assert.equal(seven.title, "still blocked");
});
