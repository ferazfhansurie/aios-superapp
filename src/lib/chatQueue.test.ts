import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_QUEUE_STORAGE_PREFIX,
  hydrateChatQueue,
  loadChatQueue,
  saveChatQueue,
  clearChatQueue,
  type DurableChatQueue,
} from "./chatQueue.ts";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class RemoveFailingStorage extends MemoryStorage {
  override removeItem(_key: string) {
    throw new Error("storage is blocked");
  }
}

test("durable queue round-trips ordered entries and clamps the selection", () => {
  const storage = new MemoryStorage();
  const queue: DurableChatQueue = {
    items: [
      { id: "q1", text: "first" },
      { id: "q2", text: "second", images: ["/tmp/capture.png"] },
    ],
    selected: 99,
  };

  saveChatQueue(storage, "pane-a", queue);
  assert.deepEqual(loadChatQueue(storage, "pane-a"), {
    items: queue.items,
    selected: 1,
  });
});

test("durable queue rejects malformed or oversized persisted data", () => {
  const storage = new MemoryStorage();
  storage.setItem(`${CHAT_QUEUE_STORAGE_PREFIX}pane-a`, "not json");
  assert.equal(loadChatQueue(storage, "pane-a"), null);

  storage.setItem(
    `${CHAT_QUEUE_STORAGE_PREFIX}pane-a`,
    JSON.stringify({ items: Array.from({ length: 51 }, (_, i) => ({ id: `q${i}`, text: "x" })), selected: 0 }),
  );
  assert.equal(loadChatQueue(storage, "pane-a"), null);
});

test("clearing a durable queue removes only that pane's pending work", () => {
  const storage = new MemoryStorage();
  saveChatQueue(storage, "pane-a", { items: [{ id: "q1", text: "a" }], selected: 0 });
  saveChatQueue(storage, "pane-b", { items: [{ id: "q2", text: "b" }], selected: 0 });

  clearChatQueue(storage, "pane-a");
  assert.equal(loadChatQueue(storage, "pane-a"), null);
  assert.deepEqual(loadChatQueue(storage, "pane-b"), {
    items: [{ id: "q2", text: "b" }],
    selected: 0,
  });
});

test("saving an empty queue stays safe when storage blocks removal", () => {
  const storage = new RemoveFailingStorage();

  assert.doesNotThrow(() => saveChatQueue(storage, "pane-a", { items: [], selected: 0 }));
});

test("hydration drops queued messages with non-durable paste images and keeps durable images", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    `${CHAT_QUEUE_STORAGE_PREFIX}pane-a`,
    JSON.stringify({
      items: [
        { id: "durable", text: "keep this", images: ["/Users/firaz/Desktop/shot.png"] },
        { id: "temp", text: "do not send this without its image", images: ["/tmp/aios-paste/paste-a.png"] },
        { id: "mixed", text: "do not partially send this", images: ["/Users/firaz/Desktop/shot.png", "/private/var/folders/x/aios-paste/paste-b.png"] },
      ],
      selected: 2,
    }),
  );

  assert.deepEqual(hydrateChatQueue(storage, "pane-a"), {
    queue: {
      items: [{ id: "durable", text: "keep this", images: ["/Users/firaz/Desktop/shot.png"] }],
      selected: 0,
    },
    droppedMessages: 2,
    droppedImages: 2,
  });
});
