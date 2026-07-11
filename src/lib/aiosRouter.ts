/** aios — the virtual router model at the top of the chat picker.
 *
 *  Not a real backend: picking "aios" resolves to a concrete `ChatModel` here,
 *  and the pane keeps that concrete model in state (so ALL existing engine
 *  plumbing — spawn, usage strip, effort mapping — is untouched). The route
 *  logic encodes firaz's model architecture + economics:
 *
 *  - MAIN (gpt-5.6 sol) is smarter AND cheaper → wins by default, always.
 *  - DEEP (fable 5) is judgment: architecture calls, hard debugging, final
 *    passes. Never auto-routed — summoned ("use deep" / "use fable").
 *  - BULK (opus 4.8) is heavy lifting AND the burn tier: the claude max sub
 *    is prepaid, so when main's 7d budget runs ahead of pace, bulk absorbs
 *    load — draining the sub through opus, which burns far less quota than
 *    fable for the same work. (codex's 5h window is soft; 7d is the scarce
 *    resource.)
 *  - hard failover both directions when either side is capped.
 *
 *  Roles live in settings (`aiosRouterRoles` / `aiosRouterPaceMargin`) so new
 *  models are a settings change, not a code change. Every decision carries a
 *  human-readable `reason` — surfaced in the pane so routing is never a black
 *  box.
 */

import { CHAT_MODELS, type ChatModel } from "./chat";
import { claudeRate, codexRate } from "./dashboard";
import { loadSettings, saveSettings } from "./settings";

export const AIOS_MODEL_ID = "aios";

export interface AiosDecision {
  model: ChatModel;
  reason: string;
}

/** A picker entry the router may resolve to: concrete, local, enabled. */
function concrete(id: string | null | undefined): ChatModel | null {
  if (!id || id === AIOS_MODEL_ID) return null;
  return (
    CHAT_MODELS.find((m) => m.id === id && !m.disabled && !m.node) ?? null
  );
}

export interface AiosRoles {
  main: ChatModel;
  deep: ChatModel;
  bulk: ChatModel;
}

/** The role architecture, resolved to concrete models with safe fallbacks
 *  (never the virtual entry, never a node-backed or disabled one). */
export function aiosRoles(): AiosRoles {
  const r = loadSettings().aiosRouterRoles;
  const anyCodex = CHAT_MODELS.find((m) => m.engine === "codex" && !m.disabled && !m.node);
  const anyClaude = CHAT_MODELS.find(
    (m) => m.id !== AIOS_MODEL_ID && (m.engine ?? "claude") === "claude" && !m.disabled && !m.node,
  );
  const main = concrete(r?.main) ?? concrete("gpt-5.6-sol") ?? anyCodex ?? anyClaude!;
  return {
    main,
    deep: concrete(r?.deep) ?? concrete("claude-fable-5") ?? anyClaude ?? main,
    bulk: concrete(r?.bulk) ?? concrete("claude-opus-4-8") ?? anyClaude ?? main,
  };
}

const WINDOW_7D_MS = 7 * 24 * 3600 * 1000;

/** % of the 7d window already elapsed, from its reset timestamp (s or ms).
 *  Exported for the router panel (TaskSummary) so pace math stays in one place. */
export function windowElapsedPct(resetsAt: number | null): number | null {
  if (!resetsAt) return null;
  const at = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const remaining = at - Date.now();
  if (remaining <= 0 || remaining > WINDOW_7D_MS) return null;
  return Math.round((1 - remaining / WINDOW_7D_MS) * 100);
}

/** Sync seed for pane boot (useState initializers can't await): the last
 *  resolved model, else main. `resolveAios()` corrects it before the first
 *  send if the meters disagree. */
export function resolveAiosSync(): AiosDecision {
  const cached = concrete(loadSettings().aiosRouterLast);
  if (cached) return { model: cached, reason: "last route (meters refreshing)" };
  const { main } = aiosRoles();
  return { model: main, reason: `main · ${main.label}` };
}

/** The real route decision: reads both meters, applies pace + failover.
 *  deep is deliberately absent here — it's summon-only, never auto. */
export async function resolveAios(): Promise<AiosDecision> {
  const { main, bulk } = aiosRoles();
  let decision: AiosDecision = { model: main, reason: `main · ${main.label}` };
  try {
    const [codex, claude] = await Promise.all([codexRate(), claudeRate()]);
    const main7d = codex.sevenDay.pct;
    const main5h = codex.fiveHour.pct;
    const claudeNearCap =
      (claude.sevenDay.pct ?? 0) >= 85 || (claude.fiveHour.pct ?? 0) >= 90;
    const clock = windowElapsedPct(codex.sevenDay.resetsAt);
    const margin = loadSettings().aiosRouterPaceMargin;
    // 5h is only SOFT until the overage credits run out (seen live 2026-07-11:
    // "0% left" + hard refusal) — a maxed 5h meter is a divert signal, same as
    // a capped 7d. claude near-cap still wins: never route INTO a wall.
    const capped =
      (main7d != null && main7d >= 97) || (main5h != null && main5h >= 99);
    if (capped && !claudeNearCap) {
      const which =
        main5h != null && main5h >= 99 ? `5h capped (${main5h}%)` : `7d capped (${main7d}%)`;
      decision = {
        model: bulk,
        reason: `${main.label} ${which} → bulk · ${bulk.label}`,
      };
    } else if (
      main7d != null &&
      clock != null &&
      !claudeNearCap &&
      main7d - clock >= margin
    ) {
      decision = {
        model: bulk,
        reason: `${main.label} 7d ahead of pace (${main7d}% used · ${clock}% through the week) → draining claude via bulk · ${bulk.label}`,
      };
    } else if (main7d != null && clock != null) {
      decision = {
        model: main,
        reason: `main on pace (${main7d}% used · ${clock}% through the week)`,
      };
    }
  } catch {
    // meters unavailable → main; never block a chat on a meter.
  }
  saveSettings({ aiosRouterLast: decision.model.id });
  return decision;
}

