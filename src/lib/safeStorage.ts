/** Global localStorage quota guard — the definitive fix for the blank-screen
 *  class documented in `runEvents.ts` (2026-06-19 incident).
 *
 *  Background: per-session run-event logs (and other UI state) accumulate until
 *  the ~5MB origin quota fills. At that point the NEXT `localStorage.setItem`
 *  ANYWHERE in the app throws an uncaught QuotaExceededError → React unmounts →
 *  blank window. `pruneRunEventStores()` runs once at boot and buys headroom, but
 *  it does NOT close the class: any RUNTIME write that tips the quota over (a
 *  section-collapse toggle, saving an agent) still throws uncaught mid-session,
 *  after boot, where prune never runs.
 *
 *  This installs a single guard over `Storage.prototype.setItem` so a quota throw
 *  triggers a prune + one retry; if it still fails, the write is swallowed (a
 *  dropped UI-state write beats a blanked daily driver). Defensive-only: behavior
 *  changes ONLY on the throw path — successful writes are untouched. Covers every
 *  current AND future callsite with one change, so no callsite migration is
 *  needed. Idempotent; safe to call once at boot. Never throws. */
import { pruneRunEventStores } from "./runEvents.ts";

const GUARD_FLAG = "__aiosQuotaGuardInstalled";

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false;
  // WebKit/Firefox use distinct names + a legacy numeric code (22, deprecated).
  const legacyCode = (err as { code?: number }).code;
  return (
    err.name === "QuotaExceededError" ||
    err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    legacyCode === 22
  );
}

export function installStorageQuotaGuard(): void {
  try {
    if (typeof localStorage === "undefined" || typeof Storage === "undefined") {
      return;
    }
    const proto = Storage.prototype as Storage & Record<string, unknown>;
    if (proto[GUARD_FLAG]) return; // already installed
    const original = proto.setItem;

    proto.setItem = function (this: Storage, key: string, value: string): void {
      try {
        original.call(this, key, value);
      } catch (err) {
        if (!isQuotaError(err)) throw err; // not a quota problem — preserve it
        // Quota full: reclaim space from the unbounded run-event logs, retry once.
        try {
          pruneRunEventStores();
          original.call(this, key, value);
          return;
        } catch {
          // Still failing after a prune — swallow. A dropped write is strictly
          // better than crashing the whole app into a blank window.
          // eslint-disable-next-line no-console
          console.warn("[safeStorage] localStorage quota full, dropped:", key);
        }
      }
    };

    Object.defineProperty(proto, GUARD_FLAG, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch (err) {
    // Installing the guard must never break boot.
    // eslint-disable-next-line no-console
    console.warn("[safeStorage] guard install failed (non-fatal):", err);
  }
}
