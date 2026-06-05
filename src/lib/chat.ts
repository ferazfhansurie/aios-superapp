/**
 * Thin wrappers over the Rust chat commands (`chat.rs`). A chat session runs the
 * local `claude` binary in headless streaming-JSON mode — NOT a scraped TUI.
 *
 * Backend invocation (verified live against claude 2.1.156):
 *
 *   claude -p --output-format stream-json --input-format stream-json \
 *          --include-partial-messages --verbose [--model <id>] \
 *          [--permission-mode <mode>]
 *
 * stdin  (one user turn, newline-delimited):
 *   {"type":"user","message":{"role":"user",
 *     "content":[{"type":"text","text":"say hi"}]}}
 *
 * stdout (newline-delimited events — a real captured exchange):
 *   {"type":"system","subtype":"init","session_id":"da9e..","model":"claude-haiku-4-5",..}
 *   {"type":"stream_event","event":{"type":"content_block_delta","index":1,
 *     "delta":{"type":"text_delta","text":"Hey, "}},..}
 *   {"type":"assistant","message":{"role":"assistant",
 *     "content":[{"type":"text","text":"Hey, what's up!"}],..}}
 *   {"type":"result","subtype":"success","result":"Hey, what's up!",
 *     "duration_ms":4844,"usage":{..},"total_cost_usd":0.11,..}
 *
 * The claude process STAYS ALIVE between turns (blocks on stdin), so one process
 * serves the whole conversation — `chatSend` just writes another user line. The
 * raw JSON lines stream over a per-session Tauri `Channel<string>`; parsing
 * happens in `ChatPane.tsx`.
 */
import { Channel } from "@tauri-apps/api/core";
import { invoke } from "./tauri";

/** Options for starting a chat session. All optional. */
export interface ChatStartOpts {
  /** Which engine drives the session: "claude" (default) | "codex" | "opencode".
   *  codex runs on the ChatGPT subscription; opencode bridges openrouter + 75
   *  providers (incl free models). The backend normalizes every engine's output
   *  into claude's event shape, so the pane renders them identically. */
  engine?: string | null;
  /** Working directory for the claude process (so tools hit the right repo). */
  cwd?: string | null;
  /** Model id or alias, e.g. `claude-opus-4-8` or `opus`. */
  model?: string | null;
  /** claude permission mode: bypassPermissions | plan | default | acceptEdits. */
  permissionMode?: string | null;
  /** reasoning effort: low | medium | high | xhigh | max. */
  effort?: string | null;
  /** Use the low-context startup profile where supported. Codex strips MCP
   *  servers from its chat home; other engines currently ignore this. */
  fast?: boolean | null;
  /** resume a prior claude session id (continues that conversation). */
  resume?: string | null;
}

/** A past chat session for the /resume picker. */
export interface ChatSessionInfo {
  id: string;
  title: string;
  cwd: string;
  mtime: number;
  engine?: "claude" | "codex" | "opencode" | string;
  model?: string;
}

/** Lists the chats started in the chat pane (from the chat store) for /resume. */
export async function listChatSessions(limit = 40): Promise<ChatSessionInfo[]> {
  return invoke<ChatSessionInfo[]>("list_chat_sessions", { limit });
}

/** Records (upserts) a chat-pane session so /resume lists only chats started here. */
export async function recordChatSession(
  id: string,
  title: string,
  cwd?: string | null,
  engine?: string | null,
  model?: string | null,
): Promise<void> {
  return invoke("record_chat_session", {
    id,
    title,
    cwd: cwd ?? null,
    engine: engine ?? null,
    model: model ?? null,
  });
}

/** A past turn loaded from a transcript, to repaint a resumed conversation. */
export interface ChatTurnInfo {
  role: "user" | "assistant";
  text: string;
}

/** Loads a past session's conversation (user/assistant text) to repaint it. */
export async function readChatTranscript(id: string): Promise<ChatTurnInfo[]> {
  return invoke<ChatTurnInfo[]>("read_chat_transcript", { id });
}

