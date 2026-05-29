// AIOS cockpit theme state.
// Theming is driven entirely by CSS custom props in App.css. Setting
// document.documentElement.dataset.theme to "light" | "dark" swaps the
// var(--color-*) tokens app-wide. "system" resolves via prefers-color-scheme.

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "aios.theme";

const listeners = new Set<(t: Theme) => void>();
let systemMql: MediaQueryList | null = null;

/** Read the stored theme preference. Defaults to "system". */
export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage unavailable (private mode / SSR) — fall through to default.
  }
  return "system";
}

/** Resolve "system" to the concrete OS preference. */
function resolveSystem(): "light" | "dark" {
  if (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

/** Resolve a Theme to the concrete "light" | "dark" actually applied. */
export function resolveTheme(t: Theme = getTheme()): "light" | "dark" {
  return t === "system" ? resolveSystem() : t;
}

/** Apply the given (or stored) theme to <html data-theme>. */
export function applyTheme(t: Theme = getTheme()): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolveTheme(t);
}

/** Persist + apply a theme, then notify subscribers. */
export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    // ignore persistence failures — still apply for this session.
  }
  applyTheme(t);
  for (const fn of listeners) fn(t);
}

/** Subscribe to theme changes (incl. system-driven). Returns an unsubscribe fn. */
export function subscribe(fn: (t: Theme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Apply on load + keep "system" mode reactive to OS changes.
 * Call once on app startup. Returns a teardown fn.
 */
export function initTheme(): () => void {
  applyTheme();

  if (typeof window !== "undefined" && window.matchMedia) {
    systemMql = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      // Only react to OS changes while in "system" mode.
      if (getTheme() === "system") {
        applyTheme("system");
        for (const fn of listeners) fn("system");
      }
    };
    systemMql.addEventListener("change", onSystemChange);
    return () => systemMql?.removeEventListener("change", onSystemChange);
  }

  return () => {};
}
