/** Typed, localStorage-backed settings store for the AIOS cockpit.
 *  Framework-light: plain load/save/get helpers + a tiny subscribe/notify
 *  emitter so panes can react to changes without pulling in a state lib.
 *  Persisted as JSON under a single key. */

const STORAGE_KEY = "aios.settings";

export type PaneType = "terminal" | "files" | "browser";
export type SidebarMode = "full" | "icons";
export type TopBarMode = "full" | "compact" | "hidden";
export type NotificationNativeMode = "off" | "important" | "all";

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

  // sidebar
  sidebarMode: SidebarMode;
  topBarMode: TopBarMode;

  // notifications
  notificationNativeMode: NotificationNativeMode;
  notificationQuietMode: boolean;

  // oracles
  defaultSocketName: string;
  autoRefreshSeconds: number;
  showNonAiosSessions: boolean;

  // memory
  graphPhysicsStrength: number; // 0..100

  // chat provider (model-agnostic) — provider ids live in lib/providers.ts.
  // Default "codex-cli" keeps new chats aligned with the WA oracle. chatModel is the last
  // picked model id (null = provider default).
  chatProvider: string;
  chatModel: string | null;
  /** Last valid effort per model id. */
  chatEffortByModel: Record<string, string>;
  /** One-way defaults migration for newly opened blank chat panes. */
  chatDefaultsVersion: number;

  // aios router — the virtual "aios" picker entry resolves through this role
  // architecture (lib/aiosRouter.ts):
  //   main — GPT model used through Claude Code below 100%, native at the cap
  //   deep — retained as an explicit/manual Claude role
  //   bulk — explicit heavy-work directive (kept for manual routing)
  // paceMargin is retained for settings compatibility but no longer drives
  // automatic routing. last is only a synchronous pane-boot hint.
  aiosRouterRoles: { main: string; deep: string; bulk: string };
  aiosRouterPaceMargin: number;
  aiosRouterLast: string | null;
  aiosRouterLastHarness: "claude" | "native";

  // route claude chat turns through the local Headroom compression proxy
  // (ANTHROPIC_BASE_URL → http://127.0.0.1:8787). Compresses tool outputs / RAG
  // before they hit the LLM (60-95% fewer tokens); never touches your prompt.
  // Requires the headroom proxy running (com.firaz.headroom-proxy launchd).
  headroomCompression: boolean;

  // where "send to AI" actions route (notes pane "send", future quick-sends):
  //   "codex-code"  → a terminal pane running `codex`
  //   "claude-code" → a terminal pane running `claude`
  //   "terminal"    → a plain shell pane (paste + run)
  //   "chat"        → the in-app chat pane (uses chatProvider/chatModel)
  defaultAi: DefaultAi;
}

/** Routing target for "send to AI" actions. */
export type DefaultAi = "codex-code" | "claude-code" | "terminal" | "chat";

/** Composer flash intensity. */
export type FlashLevel = "calm" | "lush" | "max";

/** Reflect the flash level as `data-flash` on <html> so App.css can gate the
 *  ambient composer effects. Mirrors how theme/accent drive `data-theme`. */
export function applyFlashLevel(level: FlashLevel = loadSettings().flashLevel): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.flash = level;
}

export const DEFAULT_SETTINGS: AppSettings = {
  userName: "",
  reopenLastLayout: true,
  confirmCloseOraclePane: true,
  defaultPaneType: "terminal",

  accentIntensity: 70,
  terminalFontSize: 13,
  splashOnLaunch: true,
  reduceMotion: false,
  flashLevel: "lush",
  sidebarMode: "full",
  topBarMode: "hidden",
  notificationNativeMode: "important",
  notificationQuietMode: false,

  defaultSocketName: "adletic",
  autoRefreshSeconds: 15,
  showNonAiosSessions: false,

  graphPhysicsStrength: 50,

  chatProvider: "codex-cli",
  chatModel: "aios",
  chatEffortByModel: { "gpt-5.6-terra": "low" },
  chatDefaultsVersion: 2,

  aiosRouterRoles: {
    main: "gpt-5.6-sol",
    deep: "claude-fable-5",
    bulk: "claude-opus-4-8",
  },
  aiosRouterPaceMargin: 15,
  aiosRouterLast: null,
  aiosRouterLastHarness: "claude",

  headroomCompression: false,

  defaultAi: "codex-code",
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
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      if (
        parsed.chatProvider === "claude-cli" &&
        parsed.chatModel == null &&
        parsed.defaultAi === "claude-code"
      ) {
        parsed.chatProvider = "codex-cli";
        parsed.defaultAi = "codex-code";
      }
      // Old installs defaulted to a branded visible titlebar. The shell now
      // treats hidden chrome as the product default; existing localStorage should
      // not keep users stuck on loud topbar modes after reinstall.
      if (parsed.topBarMode === "full" || parsed.topBarMode === "compact") {
        parsed.topBarMode = "hidden";
      }
      // Firaz's requested fresh-chat baseline: Terra is the daily driver and
      // low effort is the fast default. This migrates existing installs once;
      // a later explicit picker choice still remains the user's preference.
      if ((parsed.chatDefaultsVersion ?? 0) < 1) {
        parsed.chatModel = "gpt-5.6-terra";
        parsed.chatProvider = "codex-cli";
        parsed.chatEffortByModel = {
          ...(parsed.chatEffortByModel ?? {}),
          "gpt-5.6-terra": "low",
        };
        parsed.chatDefaultsVersion = 1;
      }
      // v2: aios (the usage-pace router) becomes the fresh-chat default. A
      // later explicit picker choice still overrides, like any default.
      if ((parsed.chatDefaultsVersion ?? 0) < 2) {
        parsed.chatModel = "aios";
        parsed.chatDefaultsVersion = 2;
      }
      cache = { ...DEFAULT_SETTINGS, ...parsed };
    } else {
      cache = { ...DEFAULT_SETTINGS };
    }
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