/** Reasoning effort levels claude exposes via `--effort` (all models accept
 *  these; xhigh/max are the deepest tiers — the "ultracode" end). */
export interface EffortOption {
  id: string;
  label: string;
  /** Secondary line shown in the menu (e.g. ultracode's "xhigh + workflows"). */
  sub?: string;
  /** The flashy top tier — rendered with the animated purple gradient. */
  ultra?: boolean;
}
export const EFFORTS: EffortOption[] = [
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh" },
  { id: "max", label: "max" },
  { id: "ultracode", label: "ultracode", sub: "xhigh + workflows", ultra: true },
];

/**
 * A streamed claude event. Intentionally LOOSE — the component narrows on
 * `type` and digs into the relevant nested shape. Common types seen:
 * `system` (subtype init/hook_*), `assistant`, `stream_event`, `result`,
 * `rate_limit_event`, plus our synthetic `aios_stderr`.
 */
export interface ChatEvent {
  type: string;
  subtype?: string;
  // assistant / user
  message?: {
    role?: string;
    model?: string;
    content?: Array<{
      type: string; // "text" | "thinking" | "tool_use" | "tool_result"
      text?: string;
      thinking?: string;
      name?: string; // tool_use
      input?: Record<string, unknown>; // tool_use args
      id?: string;
      tool_use_id?: string; // tool_result
      content?: unknown; // tool_result payload
      is_error?: boolean;
    }>;
    usage?: Record<string, unknown>;
  };
  // stream_event (partial / token streaming)
  event?: {
    type: string; // "content_block_delta" | "content_block_start" | ...
    index?: number;
    delta?: {
      type: string; // "text_delta" | "thinking_delta" | "signature_delta"
      text?: string;
      thinking?: string;
    };
    content_block?: { type: string; name?: string; id?: string };
  };
  // result
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  // init / general
  session_id?: string;
  model?: string;
  permissionMode?: string;
  // synthetic `usage` event (emitted by chat.rs after each turn / on a codex
  // rate-limit push) — drives the composer's live usage bar.
  provider?: string; // "claude" | "codex"
  five_hour?: { pct?: number | null; resets_at?: number | null };
  seven_day?: { pct?: number | null; resets_at?: number | null };
  // synthetic stderr
  text?: string;
  // control protocol (interrupts + permission/approval requests in non-bypass
  // modes). claude → us: `control_request` (subtype `can_use_tool`) and
  // `control_response` (ack of our interrupt). We reply via `chatSendRaw`.
  request_id?: string;
  request?: {
    subtype?: string; // "interrupt" | "can_use_tool" | ...
    tool_name?: string;
    input?: Record<string, unknown>;
    permission_suggestions?: unknown;
    [key: string]: unknown;
  };
  response?: {
    subtype?: string; // "success" | "error"
    request_id?: string;
    [key: string]: unknown;
  };
  // catch-all
  [key: string]: unknown;
}

/** A permission/approval decision sent back over the control protocol. */
export type ApprovalDecision = "allow" | "allow_always" | "deny";

/** One selectable chat model in the composer's model picker. */
export interface ChatModel {
  /** Value passed to the engine (claude `--model`, codex/opencode `-m`). */
  id: string;
  /** Display label. */
  label: string;
  /** Which backend runs it. Omitted = claude. */
  engine?: "claude" | "codex" | "opencode";
  /** If true, shown greyed and not selectable yet. */
  disabled?: boolean;
  /** Tooltip note (e.g. availability date) shown for disabled entries. */
  note?: string;
}

/**
 * Built-in model list for the composer picker. Claude models run the native
 * stream-json process; codex models run on the ChatGPT subscription (no API
 * key); opencode models bridge openrouter + 75 providers (incl free models for
 * when the ChatGPT sub hits its rate window). Settings adds the full live
 * opencode/openrouter catalog on top of these.
 */
