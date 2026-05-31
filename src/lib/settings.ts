/** Typed, localStorage-backed settings store for the AIOS cockpit.
 *  Framework-light: plain load/save/get helpers + a tiny subscribe/notify
 *  emitter so panes can react to changes without pulling in a state lib.
 *  Persisted as JSON under a single key. */

const STORAGE_KEY = "aios.settings";

export type PaneType = "terminal" | "files" | "browser";

export interface AppSettings {
  // general
  userName: string;
  reopenLastLayout: boolean;
  confirmCloseOraclePane: boolean;
  defaultPaneType: PaneType;

  // appearance
  accentIntensity: number; // 0..100
  terminalFontSize: number; // 10..18
  splashOnLaunch: boolean;
  reduceMotion: boolean;
  // composer "flash" level — how much ambient motion/wow the prompt box has.
  //   "calm" → minimal (current baseline, respects reduce-motion)
  //   "lush" → + rotating conic-gradient rim + idle breathing glow
  //   "max"  → + aurora mesh-gradient behind the box
  // Drives `data-flash` on <html>; gated entirely in App.css (zero JS cost).
  flashLevel: FlashLevel;

  // oracles
  defaultSocketName: string;
  autoRefreshSeconds: number;
  showNonAiosSessions: boolean;

  // memory
  graphPhysicsStrength: number; // 0..100

  // chat provider (model-agnostic) — provider ids live in lib/providers.ts.
  // Default "claude-cli" preserves existing behavior. chatModel is the last
  // picked model id (null = provider default).
  chatProvider: string;
  chatModel: string | null;

  // where "send to AI" actions route (notes pane "send", future quick-sends):
  //   "claude-code" → a terminal pane running `claude` (firaz's default)
  //   "terminal"    → a plain shell pane (paste + run)
  //   "chat"        → the in-app chat pane (uses chatProvider/chatModel)
  defaultAi: DefaultAi;
}

/** Routing target for "send to AI" actions. */
export type DefaultAi = "claude-code" | "terminal" | "chat";

/** Composer flash intensity. */
export type FlashLevel = "calm" | "lush" | "max";

/** Reflect the flash level as `data-flash` on <html> so App.css can gate the
 *  ambient composer effects. Mirrors how theme/accent drive `data-theme`. */
export function applyFlashLevel(level: FlashLevel = loadSettings().flashLevel): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.flash = level;
}

export const DEFAULT_SETTINGS: AppSettings = {
  userName: "faeez",
  reopenLastLayout: true,
  confirmCloseOraclePane: true,
  defaultPaneType: "terminal",

  accentIntensity: 70,
  terminalFontSize: 13,
  splashOnLaunch: true,
  reduceMotion: false,
  flashLevel: "lush",

  defaultSocketName: "adletic",
  autoRefreshSeconds: 15,
  showNonAiosSessions: false,

  graphPhysicsStrength: 50,

  chatProvider: "claude-cli",
  chatModel: null,

  defaultAi: "claude-code",
};

/** Read-only display value — the vault is auto-resolved from your home dir. */
export const MEMORY_VAULT_PATH =
  "~/.claude/projects/<your-home>/memory (auto-resolved)";

type Listener = (s: AppSettings) => void;
const listeners = new Set<Listener>();

let cache: AppSettings | null = null;

/** Load the full settings object, merged over defaults (forward-compatible). */
export function loadSettings(): AppSettings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw
      ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) }
      : { ...DEFAULT_SETTINGS };
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

/** Merge a partial update, persist, and notify subscribers. */
export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...partial };
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / unavailable — keep in-memory cache */
  }
  listeners.forEach((fn) => fn(next));
  return next;
}

/** Read a single setting by key. */
export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return loadSettings()[key];
}

/** Subscribe to changes; returns an unsubscribe fn. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
