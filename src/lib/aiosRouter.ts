/** aios — the virtual router model at the top of the chat picker.
 *
 *  Not a real backend: picking "aios" resolves to a concrete `ChatModel` here,
 *  and the pane keeps that concrete model in state (so ALL existing engine
 *  plumbing — spawn, usage strip, effort mapping — is untouched). The route
 *  logic is intentionally simple: run the main GPT model through the Claude
 *  Code harness while its real 5h meter is below 100%, switch that same model
 *  to native Codex at 100% (or an authoritative hard-limit response), then
 *  return new sessions to the Claude harness when the fresh meter resets to
 *  zero. The pane stores the concrete result, keeping active sessions
 *  sticky while new sessions follow the latest meter.
 *
 *  Roles live in settings (`aiosRouterRoles`) so new models are a settings
 *  change, not a code change. Every decision carries a
 *  human-readable `reason` — surfaced in the pane so routing is never a black
 *  box.
 */

import { CHAT_MODELS, type ChatModel } from "./chat";
import { claudeRate } from "./dashboard";
import { loadSettings, saveSettings } from "./settings";
import { decideAiosProvider } from "./aiosRouterPolicy";

export const AIOS_MODEL_ID = "aios";

export interface AiosDecision {
  model: ChatModel;
  harness: "claude" | null;
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

// Hard-limit responses arrive on the chat transport and are more authoritative
// than the usage endpoint's short-lived cache. The transport calls this as soon
// as Claude refuses a turn; a fresh zero meter clears it on the next resolve.
let claudeHardLimited = false;
let lastClaudeResetAt: number | null = null;
let hardLimitResetAt: number | null = null;

export function observeClaudeHardLimit(): void {
  claudeHardLimited = true;
  hardLimitResetAt = lastClaudeResetAt;
}

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
 *  resolved model, else fable. `resolveAios()` corrects it before the first
 *  send if the meters disagree. */
export function resolveAiosSync(): AiosDecision {
  const { main } = aiosRoles();
  if (claudeHardLimited) {
    return { model: main, harness: null, reason: `claude hard limit → native codex · ${main.label}` };
  }
  const cachedHarness = loadSettings().aiosRouterLastHarness;
  return cachedHarness === "native"
    ? { model: main, harness: null, reason: `last route → native codex · ${main.label}` }
    : { model: main, harness: "claude", reason: `last route → ${main.label} via claude code` };
}

/** The real route decision. The last route is never an input: it is only a
 * synchronous boot hint while this fresh meter read is in flight. */
export async function resolveAios(): Promise<AiosDecision> {
  const { main } = aiosRoles();
  let decision: AiosDecision = { model: main, harness: "claude", reason: `claude meter unknown → ${main.label} via claude code` };
  try {
    const claude = await claudeRate();
    const pct = claude.fiveHour.pct;
    const resetAt = claude.fiveHour.resetsAt;
    const resetWindowAdvanced =
      pct === 0 && resetAt != null && hardLimitResetAt != null && resetAt !== hardLimitResetAt;
    if (resetWindowAdvanced) {
      claudeHardLimited = false;
      hardLimitResetAt = null;
    }
    if (resetAt != null) lastClaudeResetAt = resetAt;
    const provider = decideAiosProvider({
      claudeFiveHourPct: pct,
      claudeHardLimited,
      resetWindowAdvanced,
    });
    decision = provider === "claude"
      ? { model: main, harness: "claude", reason: pct == null ? `claude meter unknown → ${main.label} via claude code` : `claude 5h ${pct}% → ${main.label} via claude code` }
      : { model: main, harness: null, reason: claudeHardLimited ? `claude hard limit → native codex · ${main.label}` : `claude 5h capped (${pct}%) → native codex · ${main.label}` };
  } catch {
    // Unknown meter prefers fable unless the transport observed a hard refusal.
    if (claudeHardLimited) {
      decision = { model: main, harness: null, reason: `claude hard limit → native codex · ${main.label}` };
    }
  }
  saveSettings({
    aiosRouterLast: decision.model.id,
    aiosRouterLastHarness: decision.harness === "claude" ? "claude" : "native",
  });
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
