/**
 * Idle-dashboard data layer. The idle page (IdleDashboard) is a "data-alive"
 * cockpit-at-rest: the live data IS the decoration. Everything here reuses
 * already-wired Tauri commands — no new Rust — so it stays cheap + resilient.
 *
 *   - focus  ← ~/.aios/state/goals/active.json (current phase + active task)
 *   - rate   ← usage_stats   (live 5h / 7d rate-limit %)
 *   - streak ← usage_extras  (streak + 70-day heatmap + token total)
 *   - fleet  ← list_oracles  (awake oracle sessions)
 *   - threads← list_chat_sessions (recent chat-pane convos to resume)
 *
 * Every getter is defensive: a missing file / unparseable JSON / absent command
 * yields a graceful empty shape, never a throw that blanks the idle page.
 */
import { invoke } from "./tauri";

export interface IdleFocus {
  phaseTitle: string | null;
  phaseStatus: string | null;
  focusTitle: string | null;
  focusStatus: string | null;
}

/** First non-DONE active_now item + the active phase, parsed from goals JSON. */
export async function idleFocus(): Promise<IdleFocus> {
  const empty: IdleFocus = {
    phaseTitle: null,
    phaseStatus: null,
    focusTitle: null,
    focusStatus: null,
  };
  try {
    const home = await invoke<string>("home_dir");
    const path = `${home}/.aios/state/goals/active.json`;
    const res = await invoke<{ text: string | null }>("read_file_preview", { path });
    if (!res?.text) return empty;
    const g = JSON.parse(res.text) as {
      phases?: { phase?: number; title?: string; status?: string }[];
      active_now?: { title?: string; status?: string }[];
    };

    // Active phase: the one whose status begins with "ACTIVE", else the first.
    const phase =
      g.phases?.find((p) => /^active/i.test(p.status ?? "")) ?? g.phases?.[0] ?? null;

    // Current focus: first active_now item not already DONE.
    const focus =
      g.active_now?.find((a) => !/^done/i.test((a.status ?? "").trim())) ??
      g.active_now?.[0] ??
      null;

    return {
      phaseTitle: phase?.title ?? null,
      phaseStatus: phase?.status ?? null,
      focusTitle: focus?.title ?? null,
      focusStatus: focus?.status ?? null,
    };
  } catch {
    return empty;
  }
}

export interface MemoryFocus {
  /** Humanised note name, e.g. "aios superapp" (accent tag line). */
  tag: string | null;
  /** The note's one-line `description:` — the focus body. */
  title: string | null;
}

/**
 * The freshest curated memory note as the idle "focus" — firaz's actual current
 * focus per his pick, sourced from the most-recently-written `project_*.md` in
 * his global memory (NOT the static goals roadmap, which goes stale). Reads the
 * memory dir, takes the newest project note by mtime, and parses its frontmatter
 * `name` + `description`. Defensive: any miss yields an empty shape.
 */
export async function memoryFocus(): Promise<MemoryFocus> {
  const empty: MemoryFocus = { tag: null, title: null };
  try {
    // Backend resolves the vault portably (home-encoded path, then fallbacks) and
    // picks the freshest note — correct across macOS/Windows without path-encoding
    // logic living in the frontend.
    const res = await invoke<MemoryFocus>("memory_focus");
    return res ?? empty;
  } catch {
    return empty;
  }
}

export interface RateWindow {
  pct: number | null;
  resetsAt: number | null;
}
export interface CodexModelRate {
  fiveHour: RateWindow;
  sevenDay: RateWindow;
}
export interface IdleRate {
  fiveHour: RateWindow;
  sevenDay: RateWindow;
  contextPct: number | null;
}

/** Live 5h / 7d rate-limit windows + context-window fill, from the statusline. */
export async function idleRate(): Promise<IdleRate> {
  const empty: IdleRate = {
    fiveHour: { pct: null, resetsAt: null },
    sevenDay: { pct: null, resetsAt: null },
    contextPct: null,
  };
  try {
    const u = await invoke<{
      rate_limits?: {
        five_hour?: { used_percentage?: number | null; resets_at?: number | null };
        seven_day?: { used_percentage?: number | null; resets_at?: number | null };
      };
      context_window?: { used_percentage?: number | null };
    } | null>("usage_stats");
    if (!u) return empty;
    return {
      fiveHour: {
        pct: u.rate_limits?.five_hour?.used_percentage ?? null,
        resetsAt: u.rate_limits?.five_hour?.resets_at ?? null,
      },
      sevenDay: {
        pct: u.rate_limits?.seven_day?.used_percentage ?? null,
        resetsAt: u.rate_limits?.seven_day?.resets_at ?? null,
      },
      contextPct: u.context_window?.used_percentage ?? null,
    };
  } catch {
    return empty;
  }
}

