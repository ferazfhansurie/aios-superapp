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
import { Channel, invoke } from "@tauri-apps/api/core";

/** Options for starting a chat session. All optional. */
export interface ChatStartOpts {
  /** Working directory for the claude process (so tools hit the right repo). */
  cwd?: string | null;
  /** Model id or alias, e.g. `claude-opus-4-8` or `opus`. */
  model?: string | null;
  /** claude permission mode: bypassPermissions | plan | default | acceptEdits. */
  permissionMode?: string | null;
  /** reasoning effort: low | medium | high | xhigh | max. */
  effort?: string | null;
  /** resume a prior claude session id (continues that conversation). */
  resume?: string | null;
}

/** A past chat session for the /resume picker. */
export interface ChatSessionInfo {
  id: string;
  title: string;
  cwd: string;
  mtime: number;
}

/** Lists the chats started in the chat pane (from the chat store) for /resume. */
export async function listChatSessions(limit = 40): Promise<ChatSessionInfo[]> {
  return invoke<ChatSessionInfo[]>("list_chat_sessions", { limit });
}

/** Records (upserts) a chat-pane session so /resume lists only chats started here. */
export async function recordChatSession(id: string, title: string, cwd?: string | null): Promise<void> {
  return invoke("record_chat_session", { id, title, cwd: cwd ?? null });
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
}
export const EFFORTS: EffortOption[] = [
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh" },
  { id: "max", label: "max" },
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
  /** Value passed to claude `--model` (or ignored if disabled). */
  id: string;
  /** Display label. */
  label: string;
  /** If true, shown greyed and not selectable yet. */
  disabled?: boolean;
  /** Tooltip note (e.g. availability date) shown for disabled entries. */
  note?: string;
}

/**
 * The model list for the Codex-style picker. Claude models are live; the OpenAI
 * entry is a greyed placeholder — the OpenAI subscription SDK isn't permitted
 * until ~June 1, so it's shown but not selectable.
 */
export const CHAT_MODELS: ChatModel[] = [
  { id: "claude-opus-4-8", label: "opus 4.8" },
  { id: "claude-sonnet-4-6", label: "sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "haiku 4.5" },
  { id: "openai", label: "openai", disabled: true, note: "june 1" },
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
    cwd: opts.cwd ?? null,
    model: opts.model ?? null,
    permissionMode: opts.permissionMode ?? null,
    effort: opts.effort ?? null,
    resume: opts.resume ?? null,
  });
}

/** Sends one user turn into a live chat session. Reply streams over the Channel. */
export async function chatSend(id: number, text: string): Promise<void> {
  return invoke("chat_send", { sessionId: id, text });
}

/** Kills a chat session and frees its claude process. */
export async function chatStop(id: number): Promise<void> {
  return invoke("chat_stop", { sessionId: id });
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
