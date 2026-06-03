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

  const first = pushNotification({ source: "chat", title: "chat finished" }, { now: 10 });
  const second = pushNotification({ source: "browser", title: "screenshot saved" }, { now: 20 });

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
  const item = pushNotification({ source: "system", title: "ready" }, { now: 10 });

  markNotificationRead(item.id);
  assert.equal(unreadNotificationCount(), 0);

  pushNotification({ source: "system", title: "next" }, { now: 20 });
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

  pushNotification({ source: "system", title: "one" }, { now: 10 });
  pushNotification({ source: "system", title: "two" }, { now: 20 });
  off();
  pushNotification({ source: "system", title: "three" }, { now: 30 });

  assert.deepEqual(counts, [1, 2]);
});

test("emitPaneNotification records pane source metadata", () => {
  memory.clear();
  clearAllNotifications();

  const item = emitPaneNotification({
    paneId: "browser-1",
    paneLabel: "browser",
    title: "screenshot saved",
    body: "saved page.png",
    level: "success",
  }, { now: 40 });

  assert.equal(item.source, "pane");
  assert.equal(item.sourceId, "browser-1");
  assert.equal(item.sourceLabel, "browser");
  assert.equal(item.title, "screenshot saved");
  assert.equal(item.level, "success");
});
