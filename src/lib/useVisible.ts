/**
 * useVisible — "is this pane actually on screen right now?"
 *
 * WHY THIS EXISTS (idle-CPU fix): the cockpit keeps hidden panes MOUNTED via
 * `display:none` (see App.tsx — native webviews paint above html, so panes can't
 * unmount or their terminal/webview state is lost). The side effect is that every
 * `setInterval` in a hidden pane keeps firing forever, spawning processes + doing
 * IPC + re-rendering even though the user can't see the pane. This hook gates
 * those timers to only run when the pane is genuinely visible.
 *
 * Two signals, ANDed:
 *   1. IntersectionObserver on the pane's own root element. A `display:none`
 *      ancestor gives the element a zero-area box, so the observer reports
 *      `isIntersecting:false` with no polling — purely event-driven. This also
 *      catches scrolled-off / zero-size cases.
 *   2. document.visibilityState — the whole app window being minimized /
 *      backgrounded / occluded. No point polling when nobody's looking at AIOS
 *      at all.
 *
 * Returns `true` only when the element is intersecting AND the document is
 * visible. Attach the returned ref to the component's outermost element.
 *
 * Usage:
 *   const { ref, visible } = useVisible<HTMLDivElement>();
 *   useEffect(() => {
 *     if (!visible) return;        // don't start the timer while hidden
 *     const t = setInterval(poll, 30_000);
 *     return () => clearInterval(t);
 *   }, [visible]);
 *   return <div ref={ref}>…</div>;
 */
import { useEffect, useRef, useState } from "react";

export interface UseVisibleResult<T extends HTMLElement> {
  /** Attach to the component's outermost element. */
  ref: React.RefObject<T | null>;
  /** true ⇔ element is on screen AND the app window is visible. */
  visible: boolean;
}

const docVisible = (): boolean =>
  typeof document === "undefined" ? true : document.visibilityState !== "hidden";

export function useVisible<T extends HTMLElement = HTMLDivElement>(): UseVisibleResult<T> {
  const ref = useRef<T>(null);
  // Start visible:true so the first load fires immediately on mount (the
  // observer + visibility listener correct it within a frame). Starting false
  // would briefly stall the initial fetch behind an observer callback.
  const [intersecting, setIntersecting] = useState(true);
  const [windowVisible, setWindowVisible] = useState(docVisible);

  // IntersectionObserver — fires on display:none toggles + scroll + resize.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        if (e) setIntersecting(e.isIntersecting && e.intersectionRatio > 0);
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Whole-window visibility (minimize / occlude / tab-away in web mode).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => setWindowVisible(docVisible());
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  return { ref, visible: intersecting && windowVisible };
}
