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
 * A small palette of brand-preset accents PLUS arbitrary custom hex colors.
 * orange is the AIOS default (mirrors the App.css --color-accent: #f26522).
 *
 * The whole accent family (accent / hover / dim / soft / cursor / selection /
 * fg) is DERIVED programmatically from a single base hex — see
 * deriveAccentVars(). Presets and custom colors go through the exact same
 * derivation, so a preset and a hand-picked hex of the same value look
 * identical. Presets only carry their base hex; everything else is computed.
 */

export type AccentPreset =
  | "orange"
  | "blue"
  | "green"
  | "violet"
  | "rose"
  | "amber";

/**
 * A stored accent is either a known preset id OR an arbitrary "#rrggbb" hex.
 * (backward-compat: old installs stored a preset id string — still valid.)
 */
export type Accent = AccentPreset | string;

/** preset id → base hex. order = swatch row order (orange = default, first). */
export const ACCENT_PRESETS: Record<AccentPreset, string> = {
  orange: "#f26522",
  blue: "#339cff",
  green: "#40c977",
  violet: "#924ff7",
  rose: "#fb5b86",
  amber: "#f5b21f",
};

/** ordered list for rendering the preset swatch row. */
export const ACCENT_ORDER: AccentPreset[] = [
  "orange",
  "blue",
  "green",
  "violet",
  "rose",
  "amber",
];

/* ── color math ───────────────────────────────────────────────────────── */

interface RGB {
  r: number;
  g: number;
  b: number;
}

/** "#rgb" / "#rrggbb" → {r,g,b} (0..255). Returns null on garbage. */
export function parseHex(input: string): RGB | null {
  let h = input.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** normalize any accepted hex-ish input to canonical "#rrggbb" (lowercase). */
export function normalizeHex(input: string): string | null {
  const rgb = parseHex(input);
  if (!rgb) return null;
  return rgbToHex(rgb);
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHex({ r, g, b }: RGB): string {
  const h = (n: number) => clamp255(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** relative luminance (WCAG) — 0 (black) .. 1 (white). */
function luminance({ r, g, b }: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** mix toward white (amt>0) or black (amt<0), amt in -1..1. */
function shade(rgb: RGB, amt: number): RGB {
  const target = amt >= 0 ? 255 : 0;
  const t = Math.abs(amt);
  return {
    r: rgb.r + (target - rgb.r) * t,
    g: rgb.g + (target - rgb.g) * t,
    b: rgb.b + (target - rgb.b) * t,
  };
}

/** the full set of accent-derived CSS custom props for a base hex. */
export interface AccentVars {
  accent: string;
  accentHover: string;
  accentDim: string;
  accentSoft: string;
  cursor: string;
  selection: string;
  /** readable text/icon color on top of an accent fill (#000 or #fff). */
  accentFg: string;
}

/**
 * Derive the whole accent ramp from a single base hex. This is the ONE place
 * shades + contrast are computed — presets and custom colors both flow here.
 *
 *  - accent      : the base hex itself
 *  - accentHover : nudged toward white for light bases, kept bright otherwise
 *  - accentDim   : darkened (low-emphasis / disabled)
 *  - accentSoft  : the base at low alpha (washes / active pills)
 *  - selection   : the base at mid alpha (text selection)
 *  - cursor      : the base (terminal caret)
 *  - accentFg    : black or white, whichever reads on the accent (luminance)
 */
export function deriveAccentVars(baseHex: string): AccentVars {
  const rgb = parseHex(baseHex) ?? parseHex(ACCENT_PRESETS.orange)!;
  const base = rgbToHex(rgb);
  const lum = luminance(rgb);

  // hover: light colors look better slightly darkened; dark colors lifted.
  const hover = rgbToHex(shade(rgb, lum > 0.5 ? -0.12 : 0.18));
  // dim: always a darker, lower-emphasis variant.
  const dim = rgbToHex(shade(rgb, -0.4));

  const softAlpha = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
  const selAlpha = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.28)`;

  // contrast: WCAG luminance threshold ~0.45 picks black on bright accents
  // (amber/yellow/lime) and white on the rest.
  const fg = lum > 0.45 ? "#000000" : "#ffffff";

  return {
    accent: base,
    accentHover: hover,
    accentDim: dim,
    accentSoft: softAlpha,
    cursor: base,
    selection: selAlpha,
    accentFg: fg,
  };
}

/** Resolve a stored accent (preset id OR hex) to its base "#rrggbb". */
export function accentToHex(a: Accent): string {
  if (a in ACCENT_PRESETS) return ACCENT_PRESETS[a as AccentPreset];
  return normalizeHex(a) ?? ACCENT_PRESETS.orange;
}

/** True when the stored accent is a custom hex (not one of the presets). */
export function isCustomAccent(a: Accent): boolean {
  return !(a in ACCENT_PRESETS);
}

const ACCENT_KEY = "aios.accent";
const ACCENT_RECENTS_KEY = "aios.accent.recents";
const MAX_RECENTS = 4;

const accentListeners = new Set<(a: Accent) => void>();

/** Read the stored accent. Defaults to "orange" (the App.css default). */
export function getAccent(): Accent {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    if (v) {
      if (v in ACCENT_PRESETS) return v as AccentPreset;
      const hex = normalizeHex(v);
      if (hex) return hex;
    }
  } catch {
    // ignore — fall through to default.
  }
  return "orange";
}

/** Read recently-used custom hexes (most-recent first). */
export function getAccentRecents(): string[] {
  try {
    const raw = localStorage.getItem(ACCENT_RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => (typeof x === "string" ? normalizeHex(x) : null))
      .filter((x): x is string => !!x)
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/** Remember a custom hex in the recents list (dedup, cap, most-recent first). */
function pushRecent(hex: string): void {
  const norm = normalizeHex(hex);
  if (!norm) return;
  // skip if it's actually one of the presets — those have their own swatches.
  if (Object.values(ACCENT_PRESETS).some((p) => p === norm)) return;
  const next = [norm, ...getAccentRecents().filter((h) => h !== norm)].slice(
    0,
    MAX_RECENTS,
  );
  try {
    localStorage.setItem(ACCENT_RECENTS_KEY, JSON.stringify(next));
  } catch {
    // ignore persistence failure.
  }
}

/**
 * Push the accent family onto :root inline styles, overriding the App.css
 * defaults at runtime. Additive — touches only --color-accent* + cursor /
 * selection / accent-fg, never the theme (light/dark) tokens. Accepts a
 * preset id OR an arbitrary "#rrggbb" hex (both derive through the same ramp).
 */
export function applyAccent(a: Accent = getAccent()): void {
  if (typeof document === "undefined") return;
  const vars = deriveAccentVars(accentToHex(a));
  const root = document.documentElement.style;
  root.setProperty("--color-accent", vars.accent);
  root.setProperty("--color-accent-hover", vars.accentHover);
  root.setProperty("--color-accent-dim", vars.accentDim);
  root.setProperty("--color-accent-soft", vars.accentSoft);
  root.setProperty("--color-cursor", vars.cursor);
  root.setProperty("--color-selection", vars.selection);
  root.setProperty("--color-accent-fg", vars.accentFg);
  document.documentElement.dataset.accent = isCustomAccent(a) ? "custom" : a;
}

/** Persist + apply an accent (preset id or hex), then notify subscribers. */
export function setAccent(a: Accent): void {
  // normalize a hex input before persisting; remember customs as recents.
  let stored: Accent = a;
  if (!(a in ACCENT_PRESETS)) {
    const hex = normalizeHex(a);
    if (!hex) return; // garbage input — ignore.
    stored = hex;
    pushRecent(hex);
  }
  try {
    localStorage.setItem(ACCENT_KEY, stored);
  } catch {
    // ignore persistence failures — still apply for this session.
  }
  applyAccent(stored);
  for (const fn of accentListeners) fn(stored);
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