// ── in-chat model directives ─────────────────────────────────────────────────
// "use fable 5 to check the diff" / "use deep for this" / "switch to sol" —
// parsed BEFORE a message is sent, so the pane can hand the thread to another
// model (or role) mid-conversation. Guards against prose false-positives: the
// message must START with a switch verb AND the phrase after it must be made
// ENTIRELY of model/role words ("use spark notes for X" won't fire; "use
// fable's approach" won't fire).

const MODEL_ALIASES: Array<[RegExp, string]> = [
  [/\bfable\b/i, "claude-fable-5"],
  [/\bopus\b/i, "claude-opus-4-8"],
  [/\bsonnet\b/i, "claude-sonnet-4-6"],
  [/\bhaiku\b/i, "claude-haiku-4-5"],
  [/\bclaude\b/i, "claude-fable-5"],
  [/\bsol\b/i, "gpt-5.6-sol"],
  [/\bterra\b/i, "gpt-5.6-terra"],
  [/\bluna\b/i, "gpt-5.6-luna"],
  [/\bspark\b/i, "gpt-5.3-codex-spark"],
  [/\b5[.·]?5\b/i, "gpt-5.5"],
  [/\b(?:gpt|5[.·]?6|codex)\b/i, "gpt-5.6-sol"],
  [/\baios\b/i, AIOS_MODEL_ID],
];

/** every token of the model phrase must match this — the tightest practical
 *  guard against "use <normal english>" re-routing the pane. */
const DIRECTIVE_TOKEN =
  /^(?:the|model)$|^(?:fable|opus|sonnet|haiku|claude|gpt|codex|sol|terra|luna|spark|aios|deep|main|bulk|heavy|workhorse|thinker?)$|^v?\d+(?:\.\d+)*$/i;

function aliasToModelId(phrase: string): string | null {
  // role names first — they resolve through the configured architecture.
  const roles = loadSettings().aiosRouterRoles;
  if (/\b(?:deep|thinker?)\b/i.test(phrase)) return roles?.deep ?? "claude-fable-5";
  if (/\b(?:bulk|heavy|workhorse)\b/i.test(phrase)) return roles?.bulk ?? "claude-opus-4-8";
  if (/\bmain\b/i.test(phrase)) return roles?.main ?? "gpt-5.6-sol";
  const hit = MODEL_ALIASES.find(([re]) => re.test(phrase));
  return hit ? hit[1] : null;
}

export interface ModelDirective {
  modelId: string;
  /** the task after the switch phrase ("check the diff"), "" = just switch */
  rest: string;
}

export function parseModelDirective(raw: string): ModelDirective | null {
  const m = raw.trim().match(/^(?:use|switch to|guna|pakai)\s+(.+)$/is);
  if (!m) return null;
  const after = m[1];
  // model phrase = everything up to the first task delimiter
  const delim = after.search(/\s+(?:to|for|and|then)\s+|[,:;\n]/i);
  const phrase = (delim >= 0 ? after.slice(0, delim) : after).trim();
  if (!phrase || phrase.length > 40) return null;
  const tokens = phrase.split(/[\s·-]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return null;
  if (!tokens.every((t) => DIRECTIVE_TOKEN.test(t))) return null;
  const modelId = aliasToModelId(phrase);
  if (!modelId) return null;
  const rest =
    delim >= 0
      ? after
          .slice(delim)
          .replace(/^\s+(?:to|for|and|then)\s+/i, "")
          .replace(/^[,:;\n]\s*/, "")
          .trim()
      : "";
  return { modelId, rest };
}

/** Compact transcript tail carried across an in-chat model switch, so "use
 *  fable 5 to check this" hands over WITH context instead of a blank thread. */
export function buildHandoffSeed(
  turns: Array<{ kind: string; text: string }>,
  fromLabel: string,
  task: string,
): string {
  const tail = turns
    .filter((t) => (t.kind === "user" || t.kind === "assistant") && t.text.trim())
    .slice(-12)
    .map((t) => {
      const who = t.kind === "user" ? "firaz" : fromLabel;
      const text = t.text.length > 500 ? `${t.text.slice(0, 500)}…` : t.text;
      return `${who}: ${text}`;
    })
    .join("\n\n")
    .slice(-6000);
  if (!tail) return task;
  return (
    `[aios handoff — you are taking over this conversation from ${fromLabel}. ` +
    `recent transcript follows; continue from it, don't restart.]\n\n${tail}\n\n` +
    `[/handoff]\n\n${task}`
  );
}
