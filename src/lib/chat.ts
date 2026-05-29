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
}

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
  // catch-all
  [key: string]: unknown;
}

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
