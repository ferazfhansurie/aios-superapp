// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

class LocalStorageMock {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
}

test("sidebar item icon can be customized and persisted", async () => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new LocalStorageMock(),
    configurable: true,
  });

  const sidebar = await import("./sidebar.ts");
  const seeded = sidebar.seedDefault();
  sidebar.saveSidebar(seeded);

  const chat = seeded.items.find((item) => item.id === "app:chat");
  assert.ok(chat);

  sidebar.setItemIcon(chat.id, "bot");
  const updated = sidebar.loadSidebar().items.find((item) => item.id === "app:chat");
  assert.equal(updated?.iconName, "bot");
});
