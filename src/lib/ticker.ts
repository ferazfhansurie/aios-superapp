/** Shared, ref-counted tickers.
 *
 * The cockpit had ~12 independent `setInterval`s scattered across panes — six
 * 1Hz clocks (hero clock, fleet, layout re-syncs) and six 30s data pollers
 * (memory, analytics, usage, attached apps, money agents, loop status). Each ran
 * on its own staggered schedule, so the app woke the timer thread a dozen times
 * a period at unaligned moments, and hidden panes kept polling regardless.
 *
 * This module collapses each PERIOD onto ONE underlying interval, ref-counted
 * across every subscriber: the interval for a period only runs while ≥1 active
 * subscriber is mounted, and the last unsubscribe clears it. Subscribers sharing
 * a period also fire on the SAME tick (aligned), so e.g. all 30s reloads happen
 * in one wakeup instead of six.
 *
 * Pass `active=false` (e.g. a hidden pane) to opt out: the component doesn't
 * subscribe, takes no ticks, and — if it was the last subscriber — stops the
 * interval entirely. That's the "pause hidden-pane pollers" win, for free.
 */
import { useEffect, useRef, useState } from "react";

const subscribers = new Map<number, Set<() => void>>();
const intervals = new Map<number, ReturnType<typeof setInterval>>();
// Monotonic tick count per period — handed back from useSharedTicker so callers
// can use it as a freshness key / effect dependency.
const counters = new Map<number, number>();

function ensureInterval(period: number): void {
  if (intervals.has(period)) return;
  const id = setInterval(() => {
    counters.set(period, (counters.get(period) ?? 0) + 1);
    const subs = subscribers.get(period);
    if (!subs) return;
    // snapshot so a subscriber unsubscribing mid-tick can't mutate during iterate
    for (const cb of [...subs]) {
      try {
        cb();
      } catch {
        /* a broken subscriber must not kill the shared tick for everyone */
      }
    }
  }, period);
  intervals.set(period, id);
}

function subscribe(period: number, cb: () => void): () => void {
  let set = subscribers.get(period);
  if (!set) {
    set = new Set();
    subscribers.set(period, set);
  }
  set.add(cb);
  ensureInterval(period);
  return () => {
    const s = subscribers.get(period);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) {
      const id = intervals.get(period);
      if (id != null) clearInterval(id);
      intervals.delete(period);
      subscribers.delete(period);
    }
  };
}

/** Re-render the calling component every `period` ms while `active`. All callers
 *  sharing a period share ONE interval. Returns a monotonic tick count. Read
 *  live values (e.g. `new Date()`) in render — the return value just forces the
 *  re-render. When `active` is false the component takes no ticks. */
export function useSharedTicker(period: number, active = true): number {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    return subscribe(period, () => force((t) => (t + 1) % 1_000_000));
  }, [period, active]);
  return counters.get(period) ?? 0;
}

/** Run `fn` every `period` ms while `active`, on the shared interval for that
 *  period — without re-rendering on every tick (unlike useSharedTicker). Ideal
 *  for data pollers: pass the pane's visibility as `active` so a hidden pane
 *  stops reloading. `fn` is read through a ref, so its identity may change
 *  freely without re-arming the timer. */
export function useSharedInterval(period: number, fn: () => void, active = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    return subscribe(period, () => ref.current());
  }, [period, active]);
}