export const CHAT_MODELS: ChatModel[] = [
  // ChatGPT-subscription models via Codex — no API key, no per-token billing.
  // The whole gpt-5.x family Codex serves on the sub (verified each returns a
  // turn over `codex exec -m <id>`): 5.5 (flagship), 5.4 + a fast mini, the
  // 5.3 codex-tuned build, and 5.2. NOT gpt-4o/o3/image — those are raw-API
  // only (need a key), so they're intentionally absent.
  { id: "gpt-5.3-codex-spark", label: "gpt-5.3 codex spark", engine: "codex" },
  { id: "gpt-5.3-codex", label: "gpt-5.3 codex", engine: "codex" },
  { id: "gpt-5.5", label: "gpt-5.5 · codex", engine: "codex" },
  { id: "gpt-5.4", label: "gpt-5.4 · codex", engine: "codex" },
  { id: "gpt-5.4-mini", label: "gpt-5.4 mini · codex", engine: "codex" },
  { id: "gpt-5.2", label: "gpt-5.2 · codex", engine: "codex" },
  { id: "claude-opus-4-8", label: "opus 4.8", engine: "claude" },
  { id: "claude-sonnet-4-6", label: "sonnet 4.6", engine: "claude" },
  { id: "claude-haiku-4-5", label: "haiku 4.5", engine: "claude" },
  // ONE free fallback for when the ChatGPT sub hits its rate window:
  // NVIDIA Nemotron (Llama-based, US) via opencode — best free non-Chinese
  // model in the catalog. Deliberately the only free entry; no model sprawl.
  {
    id: "opencode/nemotron-3-super-free",
    label: "nemotron · free",
    engine: "opencode",
  },
];

/** Permission modes claude accepts, for the "Full access ▾" chip. */
export interface PermissionOption {
  id: string;
  label: string;
}

export const PERMISSION_MODES: PermissionOption[] = [
  { id: "bypassPermissions", label: "full access" },
  { id: "acceptEdits", label: "accept edits" },
  { id: "default", label: "ask each time" },
  { id: "plan", label: "plan only" },
];

/**
 * Starts a chat session. Streams raw claude JSON event lines over `onEvent`.
 * Returns the backend session id (use it for `chatSend` / `chatStop`).
 */
export async function chatStart(
  onEvent: Channel<string>,
  opts: ChatStartOpts = {},
): Promise<number> {
  return invoke<number>("chat_start", {
    onEvent,
    engine: opts.engine ?? null,
    cwd: opts.cwd ?? null,
    model: opts.model ?? null,
    permissionMode: opts.permissionMode ?? null,
    effort: opts.effort ?? null,
    fast: opts.fast ?? null,
    resume: opts.resume ?? null,
  });
}

/**
 * Sends one user turn into a live chat session. Reply streams over the Channel.
 * `imagePaths` are absolute temp-file paths for attached images; the backend
 * reads them and sends REAL image content blocks (claude base64 / codex
 * localImage) so the model sees them natively on every turn — not just the first.
 */
export async function chatSend(
  id: number,
  text: string,
  imagePaths?: string[],
): Promise<void> {
  return invoke("chat_send", {
    sessionId: id,
    text,
    imagePaths: imagePaths && imagePaths.length ? imagePaths : null,
  });
}

/**
 * Steers the in-flight turn — injects a follow-up message WITHOUT interrupting
 * the model (codex `turn/steer`; the model folds it into the running turn at its
 * next step). Only codex supports true mid-turn steering; for other engines this
 * REJECTS (caller should queue the message instead). Verified live vs codex 0.135.
 */
export async function chatSteer(id: number, text: string): Promise<void> {
  return invoke("chat_steer", { sessionId: id, text });
}

/** Kills a chat session and frees its claude process. */
export async function chatStop(id: number): Promise<void> {
  return invoke("chat_stop", { sessionId: id });
}

