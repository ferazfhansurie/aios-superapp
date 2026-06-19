// @ts-nocheck -- node test globals are not part of the app tsconfig.
import assert from "node:assert/strict";
import test from "node:test";

// A localStorage whose underlying setItem can be told to throw, so we can prove
// the guard swallows quota throws (no blank screen) but preserves unrelated ones.
const store = new Map<string, string>();
let throwMode = "none"; // "none" | "quota" | "other"

class FakeStorage {
  get length() {
    return store.size;
  }
  key(i) {
    return [...store.keys()][i] ?? null;
  }
  getItem(key) {
    return store.get(key) ?? null;
  }
  setItem(key, value) {
    if (throwMode === "quota") {
      throw new DOMException("quota", "QuotaExceededError");
    }
    if (throwMode === "other") {
      throw new DOMException("nope", "SyntaxError");
    }
    store.set(key, value);
  }
  removeItem(key) {
    store.delete(key);
  }
}

assert.equal(typeof DOMException, "function"); // node >=17

Object.defineProperty(globalThis, "Storage", {
  value: FakeStorage,
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: new FakeStorage(),
  configurable: true,
});

const { installStorageQuotaGuard } = await import("./safeStorage.ts");
installStorageQuotaGuard();
installStorageQuotaGuard(); // idempotent — must not double-wrap

test.beforeEach(() => {
  store.clear();
  throwMode = "none";
});

test("successful writes pass through untouched", () => {
  localStorage.setItem("a", "1");
  assert.equal(store.get("a"), "1");
});

test("a quota throw is swallowed, not propagated (no blank screen)", () => {
  throwMode = "quota";
  // Before the guard this throws QuotaExceededError uncaught → React unmounts.
  assert.doesNotThrow(() => {
    localStorage.setItem("aios.agents", JSON.stringify([{ id: "x" }]));
  });
});

test("non-quota errors are preserved (not silently eaten)", () => {
  throwMode = "other";
  assert.throws(() => localStorage.setItem("k", "v"), /SyntaxError|nope/);
});
