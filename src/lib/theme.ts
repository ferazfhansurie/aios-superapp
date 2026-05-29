// AIOS cockpit theme state.
// Theming is driven entirely by CSS custom props in App.css. Setting
// document.documentElement.dataset.theme to "light" | "dark" swaps the
// var(--color-*) tokens app-wide. "system" resolves via prefers-color-scheme.
//
// Accent is layered on top: applyAccent() overrides the App.css --color-accent
// family at runtime on document.documentElement.style, so the whole app
// re-tints instantly without a rebuild. Accent is orthogonal to light/dark —
// both layers compose.

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

/* ── accent ──────────────────────────────────────────────────────────────
 * A small palette of brand accents. orange is the AIOS default (mirrors the
 * App.css --color-accent: #f26522). Each preset carries the full accent
 * family so applyAccent() can override every accent-derived token at runtime.
 */

export type Accent =
  | "orange"
  | "blue"
  | "green"
  | "violet"
  | "rose"
  | "amber";

interface AccentDef {
  /** the dot shown in the swatch picker */
  swatch: string;
  /** primary accent — buttons, active states, focus rings */
  accent: string;
  /** hover/pressed accent */
  accentHover: string;
  /** desaturated/dim accent — disabled + low-emphasis tints */
  accentDim: string;
  /** low-alpha accent wash — nav-rail active bg, soft pills */
  accentSoft: string;
  /** terminal caret / cursor block */
  cursor: string;
  /** terminal + UI text selection wash (low alpha) */
  selection: string;
}

/** orange first — it's the shipped default. order = swatch row order. */
export const ACCENTS: Record<Accent, AccentDef> = {
  orange: {
    swatch: "#f26522",
    accent: "#f26522",
    accentHover: "#ff7a3d",
    accentDim: "#a9461a",
    accentSoft: "rgba(242, 101, 34, 0.14)",
    cursor: "#f26522",
    selection: "rgba(242, 101, 34, 0.28)",
  },
  blue: {
    swatch: "#339cff",
    accent: "#339cff",
    accentHover: "#5cb1ff",
    accentDim: "#2169ad",
    accentSoft: "rgba(51, 156, 255, 0.15)",
    cursor: "#339cff",
    selection: "rgba(51, 156, 255, 0.28)",
  },
  green: {
    swatch: "#40c977",
    accent: "#34b86a",
    accentHover: "#46d480",
    accentDim: "#1f7a47",
    accentSoft: "rgba(64, 201, 119, 0.15)",
    cursor: "#40c977",
    selection: "rgba(64, 201, 119, 0.26)",
  },
  violet: {
    swatch: "#924ff7",
    accent: "#924ff7",
    accentHover: "#a96eff",
    accentDim: "#6534ad",
    accentSoft: "rgba(146, 79, 247, 0.16)",
    cursor: "#a96eff",
    selection: "rgba(146, 79, 247, 0.30)",
  },
  rose: {
    swatch: "#fb5b86",
    accent: "#fb5b86",
    accentHover: "#ff789c",
    accentDim: "#b03b5d",
    accentSoft: "rgba(251, 91, 134, 0.15)",
    cursor: "#fb5b86",
    selection: "rgba(251, 91, 134, 0.28)",
  },
  amber: {
    swatch: "#f5b21f",
    accent: "#eaa517",
    accentHover: "#f7bd37",
    accentDim: "#a87811",
    accentSoft: "rgba(245, 178, 31, 0.16)",
    cursor: "#f5b21f",
    selection: "rgba(245, 178, 31, 0.28)",
  },
};

/** ordered list for rendering the swatch row (orange = default, first). */
export const ACCENT_ORDER: Accent[] = [
  "orange",
  "blue",
  "green",
  "violet",
  "rose",
  "amber",
];

const ACCENT_KEY = "aios.accent";

const accentListeners = new Set<(a: Accent) => void>();

/** Read the stored accent. Defaults to "orange" (the App.css default). */
export function getAccent(): Accent {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    if (v && v in ACCENTS) return v as Accent;
  } catch {
    // ignore — fall through to default.
  }
  return "orange";
}

/**
 * Push the accent family onto :root inline styles, overriding the App.css
 * defaults at runtime. Additive — touches only --color-accent* + cursor /
 * selection, never the theme (light/dark) tokens.
 */
export function applyAccent(a: Accent = getAccent()): void {
  if (typeof document === "undefined") return;
  const def = ACCENTS[a] ?? ACCENTS.orange;
  const root = document.documentElement.style;
  root.setProperty("--color-accent", def.accent);
  root.setProperty("--color-accent-hover", def.accentHover);
  root.setProperty("--color-accent-dim", def.accentDim);
  root.setProperty("--color-accent-soft", def.accentSoft);
  root.setProperty("--color-cursor", def.cursor);
  root.setProperty("--color-selection", def.selection);
  document.documentElement.dataset.accent = a;
}

/** Persist + apply an accent, then notify accent subscribers. */
export function setAccent(a: Accent): void {
  try {
    localStorage.setItem(ACCENT_KEY, a);
  } catch {
    // ignore persistence failures — still apply for this session.
  }
  applyAccent(a);
  for (const fn of accentListeners) fn(a);
}

/** Subscribe to accent changes. Returns an unsubscribe fn. */
export function subscribeAccent(fn: (a: Accent) => void): () => void {
  accentListeners.add(fn);
  return () => accentListeners.delete(fn);
}

/**
 * Apply on load + keep "system" mode reactive to OS changes.
 * Call once on app startup. Returns a teardown fn.
 */
export function initTheme(): () => void {
  applyTheme();
  applyAccent();

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