/**
 * Live Codex (ChatGPT-sub) usage, parsed from `~/.codex/logs_2.sqlite` by the
 * `codex_usage` Rust command. Codex's `primary` window = 5h, `secondary` = 7d,
 * mirroring Claude — so the sidebar renders both with the same component.
 * Returns the empty shape when Codex hasn't logged a rate-limit event yet (the
 * `codex exec` path the chat pane uses logs null; the desktop app/TUI populate
 * it). `plan` is the ChatGPT plan tier (e.g. "plus") when known.
 */
export interface CodexRate {
  fiveHour: RateWindow;
  sevenDay: RateWindow;
  plan: string | null;
  models: Record<string, CodexModelRate>;
}
export async function codexRate(): Promise<CodexRate> {
  const empty: CodexRate = {
    fiveHour: { pct: null, resetsAt: null },
    sevenDay: { pct: null, resetsAt: null },
    plan: null,
    models: {},
  };
  try {
    const u = await invoke<{
      five_hour?: { pct?: number | null; resets_at?: number | null };
      seven_day?: { pct?: number | null; resets_at?: number | null };
      plan?: string | null;
      models?: Record<
        string,
        {
          five_hour?: { pct?: number | null; resets_at?: number | null };
          seven_day?: { pct?: number | null; resets_at?: number | null };
        }
      >;
    } | null>("codex_usage");
    if (!u) return empty;
    const models = u.models ?? {};
    const parsedModels: Record<string, CodexModelRate> = {};
    for (const [name, m] of Object.entries(models)) {
      if (!m || typeof m !== "object") continue;
      const mAny = m as {
        five_hour?: { pct?: number | null; resets_at?: number | null };
        seven_day?: { pct?: number | null; resets_at?: number | null };
      };
      parsedModels[name] = {
        fiveHour: {
          pct: mAny.five_hour?.pct ?? null,
          resetsAt: mAny.five_hour?.resets_at ?? null,
        },
        sevenDay: {
          pct: mAny.seven_day?.pct ?? null,
          resetsAt: mAny.seven_day?.resets_at ?? null,
        },
      };
    }
    return {
      fiveHour: {
        pct: u.five_hour?.pct ?? null,
        resetsAt: u.five_hour?.resets_at ?? null,
      },
      sevenDay: {
        pct: u.seven_day?.pct ?? null,
        resetsAt: u.seven_day?.resets_at ?? null,
      },
      plan: u.plan ?? null,
      models: parsedModels,
    };
  } catch {
    return empty;
  }
}

/**
 * Live Claude rate-limit usage, parsed from `~/.aios/state/usage.json` by the
 * `claude_usage` Rust command (the statusline-written file). 5h / 7d windows
 * mirror codexRate's shape so the sidebar renders both with the same component.
 * Returns the empty shape when usage.json is missing/unwritten so the block
 * hides gracefully.
 */
export interface ClaudeRate {
  fiveHour: RateWindow;
  sevenDay: RateWindow;
}
export async function claudeRate(): Promise<ClaudeRate> {
  const empty: ClaudeRate = {
    fiveHour: { pct: null, resetsAt: null },
    sevenDay: { pct: null, resetsAt: null },
  };
  try {
    const u = await invoke<{
      fiveHour?: { pct?: number | null; resetsAt?: number | null };
      sevenDay?: { pct?: number | null; resetsAt?: number | null };
    } | null>("claude_usage");
    if (!u) return empty;
    return {
      fiveHour: {
        pct: u.fiveHour?.pct ?? null,
        resetsAt: u.fiveHour?.resetsAt ?? null,
      },
      sevenDay: {
        pct: u.sevenDay?.pct ?? null,
        resetsAt: u.sevenDay?.resetsAt ?? null,
      },
    };
  } catch {
    return empty;
  }
}

/** "58m" / "6d 22h" / "now" from a unix-seconds reset timestamp. */
export function resetIn(ts: number | null): string {
  if (!ts) return "";
  const rem = ts - Math.floor(Date.now() / 1000);
  if (rem <= 0) return "now";
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