/** Detaches a session from its pane WITHOUT killing it — the claude process
 *  keeps running and buffering. `notify` arms a done-notification. */
export async function chatDetach(id: number, notify: boolean): Promise<void> {
  return invoke("chat_detach", { sessionId: id, notify });
}

export interface ChatReattachInfo {
  busy: boolean;
}

/** Reattaches a reopened pane to a live/backgrounded session; replays the
 *  buffered output through the channel, then goes live. */
export async function chatReattach(id: number, onEvent: Channel<string>): Promise<ChatReattachInfo> {
  return invoke<ChatReattachInfo>("chat_reattach", { sessionId: id, onEvent });
}

/** Sets the label used by the background tray + done-notification. */
export async function chatSetTitle(id: number, title: string): Promise<void> {
  return invoke("chat_set_title", { sessionId: id, title });
}

/** A live (backgrounded) chat session for the "running" tray. */
export interface LiveChat {
  id: number;
  claude_id: string | null;
  title: string;
  busy: boolean;
  detached: boolean;
}

/** Lists currently-backgrounded chat sessions. */
export async function listChatLive(): Promise<LiveChat[]> {
  return invoke<LiveChat[]>("list_chat_live");
}

/**
 * Interrupts the in-flight turn via claude's control protocol (sends a
 * `control_request`/`interrupt`). The process survives — the next `chatSend`
 * runs a fresh turn — so this is a true stop, not a kill. Verified live: claude
 * acks with a `control_response` then ends the turn with a `result` of subtype
 * `error_during_execution`.
 */
export async function chatInterrupt(id: number): Promise<void> {
  return invoke("chat_interrupt", { sessionId: id });
}

/**
 * Writes a raw JSON control line to the session's stdin. Used to reply to
 * claude's permission/approval requests (a `control_request` with subtype
 * `can_use_tool` in non-bypass modes) with a matching `control_response`.
 */
export async function chatSendRaw(id: number, line: string): Promise<void> {
  return invoke("chat_send_raw", { sessionId: id, line });
}

/**
 * Builds the `control_response` line replying to a `can_use_tool` permission
 * request. `allow` → permit once; `allow_always` → permit + remember for the
 * session (updatedPermissions); `deny` → refuse with a short reason.
 *
 * The exact reply schema is claude's SDK control protocol. We keep this in TS
 * (not Rust) so it can evolve without a rebuild. If a future claude expects a
 * slightly different shape, this is the one place to adjust.
 */
export function buildApprovalLine(
  requestId: string,
  decision: ApprovalDecision,
  toolName?: string,
): string {
  const allow = decision === "allow" || decision === "allow_always";
  const inner: Record<string, unknown> = allow
    ? { behavior: "allow", updatedInput: {} }
    : { behavior: "deny", message: "Denied by user." };
  if (decision === "allow_always" && toolName) {
    inner.updatedPermissions = [
      { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" },
    ];
  }
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: inner },
  });
}

export interface WebChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface WebChatResponse {
  text: string;
  model?: string;
  usage?: Record<string, unknown>;
}

/** Browser-hosted chat path. Desktop uses the Tauri channel above; web posts to
 *  the Pages Function so the hosted shell can answer without a local binary. */
export async function webChatSend(
  text: string,
  opts: {
    model?: string | null;
    messages?: WebChatTurn[];
    signal?: AbortSignal;
  } = {},
): Promise<WebChatResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model: opts.model ?? null,
      messages: opts.messages ?? [],
    }),
    signal: opts.signal,
  });
  const data = await res.json().catch(() => null) as
    | (WebChatResponse & { error?: string })
    | null;
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("web chat endpoint is not deployed yet");
    }
    throw new Error(data?.error ?? `web chat failed (${res.status})`);
  }
  if (!data || typeof data.text !== "string") {
    throw new Error("web chat returned an invalid response");
  }
  return data;
}
