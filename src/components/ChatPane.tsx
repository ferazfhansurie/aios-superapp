/**
 * Codex-style chat surface for the AIOS cockpit.
 *
 * Looks like OpenAI Codex's chat — centered "do anything" composer when empty,
 * clean transcript with text bubbles + tool-call cards after the first send —
 * but under the hood drives the local `claude` binary in headless streaming-JSON
 * mode (see `lib/chat.ts` / `chat.rs`). The backend is a dumb pipe: it forwards
 * raw newline-delimited claude JSON events over a per-session `Channel<string>`;
 * ALL parsing + rendering happens here.
 *
 * Lifecycle: one Channel + one chat session per mount. `chatStart` on mount with
 * the selected model/permission, `chatSend` on submit, `chatStop` on unmount.
 *
 * Best-in-class layer (Codex / Claude-Desktop grade) added on top of the working
 * stream-json core — without disturbing it:
 *   1. voice dictation lands in the composer (paneWriters registry)
 *   2. dependency-free markdown renderer for assistant bubbles (partial-safe)
 *   3. per-message hover actions: copy / regenerate / faint cost+token line
 *   4. stop-while-streaming (true interrupt, process survives)
 *   5. inline approval cards for `can_use_tool` control requests
 *   6. plan-mode toggle + persistent "pursue goal" pill
 *   7. `/` slash menu (clear / plan / model / help)
 *   8. `@` file-mention picker sourced from cwd
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel, convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  ArrowUp,
  ArrowDown,
  PackageOpen,
  AtSign,
  Brain,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  CornerDownLeft,
  FileCode,
  FileText,
  FileType,
  Folder,
  Globe,
  HelpCircle,
  History,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldQuestion,
  Slash,
  Sparkles,
  Square,
  Target,
  Terminal,
  Waypoints,
  Wrench,
  X,
} from "lucide-react";
import {
  buildApprovalLine,
  chatInterrupt,
  chatDetach,
  chatReattach,
  chatSend,
  chatSteer,
  chatSendRaw,
  chatSetTitle,
  chatStart,
  chatStop,
  listChatSessions,
  readChatTranscript,
  recordChatSession,
  CHAT_MODELS,
  EFFORTS,
  PERMISSION_MODES,
  type ApprovalDecision,
  type ChatEvent,
  type ChatModel,
  type ChatSessionInfo,
  type ChatTurnInfo,
} from "../lib/chat";
import { readDir, saveImageTemp, type DirEntry } from "../lib/fs";
import { loadSettings, saveSettings } from "../lib/settings";
import { idleRate, codexRate, resetIn } from "../lib/dashboard";
import {
  composerContextChips,
  cycleQueueSelection,
  moveQueuedMessage,
  queueMessage,
  removeQueuedMessage,
  resumeTitle,
  sendContract,
  updateQueuedMessage,
  usageStack,
  type QueuedMessage,
} from "../lib/chatPaneState";
import { dictateCancel, dictateStart, dictateStop } from "../lib/voice";
import { chatHandles, paneWriters, paneSubmitters, paneImageDrop, openFileInPane, openUrlInPane } from "../lib/paneBus";
import { isHttpPaneTarget, isPaneFileTarget, resolvePaneFileTarget, targetLabel } from "../lib/paneRouting";
import { emptyRunEventState, reduceRunEvents, type RunEventState } from "../lib/runEvents";
import { memorySearch, type MemoryHit } from "../lib/memory";
import { buildAiosShellContext } from "../lib/aiosContext";
import { shouldAutoscroll } from "../lib/chatScroll";
import { PaneDropZone } from "./PaneDropZone";

// ── transcript model ──────────────────────────────────────────────────────

type Turn =
  | { kind: "user"; id: string; text: string; steered?: boolean }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | {
      kind: "thinking";
      id: string;
      text: string;
      streaming: boolean;
      startedAt?: number;
      durationMs?: number;
    }
  | {
      kind: "tool";
      id: string; // tool_use id from claude
      name: string;
      input: Record<string, unknown>;
      result?: string;
      isError?: boolean;
    }
  | {
      kind: "approval";
      id: string; // synthetic; keyed off the control request_id
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      decision?: ApprovalDecision; // set once the user picks → card becomes resolved
    }
  | {
      kind: "result";
      id: string;
      text: string;
      cost?: number;
      tokens?: number;
      durationMs?: number; // claude's reported turn duration (for the activity timer)
    };

/**
 * A display block — the rendered grouping of `Turn`s. Runs of consecutive tool
 * turns collapse into a single `activity` block (the Codex "Worked for Xs" line);
 * everything else passes through. Computed from `turns` purely for render — the
 * ingestion model (`Turn`) is untouched.
 */
type RenderBlock =
  | { kind: "user"; id: string; turn: Extract<Turn, { kind: "user" }> }
  | { kind: "assistant"; id: string; turn: Extract<Turn, { kind: "assistant" }> }
  | { kind: "thinking"; id: string; turn: Extract<Turn, { kind: "thinking" }> }
  | { kind: "approval"; id: string; turn: Extract<Turn, { kind: "approval" }> }
  | { kind: "result"; id: string; turn: Extract<Turn, { kind: "result" }> }
  | { kind: "activity"; id: string; tools: ToolTurn[]; durationMs?: number };

let _uid = 0;
const uid = () => `t${++_uid}`;

/** A pasted/attached image: live thumbnail + its saved temp path (null while saving). */
interface ImageChip {
  id: string;
  url: string;
  path: string | null;
}
let _imgSeq = 0;
/** Shell-quote a path for embedding in a message (single-quote, escape inner '). */
function quotePath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}
/** "0:05" from elapsed seconds (dictation timer). */
function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
/** Precomputed equalizer bars for the inline dictation waveform (time-keyed). */
const WAVEFORM_BARS: { h: number; delay: number }[] = Array.from(
  { length: 40 },
  (_, i) => ({ h: 28 + ((i * 37) % 60), delay: (i * 70) % 900 }),
);
const WAVE_KEYFRAMES = `@keyframes aios-wave {
  0%, 100% { transform: scaleY(0.32); opacity: 0.55; }
  50% { transform: scaleY(1); opacity: 1; }
}`;

/** File extension for a clipboard/file image mime. */
function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  return "png";
}

// instruction prefixes for the composer modes
const PLAN_PREFIX =
  "Plan first: lay out a concise step-by-step plan and wait for my go-ahead before writing any code or running mutating commands.\n\n";
const GOAL_PREFIX = (goal: string) =>
  `Ongoing goal (keep pursuing this across turns until I say it's done): ${goal}\n\n`;
// ultracode = xhigh effort + workflows. Headless `claude -p` has no ultracode
// flag, so we run xhigh and replicate the "workflows" half with this directive:
// orchestrate, fan out, verify — be maximally thorough.
const ULTRA_PREFIX =
  "Ultracode mode is ON. Maximize thoroughness and correctness — token cost is not a constraint. For any substantial task, decompose it and fan out parallel sub-agents (Task tool) to cover it, then adversarially verify findings before concluding. Prefer orchestrated multi-agent execution over a single pass; only handle trivially small tasks inline.\n\n";

function memoryContextBlock(memories: MemoryHit[]): string {
  if (memories.length === 0) return "";
  return `Relevant AIOS memory context:\n${memories
    .map((m, i) => {
      const reasons = m.reasons.length ? ` reasons: ${m.reasons.join("; ")}` : "";
      return `${i + 1}. ${m.title} [${m.type}] — ${m.description || m.preview}${reasons}`;
    })
    .join("\n")}\n\n`;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Renders tool input as a compact `key: value` preview (first few keys). */
function previewArgs(input: Record<string, unknown>): string {
  const entries = Object.entries(input ?? {});
  if (entries.length === 0) return "";
  return entries
    .slice(0, 3)
    .map(([k, v]) => {
      let s = typeof v === "string" ? v : JSON.stringify(v);
      if (s.length > 80) s = s.slice(0, 80) + "…";
      return `${k}: ${s}`;
    })
    .join("  ");
}

/** Stringifies a claude tool_result payload (string | content blocks | json). */
function resultToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b
          ? String((b as { text: unknown }).text)
          : JSON.stringify(b),
      )
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

/** Pulls a total token count out of the loose result `usage` object. */
function tokensFromUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const inT = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const outT = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const cacheRead =
    typeof u.cache_read_input_tokens === "number"
      ? u.cache_read_input_tokens
      : 0;
  const cacheCreate =
    typeof u.cache_creation_input_tokens === "number"
      ? u.cache_creation_input_tokens
      : 0;
  const total = inT + outT + cacheRead + cacheCreate;
  return total > 0 ? total : undefined;
}

/** basename for a path, for the @-mention picker labels. */
function baseName(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// ── tool presentation (Codex-style activity steps) ───────────────────────────

type ToolTurn = Extract<Turn, { kind: "tool" }>;

/** Truncate the middle of a string so both ends stay visible. */
function ellipsizeMid(s: string, max = 52): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return s.slice(0, half) + "…" + s.slice(s.length - half);
}

/** Pull the most relevant target arg out of a tool's input. Mirrors the verbs
 *  below: a path basename for file tools, the command for Bash, the pattern for
 *  search, the URL for fetches, else a compact key:value preview. */
function toolTarget(turn: ToolTurn): { label: string; full: string } {
  const inp = turn.input ?? {};
  const name = turn.name.toLowerCase();
  const str = (k: string) =>
    typeof inp[k] === "string" ? (inp[k] as string) : undefined;

  // file tools → basename (full path on hover)
  const path = str("file_path") ?? str("path") ?? str("notebook_path");
  if (path) return { label: ellipsizeMid(baseName(path)), full: path };

  // shell → the command (first line)
  if (name === "bash" || name === "bashoutput" || name === "exec_command" || name === "write_stdin") {
    const cmd = str("command") ?? str("cmd") ?? str("chars") ?? "";
    const firstLine = cmd.split("\n")[0] ?? cmd;
    return { label: ellipsizeMid(firstLine, 60), full: cmd };
  }

  // search / grep / glob → pattern (+ optional path)
  if (name === "grep" || name === "glob" || name === "search") {
    const pat = str("pattern") ?? str("query") ?? "";
    const where = str("path");
    const full = where ? `${pat}  in ${where}` : pat;
    return { label: ellipsizeMid(pat || full, 56), full };
  }

  // web → url / query / domains
  if (name === "webfetch" || name === "webfetch_tool") {
    const url = str("url") ?? "";
    return { label: ellipsizeMid(url, 56), full: url };
  }
  if (name === "websearch") {
    const q = str("query") ?? "";
    return { label: ellipsizeMid(q, 56), full: q };
  }

  // task / sub-agent → description
  if (name === "task") {
    const d = str("description") ?? str("subagent_type") ?? "";
    return { label: ellipsizeMid(d, 56), full: d };
  }

  // fall back to the generic key:value preview
  const preview = previewArgs(inp);
  return { label: ellipsizeMid(preview, 56), full: preview };
}

/** A short verb for the tool, Codex-style ("Read", "Ran", "Edited", "Searched"). */
function toolVerb(name: string): string {
  switch (name.toLowerCase()) {
    case "read":
      return "Read";
    case "write":
      return "Wrote";
    case "edit":
    case "multiedit":
      return "Edited";
    case "notebookedit":
      return "Edited";
    case "bash":
    case "exec_command":
      return "Ran";
    case "bashoutput":
    case "write_stdin":
      return "Output";
    case "grep":
    case "search":
      return "Searched";
    case "glob":
      return "Globbed";
    case "webfetch":
    case "webfetch_tool":
      return "Fetched";
    case "websearch":
      return "Web search";
    case "task":
      return "Agent";
    case "mcp":
    case "mcp_tool_call":
      return "MCP";
    case "todowrite":
      return "Planned";
    default:
      return name;
  }
}

/** Pick the lucide icon component for a tool's activity row. */
function toolIcon(name: string) {
  switch (name.toLowerCase()) {
    case "read":
      return FileText;
    case "write":
    case "notebookedit":
      return FileText;
    case "edit":
    case "multiedit":
      return Pencil;
    case "bash":
    case "bashoutput":
    case "exec_command":
    case "write_stdin":
      return Terminal;
    case "grep":
    case "glob":
    case "search":
      return Search;
    case "webfetch":
    case "webfetch_tool":
    case "websearch":
      return Globe;
    case "mcp":
    case "mcp_tool_call":
      return Wrench;
    default:
      return Wrench;
  }
}

// ── file artifacts (Write / Edit / NotebookEdit targets) ─────────────────────

interface Artifact {
  path: string;
  name: string;
  kind: "img" | "pdf" | "doc" | "code" | "file";
}

const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);
const DOC_EXT = new Set(["doc", "docx", "md", "txt", "rtf", "csv", "xlsx", "xls", "ppt", "pptx", "key"]);
const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "rs", "py", "go", "java", "rb", "php", "c", "cc", "cpp",
  "h", "hpp", "cs", "swift", "kt", "sh", "zsh", "bash", "json", "yaml", "yml", "toml",
  "html", "css", "scss", "sql", "lua", "dart", "vue", "svelte",
]);

function artifactKind(path: string): Artifact["kind"] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (IMG_EXT.has(ext)) return "img";
  if (CODE_EXT.has(ext)) return "code";
  if (DOC_EXT.has(ext)) return "doc";
  return "file";
}

/** Detect the file an artifact-producing tool wrote to (Write/Edit/NotebookEdit). */
function artifactFromTool(turn: ToolTurn): Artifact | null {
  const name = turn.name.toLowerCase();
  if (
    name !== "write" &&
    name !== "edit" &&
    name !== "multiedit" &&
    name !== "notebookedit"
  ) {
    return null;
  }
  const inp = turn.input ?? {};
  const path =
    (typeof inp.file_path === "string" && inp.file_path) ||
    (typeof inp.path === "string" && inp.path) ||
    (typeof inp.notebook_path === "string" && inp.notebook_path) ||
    "";
  if (!path) return null;
  return { path, name: baseName(path), kind: artifactKind(path) };
}

/** Format a duration in ms as a compact human label: "2m 38s", "47s", "0.4s". */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

/** Format an elapsed-while-running timer as m:ss (Codex "Working… 0:42"). */
function fmtClock(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Compact "time since" label from a unix-SECONDS timestamp ("3h ago", "2d ago",
 *  "just now"). Used for the /resume session picker's faint secondary line. */
function fmtRelativeTime(unixSeconds: number): string {
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (diffSec < 45) return "just now";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

// ── component ────────────────────────────────────────────────────────────────

export function ChatPane({
  cwd,
  paneKey,
  seed,
  resume,
  reattach,
  onOpenUrl,
}: {
  cwd?: string;
  paneKey?: string;
  seed?: string;
  /** Resume a prior chat session on mount (from the idle "continue" rail). */
  resume?: { id: string; title: string };
  /** Reattach to a still-live backgrounded session by its backend id (from the
   *  "running" tray) — replays its buffer and continues live instead of spawning. */
  reattach?: number;
  /** Open an http(s) link from rendered markdown in an in-app browser pane. */
  onOpenUrl?: (url: string) => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [runEventState, setRunEventState] = useState<RunEventState>(() =>
    emptyRunEventState(),
  );
  // composer draft persists per pane so /clear, a restart, or a remount never
  // loses what you were typing. Keyed by paneKey; seed (e.g. notes "send to AI")
  // still wins on first mount.
  const draftKey = paneKey ? `aios-chat-draft:${paneKey}` : null;
  const [input, setInput] = useState<string>(() => {
    if (seed) return seed;
    if (draftKey) {
      try {
        return localStorage.getItem(draftKey) ?? "";
      } catch {
        /* ignore */
      }
    }
    return "";
  });
  // persist the draft as it changes (cleared on send).
  useEffect(() => {
    if (!draftKey) return;
    try {
      if (input) localStorage.setItem(draftKey, input);
      else localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  }, [input, draftKey]);

  useEffect(() => {
    const q = input.trim();
    if (q.length < 4) {
      setMemoryHits([]);
      setAttachedMemoryIds([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      memorySearch(q, cwd ?? null, 5)
        .then((hits) => {
          if (cancelled) return;
          setMemoryHits(hits);
          setAttachedMemoryIds((ids) => ids.filter((id) => hits.some((h) => h.id === id)));
        })
        .catch(() => {
          if (!cancelled) setMemoryHits([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [input, cwd]);
  const [streaming, setStreaming] = useState(false);
  const [started, setStarted] = useState(false);
  // claude's init event arrived (session_id known) — gates the seed auto-send
  const [claudeReady, setClaudeReady] = useState(false);

  // composer settings — boot from the saved default (settings.chatModel).
  // The model the user last picked in the composer IS their default; persisted
  // so codex / opus / whatever sticks across panes + restarts.
  const [model, setModel] = useState<ChatModel>(() => {
    const saved = loadSettings().chatModel;
    return CHAT_MODELS.find((m) => m.id === saved) ?? CHAT_MODELS[0];
  });
  const [permission, setPermission] = useState(PERMISSION_MODES[0]);
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>(EFFORTS[1]);
  // running context size (prompt tokens of the latest turn) → composer indicator
  const [ctxTokens, setCtxTokens] = useState<number | null>(null);

  // ── live usage bar (Phase 1) ───────────────────────────────────────────────
  // The active engine's 5h/7d rate-limit windows, ticked as you talk: codex
  // pushes account/rateLimits/updated, claude re-reads usage.json after each turn
  // (both arrive as synthetic `usage` events from chat.rs). Seeded once on mount.
  type UsageWin = { pct: number | null; resetsAt: number | null };
  type UsageSnapshot = { fiveHour: UsageWin; sevenDay: UsageWin };
  type UsageWindow = keyof UsageSnapshot;
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [usageWindow, setUsageWindow] = useState<UsageWindow>("fiveHour");
  // Snapshot each provider the first time it appears in this chat. The strip
  // paints that baseline separately from usage added while this pane is alive.
  const usageBaselineRef = useRef<Record<string, UsageSnapshot>>({});
  const rememberUsage = useCallback((provider: string, next: UsageSnapshot) => {
    if (!usageBaselineRef.current[provider]) {
      usageBaselineRef.current[provider] = next;
    }
    setUsage(next);
  }, []);
  // cumulative $ spent this chat session (summed across result events).
  const [sessionCost, setSessionCost] = useState(0);

  // ── message queue / steering (Phase 2) ─────────────────────────────────────
  // Type-ahead while a turn is in flight: submitting queues the message instead
  // of dropping it; queued messages fire one-by-one as each turn completes
  // (codex-style). Held in a ref too so the flush effect reads the latest list.
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [queuedIdx, setQueuedIdx] = useState(0);
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const [editingQueuedText, setEditingQueuedText] = useState("");
  const queuedRef = useRef<QueuedMessage[]>([]);
  queuedRef.current = queued;

  // mode chips
  const [planMode, setPlanMode] = useState(false);
  const [goal, setGoal] = useState<string>("");
  const [memoryHits, setMemoryHits] = useState<MemoryHit[]>([]);
  const [attachedMemoryIds, setAttachedMemoryIds] = useState<string[]>([]);
  const attachedMemories = useMemo(
    () => attachedMemoryIds
      .map((id) => memoryHits.find((hit) => hit.id === id))
      .filter((hit): hit is MemoryHit => Boolean(hit)),
    [attachedMemoryIds, memoryHits],
  );

  // open-dropdown tracking (single source so only one is open)
  const [openMenu, setOpenMenu] = useState<null | "model" | "perm" | "effort">(
    null,
  );

  // overlay popovers anchored to the composer (slash menu / @-files / resume)
  const [overlay, setOverlay] = useState<null | "slash" | "mention" | "resume">(
    null,
  );
  const [overlayIdx, setOverlayIdx] = useState(0);
  const [mentionItems, setMentionItems] = useState<DirEntry[]>([]);
  const [mentionQuery, setMentionQuery] = useState("");

  // /resume picker: past chat sessions, a typed filter, and a loading flag
  const [resumeSessions, setResumeSessions] = useState<ChatSessionInfo[]>([]);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeQuery, setResumeQuery] = useState("");
  const resumeSearchRef = useRef<HTMLInputElement>(null);

  // the claude session id to resume on (re)start; null = fresh conversation.
  // set by the /resume picker, cleared by a fresh chat / /clear. Seeded from
  // the `resume` prop so the idle "continue" rail lands straight in a session.
  const [resumeId, setResumeId] = useState<string | null>(resume?.id ?? null);
  // the title of the resumed session, shown as a note once after resuming
  const [resumedTitle, setResumedTitle] = useState<string | null>(resume?.title ?? null);

  const sessionIdRef = useRef<number | null>(null);
  // live mirror of `streaming` for the close-handle closure (a turn in flight).
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  // set true when the pane is intentionally detached (kept running) — tells the
  // unmount cleanup NOT to kill the claude process.
  const detachedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // index into `turns` of the assistant bubble currently being streamed
  const streamingTurnId = useRef<string | null>(null);
  // id of the thinking block currently being streamed (own block, precedes text)
  const thinkingTurnId = useRef<string | null>(null);
  // last user prompt text actually sent to claude (for regenerate)
  const lastSentRef = useRef<string | null>(null);
  // ── composer autocomplete (copilot-style) ──────────────────────────────────
  // Past sent messages, newest first — the source for inline ghost completion.
  // Persisted across sessions so the suggestions are useful from the first keypress.
  const HISTORY_KEY = "aios.chat.history";
  const historyRef = useRef<string[]>([]);
  useEffect(() => {
    try {
      const h = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
      if (Array.isArray(h)) historyRef.current = h.filter((x) => typeof x === "string");
    } catch {
      /* ignore */
    }
  }, []);

  // ── chat-session recording (for the /resume list) ─────────────────────────
  // claude's own session id, parsed from the `system`/init event each (re)start.
  // We need it to call recordChatSession() so this chat shows up in /resume.
  const claudeSessionIdRef = useRef<string | null>(null);
  // true once we've recorded this chat (on the first user send of the session),
  // so subsequent sends don't re-upsert. Reset on /clear and on resume.
  const recordedRef = useRef(false);
  // Codex openers are often just "hi". Keep its title promotable until the
  // first meaningful prompt lands, then leave the topic stable.
  const codexTitleLockedRef = useRef(Boolean(resume));
  // true once the launcher seed has been auto-sent as the first turn, so it
  // fires exactly once and never re-fires on /clear or a session restart.
  const seedSentRef = useRef(false);

  // ── turn timing (for the Codex-style "Worked for Xs" activity line) ────────
  // wall-clock ms when the in-flight turn began; null when idle. Drives the live
  // "Working… 0:42" timer and is the fallback duration if claude's result event
  // doesn't carry one.
  const turnStartRef = useRef<number | null>(null);
  const [liveStart, setLiveStart] = useState<number | null>(null);
  // 1Hz tick so the running timer re-renders while streaming
  const [now, setNow] = useState(() => Date.now());
  // keep the latest input in a ref so the unmount writer-cleanup never goes stale
  const inputRef = useRef(input);
  inputRef.current = input;

  const empty = turns.length === 0;

  // ── voice dictation bridge (P0) ────────────────────────────────────────────
  // App registers each pane's writer here; ⌘J dictation pushes text to the
  // focused pane. For a chat pane we append into the composer instead of a PTY.
  useEffect(() => {
    if (!paneKey) return;
    paneWriters.set(paneKey, (t) =>
      setInput((v) => (v ? v.trimEnd() + " " + t : t)),
    );
    // SUBMIT path ("send to AI" → chat): fire the text straight through the
    // kept-fresh sendText ref so it actually sends (no input-state race). Mirror
    // it into the box first so the user sees what went out.
    paneSubmitters.set(paneKey, (t) => {
      setInput(t);
      sendTextRef.current?.(t);
    });
    return () => {
      paneWriters.delete(paneKey);
      paneSubmitters.delete(paneKey);
    };
  }, [paneKey]);

  // A path dragged from another pane (Files) → append it to the composer.
  const insertPath = useCallback((path: string) => {
    setInput((v) => (v ? v.trimEnd() + " " + path + " " : path + " "));
    taRef.current?.focus();
  }, []);

  // ── image attach: paste a screenshot / pick a file → temp file + thumbnail ──
  const [images, setImages] = useState<ImageChip[]>([]);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const addImage = useCallback(async (file: Blob, mime: string) => {
    const id = `img${++_imgSeq}`;
    const url = URL.createObjectURL(file);
    setImages((prev) => [...prev, { id, url, path: null }]);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const path = await saveImageTemp(btoa(bin), extFromMime(mime));
      setImages((prev) => prev.map((im) => (im.id === id ? { ...im, path } : im)));
    } catch {
      setImages((prev) => {
        const gone = prev.find((im) => im.id === id);
        if (gone) URL.revokeObjectURL(gone.url);
        return prev.filter((im) => im.id !== id);
      });
    }
  }, []);
  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const gone = prev.find((im) => im.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((im) => im.id !== id);
    });
  }, []);

  // Attach an image that already lives on disk (an OS file drop from Finder /
  // the desktop). Tauri's native drag-drop hands us a path, not a Blob, so we
  // skip the saveImageTemp round-trip: the chip's thumbnail renders straight off
  // the asset-protocol URL, and `path` is set immediately (already on disk).
  const addImageByPath = useCallback((path: string) => {
    const id = `img${++_imgSeq}`;
    setImages((prev) => [...prev, { id, url: convertFileSrc(path), path }]);
  }, []);

  // Register this chat pane's IMAGE-drop sink so App's native OS drag-drop
  // handler routes dropped image files here as thumbnail chips (instead of
  // appending their raw paths as text via paneWriters). Non-image drops still
  // fall through to the path-insert writer.
  useEffect(() => {
    if (!paneKey) return;
    paneImageDrop.set(paneKey, (paths) => {
      for (const p of paths) addImageByPath(p);
    });
    return () => {
      paneImageDrop.delete(paneKey);
    };
  }, [paneKey, addImageByPath]);
  // paste an image off the clipboard → thumbnail chip (temp file saved in bg)
  const onPasteImage = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            void addImage(file, it.type);
            return;
          }
        }
      }
    },
    [addImage],
  );
  // dropped files (a screenshot dragged from Finder / desktop) → attach any
  // image as a thumbnail chip. Returns true if it consumed ≥1 image, so the
  // drop zone skips inserting a bare path for those.
  const onDropFiles = useCallback(
    (files: FileList): boolean => {
      let took = false;
      for (const f of Array.from(files)) {
        if (f.type.startsWith("image/")) {
          void addImage(f, f.type);
          took = true;
        }
      }
      return took;
    },
    [addImage],
  );
  const savingImg = images.some((im) => im.path == null);

  // ── voice dictation: click mic → inline waveform + timer → transcript ───────
  // Ported from TerminalComposer (the polished one). Records via lib/voice, swaps
  // the textarea for a live equalizer while recording, drops the transcript into
  // the box on stop. Esc cancels.
  type VoicePhase = "idle" | "recording" | "transcribing";
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voiceElapsed, setVoiceElapsed] = useState(0);
  const voicePhaseRef = useRef<VoicePhase>("idle");
  voicePhaseRef.current = voicePhase;
  useEffect(() => {
    if (voicePhase !== "recording") return;
    setVoiceElapsed(0);
    const base = Date.now();
    const t = setInterval(
      () => setVoiceElapsed(Math.floor((Date.now() - base) / 1000)),
      250,
    );
    return () => clearInterval(t);
  }, [voicePhase]);
  const micStart = useCallback(async () => {
    if (voicePhaseRef.current !== "idle") return;
    try {
      await dictateStart();
      setVoicePhase("recording");
    } catch {
      setVoicePhase("idle");
    }
  }, []);
  const micStop = useCallback(async () => {
    if (voicePhaseRef.current !== "recording") return;
    setVoicePhase("transcribing");
    try {
      const text = await dictateStop();
      if (text) {
        setInput((v) => (v ? v.trimEnd() + " " + text : text));
      }
    } catch {
      /* best-effort dictation */
    } finally {
      setVoicePhase("idle");
      taRef.current?.focus();
    }
  }, []);
  const micCancel = useCallback(async () => {
    if (voicePhaseRef.current !== "recording") return;
    setVoicePhase("idle");
    try {
      await dictateCancel();
    } catch {
      /* best-effort */
    }
  }, []);
  const recording = voicePhase === "recording";
  // Esc cancels an in-progress recording (the textarea is swapped out then, so a
  // window listener catches it).
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void micCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, micCancel]);

  // ── event ingestion ───────────────────────────────────────────────────────

  const handleEvent = useCallback((ev: ChatEvent) => {
    setRunEventState((state) => reduceRunEvents(state, ev));
    // ---- control protocol: tool approval requests + acks --------------------
    // claude → us, non-bypass modes: a `control_request` whose request.subtype
    // is `can_use_tool`. We surface an inline approval card; the reply goes back
    // via chatSendRaw (see resolveApproval). `control_response` here is just
    // claude's ack of OUR interrupt — nothing to render.
    if (ev.type === "control_request") {
      const sub = ev.request?.subtype;
      if (sub === "can_use_tool") {
        const reqId = ev.request_id ?? uid();
        const toolName =
          ev.request?.tool_name ?? ev.request?.tool ?? "tool";
        const inp = (ev.request?.input as Record<string, unknown>) ?? {};
        setTurns((prev) => {
          if (prev.some((t) => t.kind === "approval" && t.requestId === reqId)) {
            return prev;
          }
          return [
            ...prev,
            {
              kind: "approval",
              id: uid(),
              requestId: reqId,
              toolName: String(toolName),
              input: inp,
            },
          ];
        });
      }
      return;
    }
    if (ev.type === "control_response") {
      // ack of our interrupt; nothing to display.
      return;
    }

    switch (ev.type) {
      // token-by-token streaming via --include-partial-messages
      case "stream_event": {
        const e = ev.event;
        if (!e) return;
        // extended-thinking tokens stream as their own block, ahead of text
        if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta") {
          const tok = e.delta.thinking ?? "";
          if (!tok) return;
          setTurns((prev) => {
            const next = [...prev];
            const id = thinkingTurnId.current;
            const idx = id ? next.findIndex((t) => t.id === id) : -1;
            if (idx >= 0 && next[idx].kind === "thinking") {
              const t = next[idx] as Extract<Turn, { kind: "thinking" }>;
              next[idx] = { ...t, text: t.text + tok, streaming: true };
            } else {
              const nid = uid();
              thinkingTurnId.current = nid;
              next.push({
                kind: "thinking",
                id: nid,
                text: tok,
                streaming: true,
                startedAt: Date.now(),
              });
            }
            return next;
          });
          return;
        }
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
          const tok = e.delta.text ?? "";
          if (!tok) return;
          setTurns((prev) => {
            const next = [...prev];
            const id = streamingTurnId.current;
            const idx = id ? next.findIndex((t) => t.id === id) : -1;
            if (idx >= 0 && next[idx].kind === "assistant") {
              const t = next[idx] as Extract<Turn, { kind: "assistant" }>;
              next[idx] = { ...t, text: t.text + tok, streaming: true };
            } else {
              const nid = uid();
              streamingTurnId.current = nid;
              next.push({
                kind: "assistant",
                id: nid,
                text: tok,
                streaming: true,
              });
            }
            return next;
          });
        }
        return;
      }

      // full assistant message — finalize text + thinking, spawn tool cards
      case "assistant": {
        const blocks = ev.message?.content ?? [];
        // mark any in-flight thinking block as settled (its tokens are complete)
        const tid = thinkingTurnId.current;
        if (tid) {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === tid && t.kind === "thinking"
                ? {
                    ...t,
                    streaming: false,
                    durationMs:
                      t.startedAt != null ? Date.now() - t.startedAt : undefined,
                  }
                : t,
            ),
          );
        }
        for (const b of blocks) {
          // text fallback: claude streams text via content_block_delta tokens, so
          // the bubble is already built by the time this final message lands. But
          // engines without token-streaming (codex/opencode) emit ONLY the whole
          // message — so when no streaming bubble exists, render the text here.
          if (b.type === "text") {
            const full = (b.text ?? "").trim();
            if (full && streamingTurnId.current == null) {
              setTurns((prev) => [
                ...prev,
                { kind: "assistant", id: uid(), text: full, streaming: false },
              ]);
            }
          }
          // thinking fallback: if partial-message deltas didn't build a block
          // (e.g. replay or thinking arriving whole), synthesize one from text.
          if (b.type === "thinking") {
            const full = (b.thinking ?? "").trim();
            if (full && thinkingTurnId.current == null) {
              setTurns((prev) => [
                ...prev,
                { kind: "thinking", id: uid(), text: full, streaming: false },
              ]);
            }
          }
          if (b.type === "tool_use") {
            const toolId = b.id ?? uid();
            setTurns((prev) => {
              if (prev.some((t) => t.kind === "tool" && t.id === toolId)) {
                return prev;
              }
              return [
                ...prev,
                {
                  kind: "tool",
                  id: toolId,
                  name: b.name ?? "tool",
                  input: (b.input as Record<string, unknown>) ?? {},
                },
              ];
            });
          }
        }
        // step boundary: the next streamed text/thinking belongs to a fresh
        // block (so post-tool reasoning doesn't merge into the prior bubble).
        streamingTurnId.current = null;
        thinkingTurnId.current = null;
        return;
      }

      // tool_result arrives as a user message block referencing the tool_use id
      case "user": {
        const blocks = ev.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "tool_result") {
            const ref = b.tool_use_id;
            const text = resultToText(b.content);
            setTurns((prev) =>
              prev.map((t) =>
                t.kind === "tool" && t.id === ref
                  ? { ...t, result: text, isError: b.is_error }
                  : t,
              ),
            );
          }
        }
        return;
      }

      // final result for the turn → faint footer + close the streaming bubble
      case "result": {
        // mark the live assistant bubble done
        setTurns((prev) =>
          prev.map((t) => {
            if (t.kind === "assistant" && t.streaming)
              return { ...t, streaming: false };
            if (t.kind === "thinking" && t.streaming)
              return {
                ...t,
                streaming: false,
                durationMs:
                  t.startedAt != null ? Date.now() - t.startedAt : t.durationMs,
              };
            return t;
          }),
        );
        streamingTurnId.current = null;
        thinkingTurnId.current = null;
        setStreaming(false);
        // prefer claude's reported duration; fall back to our wall-clock measure
        const wall =
          turnStartRef.current != null ? Date.now() - turnStartRef.current : undefined;
        const durationMs =
          typeof ev.duration_ms === "number" ? ev.duration_ms : wall;
        turnStartRef.current = null;
        setLiveStart(null);
        const dur = durationMs != null ? fmtDuration(durationMs) : "";
        const costNum =
          typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined;
        if (costNum != null && costNum > 0) setSessionCost((c) => c + costNum);
        const cost = costNum != null ? `$${costNum.toFixed(4)}` : "";
        const tokens = tokensFromUsage(ev.usage);
        const tokStr =
          tokens != null ? `${tokens.toLocaleString()} tok` : "";
        // context size = the prompt the model saw this turn (input + cached
        // input). Drives the composer's running "Nk ctx" indicator, TUI-style.
        const u = (ev.usage ?? {}) as Record<string, unknown>;
        const ctx =
          (typeof u.input_tokens === "number" ? u.input_tokens : 0) +
          (typeof u.cache_read_input_tokens === "number"
            ? u.cache_read_input_tokens
            : 0) +
          (typeof u.cache_creation_input_tokens === "number"
            ? u.cache_creation_input_tokens
            : 0);
        if (ctx > 0) setCtxTokens(ctx);
        const foot = [dur, tokStr, cost].filter(Boolean).join(" · ");
        // always emit a result turn (carries durationMs for the activity line),
        // even if the human-readable footer would be empty.
        setTurns((prev) => [
          ...prev,
          { kind: "result", id: uid(), text: foot, cost: costNum, tokens, durationMs },
        ]);
        return;
      }

      // surface a backend stderr line (missing binary / not logged in / bad flag)
      case "aios_stderr": {
        if (ev.text) {
          setTurns((prev) => [
            ...prev,
            { kind: "result", id: uid(), text: `claude: ${ev.text}` },
          ]);
        }
        turnStartRef.current = null;
        setLiveStart(null);
        setStreaming(false);
        return;
      }

      // live usage tick (synthetic, from chat.rs) → move the composer's usage bar
      case "usage": {
        // Codex's app-server push can describe a model-specific CLI bucket. The
        // desktop usage panel uses /backend-api/wham/usage, so re-read that exact
        // account source instead of letting the push overwrite the visible meter.
        if ((ev.provider ?? "claude") === "codex") {
          void codexRate().then((r) => {
            rememberUsage("codex", {
              fiveHour: r.fiveHour,
              sevenDay: r.sevenDay,
            });
          });
          return;
        }
        const fh = ev.five_hour ?? {};
        const sd = ev.seven_day ?? {};
        rememberUsage(ev.provider ?? "claude", {
          fiveHour: { pct: fh.pct ?? null, resetsAt: fh.resets_at ?? null },
          sevenDay: { pct: sd.pct ?? null, resetsAt: sd.resets_at ?? null },
        });
        return;
      }

      // system init: not rendered, but carries claude's session_id — capture it
      // so the first user send can recordChatSession() into the /resume list.
      case "system": {
        if (ev.session_id) claudeSessionIdRef.current = ev.session_id;
        setClaudeReady(true);
        return;
      }

      // hooks / rate-limit / anything else → ignored in the transcript
      default:
        return;
    }
  }, [rememberUsage]);

  // ── session lifecycle: one channel + one session per mount ─────────────────
  // `restartKey` lets `/clear` tear down + re-spin the session without changing
  // any of the model/permission deps.
  const [restartKey, setRestartKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    setStarted(false);
    setClaudeReady(false);
    setCtxTokens(null);
    const chan = new Channel<string>();
    chan.onmessage = (line) => {
      if (disposed) return;
      let parsed: ChatEvent | null = null;
      try {
        parsed = JSON.parse(line) as ChatEvent;
      } catch {
        return; // ignore non-JSON noise
      }
      handleEvent(parsed);
    };

    // Reattach to a live backgrounded session (replays its buffer) vs spawn fresh.
    const startup =
      reattach != null
        ? chatReattach(reattach, chan).then(() => reattach)
        : chatStart(chan, {
            engine: model.engine ?? "claude",
            cwd: cwd ?? null,
            model: model.disabled ? null : model.id,
            permissionMode: permission.id,
            // ultracode isn't a real --effort value; run it as xhigh (the
            // "+ workflows" half is applied per-message via ULTRA_PREFIX).
            effort: effort.ultra ? "xhigh" : effort.id,
            resume: resumeId,
          });

    startup
      .then((id) => {
        if (disposed) {
          // only kill a freshly-spawned session we're abandoning; never a reattach.
          if (reattach == null) chatStop(id).catch(() => {});
          return;
        }
        sessionIdRef.current = id;
        setStarted(true);
      })
      .catch((err) => {
        if (!disposed) {
          setTurns((prev) => [
            ...prev,
            { kind: "result", id: uid(), text: `failed to start: ${err}` },
          ]);
        }
      });

    return () => {
      disposed = true;
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      // Skip the kill when the pane was intentionally detached (kept running in
      // the background) — chat_detach already cleared the sink.
      if (id != null && !detachedRef.current) chatStop(id).catch(() => {});
    };
    // model/permission/effort/resumeId are captured at start; changing them restarts the session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.id, permission.id, effort.id, cwd, restartKey, resumeId, reattach]);

  // Publish a close-handle so App can detach (keep running) vs kill a busy chat.
  useEffect(() => {
    if (!paneKey) return;
    chatHandles.set(paneKey, {
      busy: () => streamingRef.current,
      detach: (notify: boolean) => {
        const id = sessionIdRef.current;
        if (id != null) {
          detachedRef.current = true;
          chatDetach(id, notify).catch(() => {});
        }
      },
    });
    return () => {
      chatHandles.delete(paneKey);
    };
  }, [paneKey]);

  // Seed the usage bar once on mount (and on engine switch) so it shows BEFORE
  // the first turn ticks it — claude reads usage.json, codex reads logs_2.sqlite.
  // After this, live `usage` events keep it moving as you talk.
  useEffect(() => {
    let alive = true;
    const fn = model.engine === "codex" ? codexRate : idleRate;
    fn()
      .then((r) => {
        if (alive && (r.fiveHour.pct != null || r.sevenDay.pct != null)) {
          rememberUsage(model.engine ?? "claude", {
            fiveHour: r.fiveHour,
            sevenDay: r.sevenDay,
          });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [model.engine, rememberUsage]);

  // Queue flush: when a turn finishes (streaming → false) and messages are
  // queued, fire the next one. dispatch via a ref so this effect isn't a dep of
  // the (changing) dispatch closure. One per turn → the queue drains in order.
  const dispatchRef = useRef<(text: string) => void>(() => {});
  useEffect(() => {
    if (streaming) return;
    if (queuedRef.current.length === 0) return;
    if (sessionIdRef.current == null) return;
    const [next, ...rest] = queuedRef.current;
    setQueued(rest);
    setQueuedIdx((idx) => (rest.length === 0 ? 0 : Math.min(idx, rest.length - 1)));
    dispatchRef.current(next.text);
  }, [streaming]);

  // autoscroll on new content — but with a STICKY pause. The moment you scroll
  // up (wheel, scrollbar, touch) we stop yanking you down and hold there until
  // you ride back to the very bottom OR tap the "jump to latest" pill. Sticky is
  // the fix for the old behavior: a small up-scroll fell back inside the bottom
  // threshold and the next token re-pinned, so it felt like it ignored you.
  const pausedRef = useRef(false);
  // set just before we programmatically pin, so the scroll event our own pin
  // fires isn't misread as the user moving the viewport.
  const programmaticRef = useRef(false);
  const lastScrollHeightRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const setPaused = useCallback((p: boolean) => {
    pausedRef.current = p;
    setShowJump(p);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (
      el &&
      shouldAutoscroll(
        {
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
          clientHeight: el.clientHeight,
          previousScrollHeight: lastScrollHeightRef.current || undefined,
        },
        pausedRef.current,
      )
    ) {
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
    }
    lastScrollHeightRef.current = el?.scrollHeight ?? 0;
  }, [turns]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // swallow the one scroll event our own pin just emitted
      if (programmaticRef.current) {
        programmaticRef.current = false;
        return;
      }
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (dist < 8) setPaused(false); // rode back to the bottom → resume autoscroll
      else setPaused(true); // moved away from the bottom → pause (sticky)
      lastScrollHeightRef.current = el.scrollHeight;
    };
    // scrolling up = user taking the wheel → pause immediately, even before the
    // distance math catches up (mid-stream the content keeps growing below).
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) setPaused(true);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, [setPaused]);
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPaused(false);
  }, [setPaused]);

  // autosize textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [input]);

  // tick the live "Working… m:ss" timer once a second while a turn is in flight
  useEffect(() => {
    if (liveStart == null) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [liveStart]);

  // ── approval resolution ─────────────────────────────────────────────────────

  const resolveApproval = useCallback(
    (requestId: string, toolName: string, decision: ApprovalDecision) => {
      const id = sessionIdRef.current;
      if (id != null) {
        // chat.ts owns the exact control_response shape (buildApprovalLine).
        chatSendRaw(id, buildApprovalLine(requestId, decision, toolName)).catch(
          () => {},
        );
      }
      setTurns((prev) =>
        prev.map((t) =>
          t.kind === "approval" && t.requestId === requestId
            ? { ...t, decision }
            : t,
        ),
      );
    },
    [],
  );

  // ── submit ─────────────────────────────────────────────────────────────────

  // Sends an already-composed user line to claude. `display` is what shows in
  // the transcript (the raw text the user typed); `wire` is what claude receives
  // (display + any plan / goal prefixes). Regenerate replays the same display.
  const dispatch = useCallback(
    (display: string, opts?: { skipUserBubble?: boolean; wirePrefix?: string }) => {
      const id = sessionIdRef.current;
      if (id == null) return;
      const shellContext = buildAiosShellContext({
        cwd,
        paneKey,
        attachedMemoryCount: attachedMemories.length,
      });
      let wire = shellContext + (opts?.wirePrefix ?? "") + display;
      if (goal.trim()) wire = GOAL_PREFIX(goal.trim()) + wire;
      if (planMode) wire = PLAN_PREFIX + wire;
      if (effort.ultra) wire = ULTRA_PREFIX + wire;
      lastSentRef.current = display;
      // feed the autocomplete history (dedup, newest first, capped).
      if (display.trim()) {
        try {
          const h = [display, ...historyRef.current.filter((x) => x !== display)].slice(0, 200);
          historyRef.current = h;
          localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
        } catch {
          /* ignore */
        }
      }
      if (!opts?.skipUserBubble) {
        setTurns((prev) => [...prev, { kind: "user", id: uid(), text: display }]);
      }
      setStreaming(true);
      streamingTurnId.current = null;
      thinkingTurnId.current = null;
      // start the turn timer (drives "Working… m:ss" → "Worked for Xs")
      const t0 = Date.now();
      turnStartRef.current = t0;
      setLiveStart(t0);
      setNow(t0);
      // plan-mode is a per-message instruction; clear it after firing
      if (planMode) setPlanMode(false);
      chatSend(id, wire).catch((err) => {
        setTurns((prev) => [
          ...prev,
          { kind: "result", id: uid(), text: `send failed: ${err}` },
        ]);
        setStreaming(false);
      });
    },
    [goal, planMode, effort.ultra, cwd, paneKey, attachedMemories.length],
  );
  // keep the flush effect calling the latest dispatch closure
  dispatchRef.current = dispatch;

  // Queue a message instead of sending it (used while a turn is streaming). It
  // fires automatically when the current turn completes (see the flush effect).
  const enqueue = useCallback((raw: string) => {
    setQueued((items) => {
      const next = queueMessage(items, raw);
      setQueuedIdx(next.selected);
      return next.items;
    });
    setInput("");
    setOverlay(null);
  }, []);

  const removeQueued = useCallback((id: string) => {
    setQueued((items) => {
      const next = removeQueuedMessage({ items, selected: queuedIdx }, id);
      setQueuedIdx(next.selected);
      return next.items;
    });
    if (editingQueuedId === id) {
      setEditingQueuedId(null);
      setEditingQueuedText("");
    }
  }, [queuedIdx, editingQueuedId]);

  const editQueued = useCallback((item: QueuedMessage) => {
    setEditingQueuedId(item.id);
    setEditingQueuedText(item.text);
  }, []);

  const saveQueuedEdit = useCallback(() => {
    const id = editingQueuedId;
    if (!id) return;
    setQueued((items) => {
      const next = updateQueuedMessage(
        { items, selected: queuedIdx },
        id,
        editingQueuedText,
      );
      setQueuedIdx(next.selected);
      return next.items;
    });
    setEditingQueuedId(null);
    setEditingQueuedText("");
  }, [editingQueuedId, editingQueuedText, queuedIdx]);

  const moveQueued = useCallback((id: string, delta: number) => {
    setQueued((items) => {
      const next = moveQueuedMessage({ items, selected: queuedIdx }, id, delta);
      setQueuedIdx(next.selected);
      return next.items;
    });
  }, [queuedIdx]);

  // Explicitly inject one highlighted pending message into a live codex turn.
  // If the backend cannot steer yet, leave it queued so normal auto-send wins.
  const steerQueued = useCallback(
    (queuedId: string) => {
      const item = queuedRef.current.find((q) => q.id === queuedId);
      if (!item || model.engine !== "codex") return;
      const id = sessionIdRef.current;
      if (id == null) return;
      chatSteer(id, item.text)
        .then(() => {
          removeQueued(queuedId);
          setTurns((prev) => [...prev, { kind: "user", id: uid(), text: item.text, steered: true }]);
        })
        .catch(() => {}); // no active turn yet → keep queued for automatic send
    },
    [model.engine, removeQueued],
  );

  // Send an explicit string (used by send() with the composer text, and by the
  // external "send to AI" submitter which passes the note body directly so it
  // doesn't race the input state).
  const sendText = useCallback(
    (raw: string) => {
      const text = raw.trim();
      // attached images go in as quoted temp paths the model can read; allow a
      // send with images even when the text is empty.
      const imgPaths = images
        .filter((im) => im.path)
        .map((im) => quotePath(im.path as string));
      if ((!text && imgPaths.length === 0) || streaming || sessionIdRef.current == null)
        return;
      // Claude keeps its original first-message labels. Codex starts with a
      // provisional label for low-signal openers, then promotes the first real
      // request into a compact stable topic.
      const engine = model.engine ?? "claude";
      const suggested = resumeTitle(text, engine);
      const firstRecord = !recordedRef.current;
      const promoteCodex =
        engine === "codex" && !codexTitleLockedRef.current && suggested.meaningful;
      const sid = claudeSessionIdRef.current;
      if (sid && (firstRecord || promoteCodex)) {
        if (firstRecord) recordedRef.current = true;
        if (promoteCodex) codexTitleLockedRef.current = true;
        recordChatSession(sid, suggested.title, cwd ?? null, engine, model.id).catch(() => {
          // failed to persist → allow a later send to retry
          if (firstRecord) recordedRef.current = false;
          if (promoteCodex) codexTitleLockedRef.current = false;
        });
        // Label the backend session for the background tray + done-notification.
        if (sessionIdRef.current != null)
          chatSetTitle(sessionIdRef.current, suggested.title).catch(() => {});
      }
      setInput("");
      setImages((prev) => {
        prev.forEach((im) => URL.revokeObjectURL(im.url));
        return [];
      });
      setOverlay(null);
      const attachedMemoryBlock = memoryContextBlock(attachedMemories);
      setAttachedMemoryIds([]);
      // prepend the image paths so the model sees them with the message
      const full = imgPaths.length
        ? imgPaths.join(" ") + (text ? " " + text : "")
        : text;
      dispatch(full, { wirePrefix: attachedMemoryBlock });
    },
    [streaming, dispatch, cwd, images, model, attachedMemories],
  );

  const send = useCallback(() => sendText(input), [sendText, input]);

  const steerDraft = useCallback(() => {
    const text = input.trim();
    const id = sessionIdRef.current;
    if (!text || model.engine !== "codex" || id == null) return;
    chatSteer(id, text)
      .then(() => {
        setTurns((prev) => [...prev, { kind: "user", id: uid(), text, steered: true }]);
        setInput("");
        setOverlay(null);
      })
      .catch(() => enqueue(text));
  }, [input, model.engine, enqueue]);

  // Keep a fresh ref to sendText so the external submitter (registered once per
  // paneKey) always calls the latest closure without re-registering.
  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;

  // ── launcher seed: auto-send as the first turn ─────────────────────────────
  // The idle page hands over the prompt you typed as `seed`; fire it once the
  // session is live (started) and claude's init has landed (claudeReady, so the
  // chat records into /resume) — so the text you typed on the idle page IS the
  // first message. No "type once to launch, type again to send".
  useEffect(() => {
    if (!seed || seedSentRef.current) return;
    if (!started || !claudeReady) return;
    seedSentRef.current = true;
    send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, started, claudeReady]);

  // regenerate: replay the last user turn (no extra user bubble)
  const regenerate = useCallback(() => {
    const last = lastSentRef.current;
    if (!last || streaming || sessionIdRef.current == null) return;
    dispatch(last, { skipUserBubble: true });
  }, [streaming, dispatch]);

  // true interrupt of the in-flight turn (process survives)
  const stop = useCallback(() => {
    const id = sessionIdRef.current;
    if (id == null) return;
    chatInterrupt(id)
      .catch(() => {})
      .finally(() => setStreaming(false));
  }, []);

  // hard reset: clear transcript + re-spin a FRESH claude session (drops any
  // resume id, so a new chat / /clear never keeps continuing a past session).
  const clearSession = useCallback(() => {
    setTurns([]);
    setRunEventState(emptyRunEventState());
    setStreaming(false);
    streamingTurnId.current = null;
    thinkingTurnId.current = null;
    lastSentRef.current = null;
    turnStartRef.current = null;
    setLiveStart(null);
    setInput("");
    setOverlay(null);
    setQueued([]);
    setQueuedIdx(0);
    setSessionCost(0);
    usageBaselineRef.current = {};
    setResumeId(null);
    setResumedTitle(null);
    // fresh chat → forget the prior session id + recording flag so the next
    // first-send records a brand-new /resume entry (not the old one).
    claudeSessionIdRef.current = null;
    recordedRef.current = false;
    codexTitleLockedRef.current = false;
    setRestartKey((k) => k + 1);
  }, []);

  // ── /resume: reopen a past chat session ────────────────────────────────────
  // Loads the chat-only session list (lazy, on picker open). On selection we
  // OPEN the conversation: repaint its past user/assistant turns from the saved
  // transcript so the user SEES it, THEN re-spin the claude process with that
  // resume id so the next message continues it. Reuses the same restart
  // mechanism as /clear — but `resumeId` (an effect dep) carries forward and the
  // turns are the rehydrated transcript instead of empty.
  const loadResumeSessions = useCallback(async () => {
    setResumeLoading(true);
    try {
      const sessions = await listChatSessions(40);
      setResumeSessions(sessions);
    } catch {
      setResumeSessions([]);
    } finally {
      setResumeLoading(false);
    }
  }, []);

  /** Map saved transcript turns into the live transcript model (static bubbles). */
  const transcriptToTurns = useCallback((rows: ChatTurnInfo[]): Turn[] => {
    return rows.map((r) =>
      r.role === "user"
        ? { kind: "user", id: uid(), text: r.text }
        : { kind: "assistant", id: uid(), text: r.text, streaming: false },
    );
  }, []);

  const resumeSession = useCallback(
    (session: ChatSessionInfo) => {
      // reset turn/stream bookkeeping; mark as already-recorded (it's in the
      // list), set the resume id (→ effect re-spins claude with --resume), and
      // remember the new claude session id so a future first-send doesn't
      // re-record it.
      setStreaming(false);
      streamingTurnId.current = null;
      thinkingTurnId.current = null;
      lastSentRef.current = null;
      turnStartRef.current = null;
      setLiveStart(null);
      setInput("");
      setOverlay(null);
      setResumeQuery("");
      claudeSessionIdRef.current = session.id;
      recordedRef.current = true;
      codexTitleLockedRef.current = true;
      const resumeModel =
        CHAT_MODELS.find((m) => session.model && m.id === session.model) ??
        CHAT_MODELS.find((m) => (m.engine ?? "claude") === (session.engine || "claude"));
      if (resumeModel) setModel(resumeModel);
      setResumeId(session.id);
      setResumedTitle(session.title);
      // show the past conversation immediately while claude re-spins. Paint a
      // placeholder first, then swap in the real transcript when it loads (the
      // session-restart effect never clears `turns`, so this is safe).
      setTurns([]);
      setRunEventState(emptyRunEventState());
      readChatTranscript(session.id)
        .then((rows) => {
          if (rows.length) setTurns(transcriptToTurns(rows));
        })
        .catch(() => {
          // transcript unavailable → leave the pane empty but still resumable
        });
      // bump restartKey too so re-picking the SAME session still re-spins
      setRestartKey((k) => k + 1);
    },
    [transcriptToTurns],
  );

  // ── slash + @ overlays ─────────────────────────────────────────────────────

  const slashCommands = useMemo<SlashCommand[]>(
    () => [
      {
        id: "clear",
        label: "/clear",
        desc: "reset transcript + restart session",
        icon: <RefreshCw size={14} />,
        run: () => {
          clearSession();
        },
      },
      {
        id: "plan",
        label: "/plan",
        desc: "plan-first on the next message",
        icon: <ListChecks size={14} />,
        run: () => {
          setPlanMode(true);
          setInput("");
          setOverlay(null);
        },
      },
      {
        id: "goal",
        label: "/goal",
        desc: "set an ongoing goal (prepended each turn)",
        icon: <Target size={14} />,
        run: () => {
          setOverlay(null);
          setInput("");
          const next = window.prompt(
            "pursue goal — prepended as context each turn until cleared:",
            goal,
          );
          if (next != null) setGoal(next.trim());
        },
      },
      {
        id: "resume",
        label: "/resume",
        desc: "reopen a past conversation",
        icon: <History size={14} />,
        run: () => {
          setInput("");
          setResumeQuery("");
          setOverlay("resume");
          setOverlayIdx(0);
          void loadResumeSessions();
          // focus the picker's search box after it mounts
          setTimeout(() => resumeSearchRef.current?.focus(), 0);
        },
      },
      {
        id: "model",
        label: "/model",
        desc: "switch the model",
        icon: <Sparkles size={14} />,
        run: () => {
          setInput("");
          setOverlay(null);
          setOpenMenu("model");
        },
      },
      {
        id: "handoff",
        label: "/handoff",
        desc: "package this session for a fresh one",
        icon: <PackageOpen size={14} />,
        run: () => {
          setInput("");
          setOverlay(null);
          sendText("/handoff");
        },
      },
      {
        id: "help",
        label: "/help",
        desc: "what can this do",
        icon: <HelpCircle size={14} />,
        run: () => {
          setInput("");
          setOverlay(null);
          setTurns((prev) => [
            ...prev,
            {
              kind: "assistant",
              id: uid(),
              streaming: false,
              text: HELP_TEXT,
            },
          ]);
        },
      },
    ],
    [clearSession, loadResumeSessions, sendText, goal],
  );

  // load dir entries for the @-mention picker (lazy, on first open)
  const loadMentions = useCallback(async () => {
    const root = cwd;
    if (!root) {
      setMentionItems([]);
      return;
    }
    try {
      const entries = await readDir(root);
      // dirs first, then files; cap to keep the popover tight
      entries.sort((a, b) =>
        a.is_dir === b.is_dir
          ? a.name.localeCompare(b.name)
          : a.is_dir
            ? -1
            : 1,
      );
      setMentionItems(entries.slice(0, 200));
    } catch {
      setMentionItems([]);
    }
  }, [cwd]);

  // detect `/` at start or `@…` token under the caret, drive the overlay
  const syncOverlay = useCallback(
    (value: string) => {
      // slash menu: only when the whole composer starts with a lone `/word`
      if (/^\/[a-z]*$/i.test(value)) {
        setOverlay("slash");
        setOverlayIdx(0);
        return;
      }
      // @-mention: last token before caret begins with @
      const m = value.match(/(?:^|\s)@([^\s]*)$/);
      if (m) {
        setMentionQuery(m[1] ?? "");
        if (overlay !== "mention") {
          setOverlay("mention");
          setOverlayIdx(0);
          void loadMentions();
        }
        return;
      }
      if (overlay) setOverlay(null);
    },
    [overlay, loadMentions],
  );

  const onChangeInput = (value: string) => {
    setInput(value);
    syncOverlay(value);
  };

  // filtered views for the active overlay
  const slashFiltered = useMemo(() => {
    const q = input.replace(/^\//, "").toLowerCase();
    return slashCommands.filter((c) => c.id.startsWith(q) || q === "");
  }, [input, slashCommands]);

  const mentionFiltered = useMemo(() => {
    const q = mentionQuery.toLowerCase();
    if (!q) return mentionItems;
    return mentionItems.filter((e) => e.name.toLowerCase().includes(q));
  }, [mentionItems, mentionQuery]);

  const resumeFiltered = useMemo(() => {
    const q = resumeQuery.trim().toLowerCase();
    if (!q) return resumeSessions;
    return resumeSessions.filter((s) =>
      [s.title, s.cwd, s.engine, s.model, s.id]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [resumeSessions, resumeQuery]);

  // keep the /resume highlight in-bounds as the typed filter shrinks the list
  useEffect(() => {
    if (overlay !== "resume") return;
    setOverlayIdx((i) =>
      resumeFiltered.length === 0 ? 0 : Math.min(i, resumeFiltered.length - 1),
    );
  }, [resumeFiltered.length, overlay]);

  const pickSlash = useCallback(
    (cmd: SlashCommand) => {
      cmd.run();
    },
    [],
  );

  const pickMention = useCallback(
    (entry: DirEntry) => {
      const insert = entry.is_dir ? `${entry.name}/` : entry.name;
      setInput((v) => v.replace(/(^|\s)@([^\s]*)$/, `$1@${insert} `));
      setOverlay(null);
      taRef.current?.focus();
    },
    [],
  );

  const closeResume = useCallback(() => {
    setOverlay(null);
    setResumeQuery("");
    taRef.current?.focus();
  }, []);

  // keyboard for the /resume picker (driven from its own search input)
  const onResumeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const list = resumeFiltered;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setOverlayIdx((i) => (list.length ? (i + 1) % list.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setOverlayIdx((i) =>
          list.length ? (i - 1 + list.length) % list.length : 0,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (list.length) resumeSession(list[overlayIdx] ?? list[0]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeResume();
      }
    },
    [resumeFiltered, overlayIdx, resumeSession, closeResume],
  );

  // ── keyboard ─────────────────────────────────────────────────────────────────

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // overlay navigation takes priority. (the /resume picker drives its own
    // keyboard from its search input — see onResumeKeyDown — so it's excluded
    // here; this branch handles the inline slash + @ overlays.)
    if (overlay && overlay !== "resume") {
      const list = overlay === "slash" ? slashFiltered : mentionFiltered;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setOverlayIdx((i) => (list.length ? (i + 1) % list.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setOverlayIdx((i) =>
          list.length ? (i - 1 + list.length) % list.length : 0,
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOverlay(null);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (list.length) {
          e.preventDefault();
          if (overlay === "slash") pickSlash(slashFiltered[overlayIdx]);
          else pickMention(mentionFiltered[overlayIdx]);
          return;
        }
      }
    }
    // Pending steer list behaves like the slash menu: arrows choose a queued
    // follow-up, then Enter injects the highlighted row into a live codex turn.
    if (streaming && input.trim() === "" && queued.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setQueuedIdx((idx) =>
          cycleQueueSelection(idx, queued.length, e.key === "ArrowDown" ? 1 : -1),
        );
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const item = queued[queuedIdx] ?? queued[0];
        if (item) steerQueued(item.id);
        return;
      }
    }
    // copilot-style ghost accept: Tab, or → when the caret is at the very end.
    if (!overlay && ghostRef.current) {
      const ta = taRef.current;
      const atEnd = ta != null && ta.selectionStart === input.length && ta.selectionStart === ta.selectionEnd;
      if (e.key === "Tab" || (e.key === "ArrowRight" && atEnd)) {
        e.preventDefault();
        acceptGhost();
        return;
      }
    }
    // ↑ on an EMPTY composer recalls the last sent message for quick edit/resend
    // (TUI staple). Empty-only so it never fights normal cursor movement.
    if (
      e.key === "ArrowUp" &&
      !overlay &&
      input.trim() === "" &&
      lastSentRef.current
    ) {
      e.preventDefault();
      const recalled = lastSentRef.current;
      setInput(recalled);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(recalled.length, recalled.length);
        }
      });
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // mid-turn Enter is explicit now: Codex steers the active turn; engines
      // without true steering queue the follow-up for the next turn.
      if (streaming) {
        if (model.engine === "codex") steerDraft();
        else enqueue(input);
      }
      else send();
    }
  };

  const hasDraft = input.trim().length > 0;
  const hasReadyImages = images.some((im) => im.path);
  const action = sendContract({
    streaming,
    hasDraft,
    hasImages: hasReadyImages,
    engine: model.engine ?? "claude",
    started,
  });
  const contextChips = composerContextChips({
    cwd,
    modelLabel: model.label,
    effortLabel: effort.label,
    permissionLabel: permission.label,
    engine: model.engine ?? "claude",
    queuedCount: queued.length,
    imageCount: images.length,
    planMode,
    hasGoal: Boolean(goal.trim()),
  });
  const runPhase = runEventState.phase;
  const runEventCount = runEventState.events.length;

  // copilot-style ghost: the remainder of the most recent past message that
  // prefixes what's typed. Suppressed while an overlay (slash/@/resume) or voice
  // is active, or on a multi-line draft. Recomputed each keystroke (input dep).
  const ghost = useMemo(() => {
    if (!input || overlay || recording || input.includes("\n")) return "";
    const lc = input.toLowerCase();
    const hit = historyRef.current.find(
      (e) => e.length > input.length && e.toLowerCase().startsWith(lc),
    );
    return hit ? hit.slice(input.length) : "";
  }, [input, overlay, recording]);
  const ghostRef = useRef("");
  ghostRef.current = ghost;
  const acceptGhost = useCallback(() => {
    if (ghostRef.current) setInput((v) => v + ghostRef.current);
  }, []);

  // ── composer (shared between empty hero + docked) ──────────────────────────

  const composer = useMemo(
    () => (
      <div className="relative">
        {/* context contract: what this send will use, before the user fires it. */}
        {contextChips.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {contextChips.map((chip) => (
              <span
                key={chip.id}
                className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[11.5px] ${
                  chip.id === "plan" || chip.id === "goal"
                    ? "border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] text-[var(--color-text)]"
                    : "border-[var(--color-border-strong)] bg-[var(--color-panel)]/70 text-[var(--color-text-2)]"
                }`}
                title={chip.label}
              >
                {chip.id === "cwd" ? (
                  <Folder size={12} className="shrink-0 text-[var(--color-accent)]" />
                ) : chip.id === "engine" ? (
                  <Terminal size={12} className="shrink-0 text-[var(--color-muted)]" />
                ) : chip.id === "attachments" ? (
                  <ImageIcon size={12} className="shrink-0 text-[var(--color-accent)]" />
                ) : chip.id === "queue" ? (
                  <Waypoints size={12} className="shrink-0 text-[var(--color-accent)]" />
                ) : chip.id === "plan" ? (
                  <ListChecks size={12} className="shrink-0 text-[var(--color-accent)]" />
                ) : chip.id === "goal" ? (
                  <Target size={12} className="shrink-0 text-[var(--color-accent)]" />
                ) : null}
                <span className="truncate">{chip.label}</span>
                {chip.id === "plan" && (
                  <button
                    type="button"
                    onClick={() => setPlanMode(false)}
                    className="ml-0.5 rounded-full p-0.5 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                    title="cancel plan mode"
                  >
                    <X size={11} />
                  </button>
                )}
                {chip.id === "goal" && (
                  <button
                    type="button"
                    onClick={() => setGoal("")}
                    className="ml-0.5 rounded-full p-0.5 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                    title="clear goal"
                  >
                    <X size={11} />
                  </button>
                )}
              </span>
            ))}
            {runEventCount > 0 && (
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-panel)]/70 px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text-2)]">
                <Waypoints size={12} className="shrink-0 text-[var(--color-accent)]" />
                <span className="truncate">run: {runPhase}</span>
              </span>
            )}
            {attachedMemories.length > 0 && (
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text)]">
                <Brain size={12} className="shrink-0 text-[var(--color-accent)]" />
                <span className="truncate">{attachedMemories.length} memories attached</span>
              </span>
            )}
          </div>
        )}

        {memoryHits.length > 0 && input.trim().length >= 4 && (
          <div className="mb-2 flex max-h-24 flex-col gap-1 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]/70 p-1.5">
            {memoryHits.slice(0, 3).map((hit) => {
              const attached = attachedMemoryIds.includes(hit.id);
              return (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() =>
                    setAttachedMemoryIds((ids) =>
                      attached ? ids.filter((id) => id !== hit.id) : [...ids, hit.id],
                    )
                  }
                  className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left font-sans text-[11.5px] transition-colors ${
                    attached
                      ? "bg-[var(--color-accent-soft)] text-[var(--color-text)]"
                      : "text-[var(--color-text-2)] hover:bg-[var(--color-panel-2)]"
                  }`}
                  title={hit.reasons.join("; ")}
                >
                  <Brain size={12} className="shrink-0 text-[var(--color-accent)]" />
                  <span className="min-w-0 flex-1 truncate">
                    {hit.title}{" "}
                    <span className="text-[var(--color-faint)]">· {hit.description || hit.preview}</span>
                  </span>
                  <span className="shrink-0 rounded border border-[var(--color-border)] px-1 py-0.5 font-mono text-[9px] text-[var(--color-faint)]">
                    {attached ? "attached" : hit.score}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* slash / @-mention overlay */}
        {overlay === "slash" && slashFiltered.length > 0 && (
          <OverlayPanel compact>
            {slashFiltered.map((c, i) => (
              <OverlayRow
                key={c.id}
                active={i === overlayIdx}
                onMouseEnter={() => setOverlayIdx(i)}
                onClick={() => pickSlash(c)}
                icon={c.icon}
                label={c.label}
                desc={c.desc}
              />
            ))}
          </OverlayPanel>
        )}
        {overlay === "mention" && (
          <OverlayPanel>
            {!cwd ? (
              <div className="px-3 py-2 font-mono text-[11.5px] text-[var(--color-faint)]">
                no working directory for this pane
              </div>
            ) : mentionFiltered.length === 0 ? (
              <div className="px-3 py-2 font-mono text-[11.5px] text-[var(--color-faint)]">
                no matches in {baseName(cwd)}
              </div>
            ) : (
              mentionFiltered
                .slice(0, 50)
                .map((e, i) => (
                  <OverlayRow
                    key={e.path}
                    active={i === overlayIdx}
                    onMouseEnter={() => setOverlayIdx(i)}
                    onClick={() => pickMention(e)}
                    icon={
                      e.is_dir ? (
                        <Folder size={14} className="text-[var(--color-accent)]" />
                      ) : (
                        <FileText size={14} className="text-[var(--color-muted)]" />
                      )
                    }
                    label={e.name}
                    desc={e.is_dir ? "dir" : ""}
                    mono
                  />
                ))
            )}
          </OverlayPanel>
        )}
        {overlay === "resume" && (
          <ResumePicker
            sessions={resumeFiltered}
            total={resumeSessions.length}
            loading={resumeLoading}
            query={resumeQuery}
            activeIdx={overlayIdx}
            searchRef={resumeSearchRef}
            onQueryChange={setResumeQuery}
            onKeyDown={onResumeKeyDown}
            onHover={setOverlayIdx}
            onPick={resumeSession}
            onClose={closeResume}
          />
        )}

        <div className="flash-composer relative rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)]/70 shadow-2xl shadow-black/40 backdrop-blur transition-colors focus-within:border-[var(--color-accent)]/50">
          {/* attached-image thumbnails (paste a screenshot / + attach) */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {images.map((im) => (
                <div
                  key={im.id}
                  className="group relative h-14 w-14 overflow-hidden rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-panel)]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={im.url} alt="" className="h-full w-full object-cover" />
                  {im.path == null && (
                    <div className="absolute inset-0 grid place-items-center bg-[var(--color-bg)]/60">
                      <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeImage(im.id)}
                    className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-[var(--color-bg)]/80 text-[var(--color-muted)] opacity-0 transition-opacity hover:text-[var(--color-text)] group-hover:opacity-100"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={imgInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              if (files) for (const f of files) void addImage(f, f.type);
              e.target.value = "";
            }}
          />
          <style>{WAVE_KEYFRAMES}</style>
          {recording ? (
            <div className="flex items-center gap-3 px-4 pt-4 pb-2">
              <div className="flex h-7 flex-1 items-center gap-[3px] overflow-hidden">
                {WAVEFORM_BARS.map((b, i) => (
                  <span
                    key={i}
                    className="w-[3px] shrink-0 origin-center rounded-full bg-[var(--color-accent)]"
                    style={{
                      height: `${b.h}%`,
                      animation: "aios-wave 0.9s ease-in-out infinite",
                      animationDelay: `${b.delay}ms`,
                    }}
                  />
                ))}
              </div>
              <span className="font-mono text-[12px] tabular-nums text-[var(--color-text)]">
                {fmtElapsed(voiceElapsed)}
              </span>
              <button
                type="button"
                onClick={() => void micStop()}
                title="stop dictation (esc to cancel)"
                className="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-accent)] text-[var(--color-bg)] transition-colors hover:bg-[var(--color-accent-hover)]"
              >
                <Square size={14} className="fill-current" />
              </button>
            </div>
          ) : (
            <div className="relative">
              {/* copilot-style ghost suggestion: a mirror layer behind the
                  textarea reserves the typed text (transparent) then renders the
                  remaining suggestion dimmed, so it lines up exactly after the
                  caret. Tab / → accepts. Same box model as the textarea. */}
              {ghost && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-5 pt-4 pb-2 font-sans text-[15px] leading-relaxed text-transparent"
                >
                  {input}
                  <span className="text-[var(--color-faint)]">{ghost}</span>
                </div>
              )}
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => onChangeInput(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPasteImage}
                rows={1}
                placeholder={
                  streaming
                    ? model.engine === "codex"
                      ? "steer the model… (won't interrupt)"
                      : "queue a follow-up…"
                    : planMode
                      ? "describe the task to plan…"
                      : "do anything"
                }
                spellCheck={false}
                className="relative block w-full resize-none bg-transparent px-5 pt-4 pb-2 font-sans text-[15px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3 pt-1">
            {/* permission chip */}
            <Dropdown
              open={openMenu === "perm"}
              onToggle={() => setOpenMenu(openMenu === "perm" ? null : "perm")}
              trigger={
                <>
                  <Plus size={14} className="text-[var(--color-muted)]" />
                  <span>{permission.label}</span>
                  <ChevronDown size={12} className="text-[var(--color-faint)]" />
                </>
              }
            >
              {PERMISSION_MODES.map((p) => (
                <MenuItem
                  key={p.id}
                  active={p.id === permission.id}
                  onClick={() => {
                    setPermission(p);
                    setOpenMenu(null);
                  }}
                >
                  {p.label}
                </MenuItem>
              ))}
            </Dropdown>

            {/* effort */}
            <Dropdown
              open={openMenu === "effort"}
              onToggle={() => setOpenMenu(openMenu === "effort" ? null : "effort")}
              triggerClassName={
                effort.ultra
                  ? "aios-ultra flex items-center gap-1.5 rounded-full px-2.5 py-1 font-sans text-[11.5px] font-semibold"
                  : undefined
              }
              trigger={
                <>
                  {effort.ultra && <Sparkles size={12} className="shrink-0" />}
                  <span>{effort.label}</span>
                  <ChevronDown
                    size={12}
                    className={effort.ultra ? "text-white/80" : "text-[var(--color-faint)]"}
                  />
                </>
              }
            >
              {EFFORTS.map((ef) =>
                ef.ultra ? (
                  <button
                    key={ef.id}
                    type="button"
                    onClick={() => {
                      setEffort(ef);
                      setOpenMenu(null);
                    }}
                    className={`group/ultra flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                      ef.id === effort.id ? "bg-[var(--color-panel)]" : "hover:bg-[var(--color-panel)]"
                    }`}
                  >
                    <Sparkles size={13} className="shrink-0 text-[#a855f7]" />
                    <span className="flex min-w-0 flex-col">
                      <span className="aios-ultra-text font-sans text-[12px] font-semibold">
                        {ef.label}
                      </span>
                      {ef.sub && (
                        <span className="font-mono text-[9.5px] text-[var(--color-faint)]">{ef.sub}</span>
                      )}
                    </span>
                  </button>
                ) : (
                  <MenuItem
                    key={ef.id}
                    active={ef.id === effort.id}
                    onClick={() => {
                      setEffort(ef);
                      setOpenMenu(null);
                    }}
                  >
                    {ef.label}
                  </MenuItem>
                ),
              )}
            </Dropdown>

            {/* plan + goal moved off the bar (use /plan, /goal) to keep it sleek;
                their active state still shows as a chip above the composer. */}

            {/* right action cluster — pinned right (ml-auto), stays together and
                wraps to its own line on a narrow pane so send is never clipped */}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setResumeQuery("");
                setOverlay("resume");
                setOverlayIdx(0);
                void loadResumeSessions();
                setTimeout(() => resumeSearchRef.current?.focus(), 0);
              }}
              className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
              title="resume codex/chatpane session"
            >
              <History size={16} />
            </button>
            {/* model selector (right) */}
            <Dropdown
              open={openMenu === "model"}
              onToggle={() => setOpenMenu(openMenu === "model" ? null : "model")}
              align="right"
              trigger={
                <>
                  <span className="whitespace-nowrap">{model.label}</span>
                  <ChevronDown size={12} className="text-[var(--color-faint)]" />
                </>
              }
            >
              {CHAT_MODELS.map((m) => (
                <MenuItem
                  key={m.id}
                  active={m.id === model.id}
                  disabled={m.disabled}
                  title={m.note}
                  onClick={() => {
                    if (m.disabled) return;
                    setModel(m);
                    // picking a model sets it as the global default (sticks
                    // across panes + restarts). engine omitted = claude.
                    saveSettings({
                      chatModel: m.id,
                      chatProvider: `${m.engine ?? "claude"}-cli`,
                    });
                    setOpenMenu(null);
                  }}
                >
                  <span className="flex items-center gap-2">
                    {m.label}
                    {m.disabled && m.note && (
                      <span className="rounded bg-[var(--color-panel)] px-1.5 py-0.5 text-[10px] text-[var(--color-faint)]">
                        {m.note}
                      </span>
                    )}
                  </span>
                </MenuItem>
              ))}
            </Dropdown>

            {/* attach image (or paste a screenshot / drag a file in) */}
            <button
              type="button"
              onClick={() => imgInputRef.current?.click()}
              className={`grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] ${
                savingImg ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"
              }`}
              title="attach image (or ⌘V a screenshot)"
            >
              <ImageIcon size={16} />
            </button>

            {/* mic — click to dictate (waveform takes over the input row while
                recording; this shows idle / transcribing) */}
            {voicePhase === "transcribing" ? (
              <div className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-accent)]">
                <Loader2 size={16} className="animate-spin" />
              </div>
            ) : !recording ? (
              <button
                type="button"
                onClick={() => void micStart()}
                className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-muted)] transition-all duration-200 hover:scale-110 hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] hover:shadow-[0_0_14px_-3px_var(--color-accent)]"
                title="dictate (⌘J)"
              >
                <Mic size={16} />
              </button>
            ) : null}

            {/* send / steer / queue / stop. The label is the contract. */}
            {streaming ? (
              <>
                {hasDraft && (
                  <button
                    type="button"
                    onClick={() => {
                      if (action.mode === "steer") steerDraft();
                      else enqueue(input);
                    }}
                    disabled={action.disabled}
                    className="flex h-8 items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-3 text-[12px] font-medium text-[var(--color-bg)] transition-all hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-panel)] disabled:text-[var(--color-faint)]"
                    title={action.title}
                  >
                    {action.mode === "steer" ? <Waypoints size={14} /> : <Clock size={14} />}
                    {action.label}
                  </button>
                )}
                <button
                  type="button"
                  onClick={stop}
                  className="flex h-8 items-center gap-1.5 rounded-full bg-[var(--color-danger)] px-3 text-[12px] font-medium text-[var(--color-bg)] transition-all hover:opacity-90"
                  title="interrupt active run"
                >
                  <Square size={13} className="fill-current" />
                  stop
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={action.disabled}
                className="flex h-8 items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-3 text-[12px] font-medium text-[var(--color-bg)] transition-all hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-panel)] disabled:text-[var(--color-faint)]"
                title={action.title}
              >
                <ArrowUp size={16} />
                {action.label}
              </button>
            )}
            </div>
          </div>
        </div>
      </div>
    ),
    // re-render composer on the inputs that affect it
    // (images: chip row + attach-button state)
    [
      input,
      ghost,
      openMenu,
      permission,
      effort,
      model,
      ctxTokens,
      images,
      voicePhase,
      voiceElapsed,
      streaming,
      action,
      contextChips,
      memoryHits,
      attachedMemoryIds,
      attachedMemories,
      hasDraft,
      send,
      stop,
      enqueue,
      queued,
      queuedIdx,
      editingQueuedId,
      editingQueuedText,
      editQueued,
      saveQueuedEdit,
      moveQueued,
      steerQueued,
      steerDraft,
      planMode,
      goal,
      overlay,
      overlayIdx,
      slashFiltered,
      mentionFiltered,
      cwd,
      pickSlash,
      pickMention,
      resumeFiltered,
      resumeSessions.length,
      resumeLoading,
      resumeQuery,
      loadResumeSessions,
      onResumeKeyDown,
      resumeSession,
      closeResume,
    ],
  );

  // ── render-block segmentation (Codex-style activity grouping) ──────────────
  // Collapse the flat turn list into display blocks: runs of consecutive tool
  // turns fold into ONE activity group ("Worked for Xs ›"); the turn's `result`
  // duration is attached to the last activity group in its segment; the faint
  // tokens/cost footer renders only when that segment had no tool activity (the
  // activity line already shows the duration otherwise). File artifacts written
  // by Write/Edit/NotebookEdit are collected per activity group.
  const blocks = useMemo<RenderBlock[]>(() => {
    const out: RenderBlock[] = [];
    let pending: ToolTurn[] = [];

    const flushTools = () => {
      if (pending.length === 0) return;
      out.push({ kind: "activity", id: pending[0].id, tools: pending });
      pending = [];
    };
    // the activity group most recently emitted in the current turn segment,
    // so a trailing `result` can attach its duration to it.
    const lastActivity = (): Extract<RenderBlock, { kind: "activity" }> | null => {
      for (let i = out.length - 1; i >= 0; i--) {
        const b = out[i];
        if (b.kind === "activity") return b;
        if (b.kind === "user") break; // don't cross into a previous turn
      }
      return null;
    };

    for (const t of turns) {
      if (t.kind === "tool") {
        pending.push(t);
        continue;
      }
      flushTools();
      if (t.kind === "user") {
        out.push({ kind: "user", id: t.id, turn: t });
      } else if (t.kind === "assistant") {
        out.push({ kind: "assistant", id: t.id, turn: t });
      } else if (t.kind === "thinking") {
        out.push({ kind: "thinking", id: t.id, turn: t });
      } else if (t.kind === "approval") {
        out.push({ kind: "approval", id: t.id, turn: t });
      } else if (t.kind === "result") {
        const act = lastActivity();
        if (act && t.durationMs != null) act.durationMs = t.durationMs;
        // footer only carries supplementary metadata; when an activity line owns
        // the duration we still show tokens/cost there (it's separate + faint).
        if (t.text) out.push({ kind: "result", id: t.id, turn: t });
      }
    }
    flushTools();
    return out;
  }, [turns]);

  // index of the final activity group — only IT shows the live "Working…" timer
  // while streaming (so an earlier group in a multi-step turn never double-spins)
  const lastActivityIdx = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === "activity") return i;
    }
    return -1;
  }, [blocks]);

  // ── render ──────────────────────────────────────────────────────────────────

  if (empty) {
    return (
      <PaneDropZone onPath={insertPath} onFiles={onDropFiles} label="drop image or path">
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center bg-[var(--color-bg)] px-6">
        <div className="w-full max-w-2xl">
          <h1 className="mb-7 text-center font-sans text-3xl font-medium tracking-tight text-[var(--color-text)]">
            {resumedTitle ? "picking up where we left off" : "what should we work on?"}
          </h1>
          {resumedTitle && (
            <div className="mb-4 flex justify-center">
              <ResumedNote title={resumedTitle} onClear={() => setResumedTitle(null)} />
            </div>
          )}
          {composer}
          <div className="mt-3 flex items-center justify-center gap-3 font-mono text-[11px] text-[var(--color-faint)]">
            <span>{started ? "claude · ready" : "starting claude…"}</span>
            <span className="text-[var(--color-border-strong)]">·</span>
            <span className="inline-flex items-center gap-1">
              <Slash size={10} /> commands
            </span>
            <span className="inline-flex items-center gap-1">
              <AtSign size={10} /> files
            </span>
          </div>
        </div>
      </div>
      </PaneDropZone>
    );
  }

  return (
    <PaneDropZone onPath={insertPath} label="drop to add to message">
    <div className="relative flex h-full min-h-0 w-full flex-col bg-[var(--color-bg)]">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-5 px-6 py-8">
          {resumedTitle && (
            <div className="flex justify-center">
              <ResumedNote title={resumedTitle} onClear={() => setResumedTitle(null)} />
            </div>
          )}
          {blocks.map((b, i) =>
            b.kind === "activity" ? (
              <ActivityGroup
                key={b.id}
                tools={b.tools}
                durationMs={b.durationMs}
                // live only on the final activity group, while a turn is in
                // flight and it hasn't been closed by a result yet
                live={streaming && b.durationMs == null && i === lastActivityIdx}
                elapsedMs={liveStart != null ? now - liveStart : 0}
              />
            ) : b.kind === "user" ? (
              <UserBubble
                key={b.id}
                turn={b.turn}
                streaming={streaming}
                onRegenerate={regenerate}
              />
            ) : b.kind === "assistant" ? (
              <AssistantBubble
                key={b.id}
                turn={b.turn}
                onButton={(label) => {
                  if (!streaming && sessionIdRef.current != null) dispatch(label);
                }}
                disabled={streaming}
                onOpenUrl={onOpenUrl}
              />
            ) : b.kind === "thinking" ? (
              <ThinkingBlock key={b.id} turn={b.turn} />
            ) : b.kind === "approval" ? (
              <ApprovalCard
                key={b.id}
                turn={b.turn}
                onResolve={resolveApproval}
              />
            ) : (
              <ResultFooter key={b.id} turn={b.turn} />
            ),
          )}
          {/* turn in flight with neither streamed text nor a live activity group
              yet (the very first beat) → the bare working timer */}
          {streaming &&
            streamingTurnId.current == null &&
            !(
              lastActivityIdx >= 0 &&
              (blocks[lastActivityIdx] as Extract<RenderBlock, { kind: "activity" }>)
                .durationMs == null
            ) && (
              <WorkingLine elapsedMs={liveStart != null ? now - liveStart : 0} />
            )}
        </div>
      </div>
      {/* jump-to-latest pill — appears when you've scrolled up off the bottom */}
      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          title="jump to latest"
          className="absolute bottom-28 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-panel-2)]/90 px-3 py-1.5 font-sans text-[12px] text-[var(--color-text-2)] shadow-2xl shadow-black/40 backdrop-blur transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
        >
          <ArrowDown size={13} />
          latest
        </button>
      )}
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg)]/80 px-6 pb-5 pt-3 backdrop-blur">
        <div className="mx-auto max-w-2xl">
          {/* context readout — out of the cramped composer, model-aware window
              (opus 4.8 = 1M, sonnet/haiku = 200K, codex = 272K) */}
          {ctxTokens != null && (
            <div
              title={`${ctxTokens.toLocaleString()} tokens of context`}
              className="mb-1.5 flex justify-end px-1 font-mono text-[10.5px] tabular-nums text-[var(--color-faint)]"
            >
              {(() => {
                const win = model.id.startsWith("claude-opus")
                  ? 1_000_000
                  : model.engine === "codex"
                    ? 272_000
                    : model.engine === "opencode"
                      ? 256_000
                      : 200_000;
                const pct = Math.round((ctxTokens / win) * 100);
                return `${(ctxTokens / 1000).toFixed(1)}K${pct > 0 ? ` · ${pct}%` : ""} ctx`;
              })()}
            </div>
          )}
          {/* Pending steer list: first Enter queues, arrows highlight, second
              Enter injects on codex. Untouched rows auto-send after completion. */}
          {queued.length > 0 && (
            <div className="mb-2 overflow-hidden rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] shadow-xl shadow-black/20">
              {queued.map((q, i) => (
                <div
                  key={q.id}
                  onMouseEnter={() => setQueuedIdx(i)}
                  className={`flex items-center gap-2 px-3 py-2 font-sans text-[12px] text-[var(--color-text-2)] ${
                    i === queuedIdx ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel)]"
                  }`}
                >
                  <Clock size={12} className="shrink-0 text-[var(--color-faint)]" />
                  {editingQueuedId === q.id ? (
                    <input
                      value={editingQueuedText}
                      onChange={(e) => setEditingQueuedText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          saveQueuedEdit();
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingQueuedId(null);
                          setEditingQueuedText("");
                        }
                      }}
                      onBlur={saveQueuedEdit}
                      autoFocus
                      className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{q.text}</span>
                  )}
                  <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">queued</span>
                  {editingQueuedId === q.id ? (
                    <button
                      type="button"
                      onClick={saveQueuedEdit}
                      className="shrink-0 rounded p-0.5 text-[var(--color-accent)] hover:bg-[var(--color-panel)]"
                      title="save"
                    >
                      <Check size={12} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => editQueued(q)}
                      className="shrink-0 rounded p-0.5 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                      title="edit queued message"
                    >
                      <Pencil size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => moveQueued(q.id, -1)}
                    disabled={i === 0}
                    className="shrink-0 rounded p-0.5 text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-30"
                    title="move up"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveQueued(q.id, 1)}
                    disabled={i === queued.length - 1}
                    className="shrink-0 rounded p-0.5 text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-30"
                    title="move down"
                  >
                    <ArrowDown size={12} />
                  </button>
                  {model.engine === "codex" && streaming && (
                    <button
                      type="button"
                      onClick={() => steerQueued(q.id)}
                      className="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-panel)]"
                      title="inject into current turn"
                    >
                      steer
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeQueued(q.id)}
                    className="shrink-0 rounded p-0.5 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                    title="cancel"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <UsageStrip
            usage={usage}
            baseline={usageBaselineRef.current[model.engine ?? "claude"] ?? null}
            window={usageWindow}
            onWindowChange={setUsageWindow}
            cost={sessionCost}
            engine={model.engine ?? "claude"}
          />
          {composer}
        </div>
      </div>
    </div>
    </PaneDropZone>
  );
}

/**
 * The live usage strip under the composer: the active engine's 5h rate-limit
 * window as a thin bar (color-coded), the 7d window + reset as faint text, and
 * cumulative session cost. Ticks AS YOU TALK — codex pushes rate-limit updates,
 * claude re-reads usage.json after each turn (both arrive as `usage` events).
 */
function UsageStrip({
  usage,
  baseline,
  window,
  onWindowChange,
  cost,
  engine,
}: {
  usage: { fiveHour: { pct: number | null; resetsAt: number | null }; sevenDay: { pct: number | null; resetsAt: number | null } } | null;
  baseline: { fiveHour: { pct: number | null; resetsAt: number | null }; sevenDay: { pct: number | null; resetsAt: number | null } } | null;
  window: "fiveHour" | "sevenDay";
  onWindowChange: (window: "fiveHour" | "sevenDay") => void;
  cost: number;
  engine: string;
}) {
  const current = usage?.[window].pct ?? null;
  const initial = baseline?.[window].pct ?? current;
  // nothing to show yet (e.g. codex before its first rate-limit push) → hide.
  if (current == null && cost <= 0) return null;
  const stack = current != null && initial != null ? usageStack(current, initial) : null;
  const reset = usage?.[window].resetsAt ? resetIn(usage[window].resetsAt) : "";
  const remaining = stack ? 100 - stack.total : null;
  return (
    <div className="mb-2 flex items-center gap-2.5 px-1 font-mono text-[10px] tabular-nums text-[var(--color-faint)]">
      <span className="shrink-0 lowercase tracking-wide text-[var(--color-muted)]">{engine}</span>
      <span className="flex shrink-0 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]">
        {(["fiveHour", "sevenDay"] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onWindowChange(id)}
            className={`px-1.5 py-0.5 transition-colors ${
              window === id
                ? "bg-[var(--color-panel-2)] text-[var(--color-text-2)]"
                : "text-[var(--color-faint)] hover:text-[var(--color-muted)]"
            }`}
          >
            {id === "fiveHour" ? "5h" : "7d"}
          </button>
        ))}
      </span>
      {stack ? (
        <>
          <span className="flex-1">
            <span className="flex h-1 w-full overflow-hidden rounded-full bg-[var(--color-panel-2)]">
              <span
                className="block h-full bg-[var(--color-muted)] transition-[width] duration-700"
                style={{ width: `${stack.baseline}%` }}
              />
              <span
                className="block h-full bg-[var(--color-accent)] transition-[width] duration-700"
                style={{ width: `${stack.session}%` }}
              />
            </span>
          </span>
          <span className="shrink-0 text-[var(--color-text-2)]">
            {engine === "codex" ? `${Math.round(remaining!)}% left` : `${Math.round(stack.total)}% total`}
          </span>
          <span className="shrink-0 text-[var(--color-accent)]">+{Math.round(stack.session)}% chat</span>
          {reset && <span className="shrink-0">resets {reset}</span>}
        </>
      ) : (
        <span className="flex-1" />
      )}
      {cost > 0 && <span className="shrink-0 text-[var(--color-text-2)]">${cost.toFixed(2)}</span>}
    </div>
  );
}

// ── sub-views ────────────────────────────────────────────────────────────────

/**
 * Codex-style activity group: one subtle, hairline-free line — "Worked for Xs ›"
 * (or a live "Working… m:ss" with a shimmer while the turn is in flight) — that
 * collapses an entire run of tool calls. Click to expand the tight step list;
 * each step is one line (icon + verb + truncated target). Any files the steps
 * wrote (Write/Edit/NotebookEdit) surface as artifact cards beneath the list.
 */
function ActivityGroup({
  tools,
  durationMs,
  live,
  elapsedMs,
}: {
  tools: ToolTurn[];
  durationMs?: number;
  live: boolean;
  elapsedMs: number;
}) {
  // expanded while the turn is live (so you watch tools run in real time), then
  // auto-collapses to "Worked for Xs ›" when done — unless the user toggled it.
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? live;

  // dedup artifacts by path (an Edit + later Write on the same file → one card)
  const artifacts = useMemo(() => {
    const seen = new Map<string, Artifact>();
    for (const t of tools) {
      const a = artifactFromTool(t);
      if (a) seen.set(a.path, a);
    }
    return [...seen.values()];
  }, [tools]);

  const n = tools.length;
  const label = live
    ? `Working… ${fmtClock(elapsedMs)}`
    : durationMs != null
      ? `Worked for ${fmtDuration(durationMs)}`
      : `${n} step${n === 1 ? "" : "s"}`;

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setUserToggled(!open)}
        className="group/act -mx-1 flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 text-left font-sans text-[12.5px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text-2)]"
      >
        {live ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-[var(--color-accent)]" />
        ) : (
          <ChevronRight
            size={13}
            className={`shrink-0 text-[var(--color-faint)] transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
        <span className={live ? "animate-pulse" : undefined}>{label}</span>
        {!live && n > 0 && (
          <span className="text-[var(--color-faint)]">
            · {n} step{n === 1 ? "" : "s"}
          </span>
        )}
      </button>

      {open && n > 0 && (
        <div className="ml-[6px] flex flex-col gap-0.5 border-l border-[var(--color-border)] pl-3">
          {tools.map((t) => (
            <ActivityStep key={t.id} turn={t} live={live} />
          ))}
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-2">
          {artifacts.map((a) => (
            <FileCard key={a.path} artifact={a} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One activity step: tool icon + verb + truncated target, expandable to its
 *  full input detail (Bash command, Edit diff, Todo checklist, or args) + result.
 *  While the turn is live, the currently-running step (no result yet) auto-opens
 *  so you watch the work happen — exactly the claude-code feel. */
function ActivityStep({ turn, live }: { turn: ToolTurn; live: boolean }) {
  const Icon = toolIcon(turn.name);
  const verb = toolVerb(turn.name);
  const { label, full } = toolTarget(turn);
  const running = turn.result == null;
  const hasResult = turn.result != null && turn.result.trim().length > 0;
  const detail = toolDetail(turn);
  const expandable = hasResult || detail != null;

  // running step opens itself while the turn is live, and an errored step always
  // opens (you want to see what broke); otherwise user-controlled. (AI Elements
  // `Tool` lifecycle: auto-expand on running, error.)
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? ((live && running) || turn.isError === true);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => expandable && setUserToggled(!open)}
        title={full || undefined}
        className={`flex w-full items-center gap-2 rounded-md py-0.5 pr-1 text-left ${
          expandable ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <Icon size={13} className="shrink-0 text-[var(--color-faint)]" />
        <span className="shrink-0 font-sans text-[12px] text-[var(--color-text-2)]">
          {verb}
        </span>
        {label && (
          <span className="truncate font-mono text-[11.5px] text-[var(--color-muted)]">
            {label}
          </span>
        )}
        <span className="flex-1" />
        {running ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-[var(--color-faint)]" />
        ) : turn.isError ? (
          <X size={12} className="shrink-0 text-[var(--color-danger)]" />
        ) : expandable ? (
          <ChevronRight
            size={12}
            className={`shrink-0 text-[var(--color-faint)] transition-transform ${open ? "rotate-90" : ""}`}
          />
        ) : null}
      </button>
      {open && (
        <div className="mb-1 ml-[7px] flex flex-col gap-1.5 border-l border-[var(--color-border)] pl-3 pt-1">
          {detail}
          {hasResult && (
            <pre
              className={`max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed ${
                turn.isError ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"
              }`}
            >
              {turn.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Renders the rich INPUT detail for a tool — the part claude code shows inline:
 *  the Bash command, an Edit's diff, a TodoWrite checklist, or the raw args.
 *  Returns null when the target label already says everything (e.g. a plain Read). */
function toolDetail(turn: ToolTurn): React.ReactNode {
  const name = turn.name.toLowerCase();
  const inp = turn.input ?? {};
  const str = (k: string) =>
    typeof inp[k] === "string" ? (inp[k] as string) : undefined;

  if (name === "bash" || name === "bashoutput" || name === "exec_command" || name === "write_stdin") {
    const cmd = str("command") ?? str("cmd") ?? str("chars");
    if (!cmd) return null;
    return (
      <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-2)]">
        <span className="select-none text-[var(--color-accent)]">$ </span>
        {cmd}
      </pre>
    );
  }

  if (name === "edit" || name === "multiedit") {
    const edits =
      name === "multiedit" && Array.isArray(inp.edits)
        ? (inp.edits as Array<Record<string, unknown>>)
        : [{ old_string: inp.old_string, new_string: inp.new_string }];
    const blocks = edits
      .map((e, i) => {
        const oldS = typeof e.old_string === "string" ? e.old_string : "";
        const newS = typeof e.new_string === "string" ? e.new_string : "";
        if (!oldS && !newS) return null;
        return <DiffBlock key={i} oldText={oldS} newText={newS} />;
      })
      .filter(Boolean);
    return blocks.length > 0 ? <>{blocks}</> : null;
  }

  if (name === "todowrite" && Array.isArray(inp.todos)) {
    return <TodoList todos={inp.todos as Array<Record<string, unknown>>} />;
  }

  if (name === "write") {
    const content = str("content");
    if (!content) return null;
    const preview = content.split("\n").slice(0, 24).join("\n");
    const more = content.split("\n").length - 24;
    return (
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-2)]">
        {preview}
        {more > 0 && (
          <span className="text-[var(--color-faint)]">{`\n… +${more} more lines`}</span>
        )}
      </pre>
    );
  }

  if (name === "task") {
    const prompt = str("prompt");
    if (!prompt) return null;
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 font-sans text-[11.5px] leading-relaxed text-[var(--color-muted)]">
        {prompt.length > 600 ? prompt.slice(0, 600) + "…" : prompt}
      </div>
    );
  }

  return null;
}

/** A red/green diff for an Edit's old → new strings. Long sides cap to a preview
 *  with a "+N more lines" tail (opcode/claude-code-webui pattern) so a big edit
 *  doesn't flood the transcript; click the tail to reveal the rest. */
const DIFF_CAP = 14;
function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  const [expanded, setExpanded] = useState(false);
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const capped = !expanded && oldLines.length + newLines.length > DIFF_CAP * 2;
  const showOld = capped ? oldLines.slice(0, DIFF_CAP) : oldLines;
  const showNew = capped ? newLines.slice(0, DIFF_CAP) : newLines;
  const hidden =
    oldLines.length - showOld.length + (newLines.length - showNew.length);

  return (
    <pre className="overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] font-mono text-[11px] leading-relaxed">
      {showOld.map((l, i) => (
        <div
          key={`o${i}`}
          className="whitespace-pre-wrap break-words bg-[var(--color-danger)]/10 px-2.5 text-[var(--color-danger)]"
        >
          <span className="select-none opacity-60">- </span>
          {l}
        </div>
      ))}
      {showNew.map((l, i) => (
        <div
          key={`n${i}`}
          className="whitespace-pre-wrap break-words bg-[var(--color-success,#22c55e)]/10 px-2.5 text-[var(--color-success,#22c55e)]"
        >
          <span className="select-none opacity-60">+ </span>
          {l}
        </div>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="block w-full px-2.5 py-0.5 text-left text-[var(--color-faint)] italic hover:text-[var(--color-muted)]"
        >
          {`… +${hidden} more line${hidden === 1 ? "" : "s"}`}
        </button>
      )}
    </pre>
  );
}

/** Renders a TodoWrite checklist — pending / in-progress / done, with a
 *  "N of M done" progress footer. claude-code-webui / AI Elements `Task` style. */
function TodoList({ todos }: { todos: Array<Record<string, unknown>> }) {
  const done = todos.filter((t) => String(t.status) === "completed").length;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2">
      {todos.map((t, i) => {
        const status = String(t.status ?? "pending");
        const content =
          (typeof t.content === "string" && t.content) ||
          (typeof t.activeForm === "string" && t.activeForm) ||
          "";
        const active =
          status === "in_progress" && typeof t.activeForm === "string"
            ? (t.activeForm as string)
            : null;
        return (
          <div key={i} className="flex items-start gap-2 font-sans text-[11.5px] leading-relaxed">
            {status === "completed" ? (
              <Check size={13} className="mt-0.5 shrink-0 text-[var(--color-success,#22c55e)]" />
            ) : status === "in_progress" ? (
              <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-[var(--color-accent)]" />
            ) : (
              <Square size={13} className="mt-0.5 shrink-0 text-[var(--color-faint)]" />
            )}
            <span className="flex min-w-0 flex-col">
              <span
                className={
                  status === "completed"
                    ? "text-[var(--color-faint)] line-through"
                    : status === "in_progress"
                      ? "text-[var(--color-text)]"
                      : "text-[var(--color-muted)]"
                }
              >
                {content}
              </span>
              {active && active !== content && (
                <span className="text-[10.5px] italic text-[var(--color-faint)]">
                  {active}
                </span>
              )}
            </span>
          </div>
        );
      })}
      {todos.length > 0 && (
        <div className="mt-1 border-t border-[var(--color-border)] pt-1 font-mono text-[10.5px] text-[var(--color-faint)]">
          {done} of {todos.length} done
        </div>
      )}
    </div>
  );
}

/** Clean artifact card for a file a turn produced (Codex "Open in…"). Click →
 *  open as an in-app viewer pane (image/pdf/text preview); falls back to the OS
 *  app only if no pane opener is wired. Icon keyed by file type. */
function FileCard({ artifact }: { artifact: Artifact }) {
  const Icon =
    artifact.kind === "img"
      ? ImageIcon
      : artifact.kind === "pdf" || artifact.kind === "doc"
        ? FileType
        : artifact.kind === "code"
          ? FileCode
          : FileText;
  // surface failures instead of swallowing them — a denied scope or missing
  // file briefly flips the label to the reason so it's debuggable, not silent.
  const [err, setErr] = useState<string | null>(null);
  const open = () => {
    setErr(null);
    // prefer an in-app viewer pane; only hand off to the OS if none is wired.
    if (openFileInPane(artifact.path, artifact.name)) return;
    openPath(artifact.path).catch((e) => {
      setErr(String(e));
      console.error("openPath failed:", artifact.path, e);
    });
  };
  return (
    <button
      type="button"
      onClick={open}
      title={err ? `${err} — ${artifact.path}` : `open ${artifact.path}`}
      className={`group/file flex max-w-full items-center gap-2.5 rounded-lg border bg-[var(--color-panel-2)] px-3 py-2 text-left transition-colors ${
        err
          ? "border-[var(--color-danger)]/50"
          : "border-[var(--color-border)] hover:border-[var(--color-accent)]/50"
      }`}
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
        <Icon size={14} />
      </span>
      <span className="min-w-0 flex flex-col">
        <span className="truncate font-mono text-[12px] text-[var(--color-text)]">
          {artifact.name}
        </span>
        <span
          className={`font-sans text-[10.5px] ${
            err
              ? "text-[var(--color-danger)]"
              : "text-[var(--color-faint)] group-hover/file:text-[var(--color-muted)]"
          }`}
        >
          {err ? "couldn’t open — see tooltip" : "open"}
        </span>
      </span>
    </button>
  );
}

/** The bare live working line when a turn is in flight before any tool runs. */
function WorkingLine({ elapsedMs }: { elapsedMs: number }) {
  return (
    <div className="flex items-center gap-1.5 font-sans text-[12.5px] text-[var(--color-muted)]">
      <Loader2 size={13} className="shrink-0 animate-spin text-[var(--color-accent)]" />
      <span className="animate-pulse">Working… {fmtClock(elapsedMs)}</span>
    </div>
  );
}

/** Faint, centered turn footer — tokens · cost · (duration on text-only turns). */
function ResultFooter({ turn }: { turn: Extract<Turn, { kind: "result" }> }) {
  return (
    <div className="text-center font-mono text-[10.5px] text-[var(--color-faint)]">
      {turn.text}
    </div>
  );
}

/** Copy-to-clipboard button with a brief check confirmation. */
function CopyButton({
  text,
  size = 13,
  title = "copy",
  className,
}: {
  text: string;
  size?: number;
  title?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          },
          () => {},
        );
      }}
      className={
        className ??
        "grid h-6 w-6 place-items-center rounded-md text-[var(--color-faint)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
      }
    >
      {done ? (
        <Check size={size} className="text-[var(--color-success)]" />
      ) : (
        <Copy size={size} />
      )}
    </button>
  );
}

function UserBubble({
  turn,
  streaming,
  onRegenerate,
}: {
  turn: Extract<Turn, { kind: "user" }>;
  streaming: boolean;
  onRegenerate: () => void;
}) {
  return (
    <div className="group flex flex-col items-end gap-1">
      {turn.steered && (
        <span className="flex items-center gap-1 pr-1 font-mono text-[10px] text-[var(--color-faint)]">
          <Waypoints size={10} /> steered into the running turn
        </span>
      )}
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[var(--color-accent-soft)] px-4 py-2.5 font-sans text-[14px] leading-relaxed text-[var(--color-text)]">
        {turn.text}
      </div>
      <div className="flex items-center gap-0.5 pr-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <CopyButton text={turn.text} title="copy message" />
        <button
          type="button"
          title="regenerate from here"
          disabled={streaming}
          onClick={onRegenerate}
          className="grid h-6 w-6 place-items-center rounded-md text-[var(--color-faint)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw size={13} />
        </button>
      </div>
    </div>
  );
}

/** Parse the WA-style `[[btn: a | b | c]]` choice sentinel out of an assistant
 *  message: returns the prose with the sentinel stripped + up to 3 button
 *  labels. Mirrors the bridge's WhatsApp interactive-button behavior so a choice
 *  offered in chat is tappable here too, not dead literal text. */
function parseButtons(text: string): { body: string; buttons: string[] } {
  const m = text.match(/\[\[btn:\s*([^\]]+?)\s*\]\]/i);
  if (!m) return { body: text, buttons: [] };
  const buttons = m[1]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
  return { body: text.replace(m[0], "").trimEnd(), buttons };
}

/** The model's extended-thinking trace — dim + collapsible. Auto-expanded while
 *  the tokens are streaming in (so you read the reasoning live), then collapses
 *  to a faint "Thought ›" line you can re-open. Mirrors claude-code's quiet trace. */
function ThinkingBlock({ turn }: { turn: Extract<Turn, { kind: "thinking" }> }) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? turn.streaming;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setUserToggled(!open)}
        className="-mx-1 flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-left font-sans text-[12.5px] leading-[1.5] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text-2)]"
      >
        {turn.streaming ? (
          <CadencedShimmer>thinking</CadencedShimmer>
        ) : (
          <span>
            {turn.durationMs != null ? `thought for ${fmtDuration(turn.durationMs)}` : "thought"}
          </span>
        )}
        {!turn.streaming ? (
          <ChevronRight
            size={12}
            className={`shrink-0 text-[var(--color-faint)] transition-transform ${open ? "rotate-90" : ""}`}
          />
        ) : null}
      </button>
      {open && (
        <div className="ml-[6px] whitespace-pre-wrap break-words border-l border-[var(--color-border)] pl-3 font-sans text-[12.5px] italic leading-relaxed text-[var(--color-muted)]">
          {turn.text}
        </div>
      )}
    </div>
  );
}

function CadencedShimmer({ children }: { children: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let removeTimer: number | undefined;
    const run = () => {
      setActive(false);
      window.requestAnimationFrame(() => {
        setActive(true);
        removeTimer = window.setTimeout(() => setActive(false), 1000);
      });
    };
    const startTimer = window.setTimeout(run, 600);
    const interval = window.setInterval(run, 4000);
    return () => {
      window.clearTimeout(startTimer);
      window.clearInterval(interval);
      if (removeTimer != null) window.clearTimeout(removeTimer);
    };
  }, []);

  return (
    <span
      ref={ref}
      className={`aios-cadenced-shimmer select-none truncate ${active ? "aios-cadenced-shimmer--active" : ""}`}
    >
      {children}
      <span aria-hidden="true" className="aios-cadenced-shimmer__sweep">
        <span className="aios-cadenced-shimmer__highlight">{children}</span>
      </span>
    </span>
  );
}

function AssistantBubble({
  turn,
  onButton,
  disabled,
  onOpenUrl,
}: {
  turn: Extract<Turn, { kind: "assistant" }>;
  onButton: (label: string) => void;
  disabled: boolean;
  onOpenUrl?: (url: string) => void;
}) {
  // Don't render the sentinel as a half-baked pill while still streaming in —
  // wait for the full message so we don't flicker partial `[[btn:` text.
  const { body, buttons } = turn.streaming
    ? { body: turn.text, buttons: [] as string[] }
    : parseButtons(turn.text);
  return (
    <div className="group flex flex-col items-start gap-1">
      <div className="max-w-[92%] font-sans text-[14.5px] leading-relaxed text-[var(--color-text-2)]">
        <Markdown text={body} onOpenUrl={onOpenUrl} />
        {turn.streaming && (
          <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse bg-[var(--color-accent)]" />
        )}
      </div>
      {buttons.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {buttons.map((label) => (
            <button
              key={label}
              type="button"
              disabled={disabled}
              onClick={() => onButton(label)}
              className="rounded-[var(--aios-radius-pill)] border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--color-text)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {!turn.streaming && body.trim() && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={body} title="copy response" />
        </div>
      )}
    </div>
  );
}

/**
 * Inline tool-approval card for a `can_use_tool` control request (non-bypass
 * modes). Allow once / Allow always / Deny → replied via the control protocol
 * (buildApprovalLine in chat.ts owns the exact shape). Once resolved the card
 * collapses to a one-line verdict so the transcript stays clean.
 */
function ApprovalCard({
  turn,
  onResolve,
}: {
  turn: Extract<Turn, { kind: "approval" }>;
  onResolve: (
    requestId: string,
    toolName: string,
    decision: ApprovalDecision,
  ) => void;
}) {
  const args = previewArgs(turn.input);

  if (turn.decision) {
    const denied = turn.decision === "deny";
    return (
      <div
        className={`flex items-center gap-2 rounded-xl border px-3.5 py-2 font-sans text-[12px] ${
          denied
            ? "border-[var(--color-danger)]/30 text-[var(--color-danger)]"
            : "border-[var(--color-success)]/30 text-[var(--color-success)]"
        }`}
      >
        {denied ? <X size={13} /> : <CheckCheck size={13} />}
        <span className="font-mono text-[11.5px] text-[var(--color-text-2)]">
          {turn.toolName}
        </span>
        <span className="opacity-80">
          {turn.decision === "allow"
            ? "allowed once"
            : turn.decision === "allow_always"
              ? "allowed for session"
              : "denied"}
        </span>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]">
      <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--color-bg)]/40 text-[var(--color-accent)]">
          <ShieldQuestion size={14} />
        </span>
        <span className="font-sans text-[12.5px] text-[var(--color-text)]">
          allow{" "}
          <span className="font-mono font-medium">{turn.toolName}</span>?
        </span>
      </div>
      {args && (
        <div className="mx-3.5 mb-2 truncate rounded-md bg-[var(--color-bg)]/40 px-2.5 py-1.5 font-mono text-[11px] text-[var(--color-muted)]">
          {args}
        </div>
      )}
      <div className="flex items-center gap-2 px-3.5 pb-3">
        <button
          type="button"
          onClick={() => onResolve(turn.requestId, turn.toolName, "allow")}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 font-sans text-[12px] font-medium text-[var(--color-bg)] transition-colors hover:bg-[var(--color-accent-hover)]"
        >
          <Check size={13} /> allow once
        </button>
        <button
          type="button"
          onClick={() =>
            onResolve(turn.requestId, turn.toolName, "allow_always")
          }
          className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] px-3 py-1.5 font-sans text-[12px] text-[var(--color-text)] transition-colors hover:border-[var(--color-accent)]/50"
        >
          <CheckCheck size={13} /> allow always
        </button>
        <button
          type="button"
          onClick={() => onResolve(turn.requestId, turn.toolName, "deny")}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 font-sans text-[12px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-danger)]/40 hover:text-[var(--color-danger)]"
        >
          <X size={13} /> deny
        </button>
      </div>
    </div>
  );
}

// ── markdown renderer (dependency-free, partial-stream safe) ──────────────────
//
// Deliberately small: blocks split on fenced ``` first (so a half-open fence
// during streaming just renders as an open code block, never throws), then each
// non-code block is rendered with inline spans for `code`, **bold**, *italic*,
// and [links](url). Headings + bullet / numbered lists are handled at the line
// level. Anything it doesn't recognize falls through as plain text.

const HELP_TEXT = `**AIOS chat**

- type to talk to claude — streams token by token
- \`/\` opens commands · \`@\` mentions files from the working dir
- **plan** chip → plan-first on the next message
- **goal** pill → context kept across turns until cleared
- ⌘J dictates into the composer
- stop (■) interrupts mid-turn; the session survives
- hover a message to copy or regenerate`;

/** Split text into fenced-code and non-code segments. Tolerates an unclosed
 *  trailing fence (mid-stream) by treating the remainder as an open block. */
function splitFences(
  text: string,
): Array<{ code: true; lang: string; body: string } | { code: false; body: string }> {
  const out: Array<
    { code: true; lang: string; body: string } | { code: false; body: string }
  > = [];
  const re = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ code: false, body: text.slice(last, m.index) });
    out.push({ code: true, lang: (m[1] || "").trim(), body: m[2] ?? "" });
    last = re.lastIndex;
  }
  const rest = text.slice(last);
  // an unclosed fence while streaming: render what we have as an open code block
  const openIdx = rest.indexOf("```");
  if (openIdx >= 0) {
    if (openIdx > 0) out.push({ code: false, body: rest.slice(0, openIdx) });
    const after = rest.slice(openIdx + 3);
    const nl = after.indexOf("\n");
    const lang = (nl >= 0 ? after.slice(0, nl) : after).trim();
    const body = nl >= 0 ? after.slice(nl + 1) : "";
    out.push({ code: true, lang, body });
  } else if (rest) {
    out.push({ code: false, body: rest });
  }
  return out;
}

function Markdown({
  text,
  onOpenUrl,
}: {
  text: string;
  onOpenUrl?: (url: string) => void;
}) {
  const segments = useMemo(() => splitFences(text), [text]);
  return (
    <div className="flex flex-col gap-2">
      {segments.map((seg, i) =>
        seg.code ? (
          <CodeBlock key={i} lang={seg.lang} body={seg.body} />
        ) : (
          <MarkdownBlocks key={i} text={seg.body} onOpenUrl={onOpenUrl} />
        ),
      )}
    </div>
  );
}

function CodeBlock({ lang, body }: { lang: string; body: string }) {
  // strip a single trailing newline so the block isn't bottom-heavy
  const code = body.replace(/\n$/, "");
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/70">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-1">
        <span className="font-mono text-[10.5px] text-[var(--color-faint)]">
          {lang || "code"}
        </span>
        <CopyButton text={code} size={12} title="copy code" />
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[var(--color-text)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Render the non-code body: split into block-level lines (headings / lists /
 *  paragraphs), each with inline formatting. */
function MarkdownBlocks({
  text,
  onOpenUrl,
}: {
  text: string;
  onOpenUrl?: (url: string) => void;
}) {
  if (!text.trim()) return null;
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let listBuf: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushList = () => {
    if (!listBuf) return;
    const { ordered, items } = listBuf;
    const cls =
      "my-0.5 flex flex-col gap-1 pl-1 " +
      (ordered ? "" : "");
    out.push(
      ordered ? (
        <ol key={`l${key++}`} className={cls}>
          {items.map((it, j) => (
            <li key={j} className="flex gap-2">
              <span className="select-none text-[var(--color-faint)]">{j + 1}.</span>
              <span className="flex-1">
                <Inline text={it} onOpenUrl={onOpenUrl} />
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <ul key={`l${key++}`} className={cls}>
          {items.map((it, j) => (
            <li key={j} className="flex gap-2">
              <span className="select-none text-[var(--color-accent)]">•</span>
              <span className="flex-1">
                <Inline text={it} onOpenUrl={onOpenUrl} />
              </span>
            </li>
          ))}
        </ul>
      ),
    );
    listBuf = null;
  };

  for (const raw of lines) {
    const line = raw;
    // headings
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushList();
      const level = h[1].length;
      const size =
        level === 1
          ? "text-[17px]"
          : level === 2
            ? "text-[15.5px]"
            : "text-[14.5px]";
      out.push(
        <div
          key={`h${key++}`}
          className={`mt-1 font-sans font-semibold text-[var(--color-text)] ${size}`}
        >
          <Inline text={h[2]} onOpenUrl={onOpenUrl} />
        </div>,
      );
      continue;
    }
    // unordered list
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (!listBuf || listBuf.ordered) {
        flushList();
        listBuf = { ordered: false, items: [] };
      }
      listBuf.items.push(ul[1]);
      continue;
    }
    // ordered list
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (!listBuf || !listBuf.ordered) {
        flushList();
        listBuf = { ordered: true, items: [] };
      }
      listBuf.items.push(ol[1]);
      continue;
    }
    // blank line → paragraph break
    if (!line.trim()) {
      flushList();
      continue;
    }
    // plain paragraph line
    flushList();
    out.push(
      <p key={`p${key++}`} className="whitespace-pre-wrap break-words">
        <Inline text={line} onOpenUrl={onOpenUrl} />
      </p>,
    );
  }
  flushList();
  return <>{out}</>;
}

/** Inline span formatting: `code`, **bold**, *italic* / _italic_, [text](url).
 *  Single-pass tokenizer — partial markers (e.g. a lone trailing `**` during
 *  streaming) just render literally, never throw. */
function Inline({
  text,
  onOpenUrl,
}: {
  text: string;
  onOpenUrl?: (url: string) => void;
}) {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  let plain = "";
  const flush = () => {
    if (plain) {
      nodes.push(<span key={`s${k++}`}>{plain}</span>);
      plain = "";
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // inline code `…`
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        const code = text.slice(i + 1, end);
        const fileish = isPaneFileTarget(code);
        nodes.push(
          fileish ? (
            <button
              key={`c${k++}`}
              type="button"
              onClick={() => {
                const path = resolvePaneFileTarget(code);
                openFileInPane(path, targetLabel(path));
              }}
              className="rounded bg-[var(--color-panel)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--color-accent)] underline decoration-[var(--color-accent)]/30 underline-offset-2 hover:decoration-[var(--color-accent)]"
              title="open in pane"
            >
              {code}
            </button>
          ) : (
            <code
              key={`c${k++}`}
              className="rounded bg-[var(--color-panel)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--color-text)]"
            >
              {code}
            </code>
          ),
        );
        i = end + 1;
        continue;
      }
    }

    // bold **…**
    if (rest.startsWith("**")) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 1) {
        flush();
        nodes.push(
          <strong key={`b${k++}`} className="font-semibold text-[var(--color-text)]">
            <Inline text={text.slice(i + 2, end)} onOpenUrl={onOpenUrl} />
          </strong>,
        );
        i = end + 2;
        continue;
      }
    }

    // link [text](url)
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const paren = text.indexOf(")", close + 2);
        if (paren > close) {
          flush();
          const label = text.slice(i + 1, close);
          const url = text.slice(close + 2, paren);
          const http = isHttpPaneTarget(url);
          const fileish = isPaneFileTarget(url);
          nodes.push(
            <a
              key={`a${k++}`}
              href={url}
              target={http ? "_blank" : undefined}
              rel="noreferrer"
              onClick={(e) => {
                if (http) {
                  e.preventDefault();
                  if (onOpenUrl) onOpenUrl(url);
                  else openUrlInPane(url);
                  return;
                }
                if (fileish) {
                  e.preventDefault();
                  const path = resolvePaneFileTarget(url);
                  openFileInPane(path, targetLabel(path));
                }
              }}
              className="text-[var(--color-accent)] underline decoration-[var(--color-accent)]/40 underline-offset-2 hover:decoration-[var(--color-accent)]"
            >
              {label}
            </a>,
          );
          i = paren + 1;
          continue;
        }
      }
    }

    // italic *…* or _…_  (avoid eating ** — handled above)
    if ((text[i] === "*" && text[i + 1] !== "*") || text[i] === "_") {
      const marker = text[i];
      const end = text.indexOf(marker, i + 1);
      if (end > i + 1) {
        flush();
        nodes.push(
          <em key={`i${k++}`} className="italic">
            {text.slice(i + 1, end)}
          </em>,
        );
        i = end + 1;
        continue;
      }
    }

    plain += text[i];
    i += 1;
  }
  flush();
  return <>{nodes}</>;
}

// ── tiny dropdown primitive ──────────────────────────────────────────────────

function Dropdown({
  open,
  onToggle,
  trigger,
  children,
  align = "left",
  triggerClassName,
}: {
  open: boolean;
  onToggle: () => void;
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
  /** Override the trigger pill styling (e.g. the ultracode gradient). */
  triggerClassName?: string;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={
          triggerClassName ??
          "flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]/50 px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
        }
      >
        {trigger}
      </button>
      {open && (
        <div
          className={`absolute bottom-full z-30 mb-1.5 min-w-[140px] overflow-hidden rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] py-1 shadow-2xl shadow-black/50 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  active,
  disabled,
  title,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center px-3 py-1.5 text-left font-sans text-[12px] transition-colors ${
        disabled
          ? "cursor-not-allowed text-[var(--color-faint)]"
          : active
            ? "bg-[var(--color-accent-soft)] text-[var(--color-text)]"
            : "text-[var(--color-text-2)] hover:bg-[var(--color-panel)]"
      }`}
    >
      {children}
    </button>
  );
}

// ── slash / @ overlay primitives ─────────────────────────────────────────────

interface SlashCommand {
  id: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
  run: () => void;
}

/** The floating panel that sits just above the composer for `/` and `@`. */
function OverlayPanel({
  children,
  compact = false,
}: {
  children: React.ReactNode;
  /** compact = a left-anchored dropdown (slash menu) vs the full-width panel. */
  compact?: boolean;
}) {
  return (
    <div
      className={`absolute bottom-full z-40 mb-2 max-h-64 overflow-y-auto rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] py-1 shadow-2xl shadow-black/50 ${
        compact ? "left-3 min-w-[220px] max-w-[min(360px,90%)]" : "left-0 right-0"
      }`}
    >
      {children}
    </div>
  );
}

function OverlayRow({
  active,
  onClick,
  onMouseEnter,
  icon,
  label,
  desc,
  mono,
}: {
  active: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  icon: React.ReactNode;
  label: string;
  desc?: string;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
        active ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel)]"
      }`}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center">{icon}</span>
      <span
        className={`shrink-0 text-[12.5px] text-[var(--color-text)] ${
          mono ? "font-mono" : "font-sans"
        }`}
      >
        {label}
      </span>
      {desc && (
        <span className="truncate font-sans text-[11px] text-[var(--color-faint)]">
          {desc}
        </span>
      )}
      {active && (
        <>
          <span className="flex-1" />
          <CornerDownLeft size={12} className="shrink-0 text-[var(--color-faint)]" />
        </>
      )}
    </button>
  );
}

// ── /resume picker ────────────────────────────────────────────────────────────

/**
 * Floating picker (surface-pop style) listing recent past chat sessions for
 * `/resume`. Sits just above the composer like the slash/@ menus. A sticky
 * search header filters by title; each row shows the title + a faint secondary
 * line with the cwd basename and a relative time. Arrow-key navigable (driven
 * from the search input — see onResumeKeyDown), click to pick, Esc to close.
 */
function ResumePicker({
  sessions,
  total,
  loading,
  query,
  activeIdx,
  searchRef,
  onQueryChange,
  onKeyDown,
  onHover,
  onPick,
  onClose,
}: {
  sessions: ChatSessionInfo[];
  total: number;
  loading: boolean;
  query: string;
  activeIdx: number;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onQueryChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onHover: (i: number) => void;
  onPick: (s: ChatSessionInfo) => void;
  onClose: () => void;
}) {
  const byProject = sessions.reduce<Array<{ key: string; label: string; items: ChatSessionInfo[] }>>(
    (groups, session) => {
      const label = baseName(session.cwd || "") || "unknown project";
      const key = `${label}:${session.cwd || ""}`;
      const group = groups.find((g) => g.key === key);
      if (group) {
        group.items.push(session);
      } else {
        groups.push({ key, label, items: [session] });
      }
      return groups;
    },
    [],
  );
  let rowIndex = 0;
  return (
    <div className="absolute bottom-full left-0 right-0 z-40 mb-2 overflow-hidden rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] shadow-2xl shadow-black/50">
      {/* sticky search header */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <History size={14} className="shrink-0 text-[var(--color-accent)]" />
        <span className="shrink-0 font-sans text-[12px] text-[var(--color-text-2)]">
          resume
        </span>
        <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-faint)]">
          {total} sessions
        </span>
        <span className="ml-1 flex min-w-0 flex-1 items-center gap-1.5">
          <Search size={12} className="shrink-0 text-[var(--color-faint)]" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="search title, project, model, id…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-sans text-[12.5px] text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
          />
        </span>
        <button
          type="button"
          onClick={onClose}
          title="close (esc)"
          className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-[var(--color-faint)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
        >
          <X size={12} />
        </button>
      </div>

      {/* body */}
      <div className="max-h-[22rem] overflow-y-auto py-1">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 font-sans text-[12px] text-[var(--color-faint)]">
            <Loader2 size={13} className="animate-spin" />
            loading codex + chatpane sessions…
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-3 font-sans text-[12px] text-[var(--color-faint)]">
            {total === 0
              ? "no past chat sessions yet"
              : `no sessions match “${query}”`}
          </div>
        ) : (
          byProject.map((group) => (
            <div key={group.key}>
              <div className="sticky top-0 z-10 flex items-center justify-between border-y border-[var(--color-border)] bg-[var(--color-panel-2)]/95 px-3 py-1 font-sans text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)] backdrop-blur first:border-t-0">
                <span className="truncate">{group.label}</span>
                <span className="font-mono tracking-normal">{group.items.length}</span>
              </div>
              {group.items.map((s) => {
                const i = rowIndex++;
                return (
                  <ResumeRow
                    key={s.id}
                    session={s}
                    active={i === activeIdx}
                    onMouseEnter={() => onHover(i)}
                    onClick={() => onPick(s)}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** One row in the /resume picker: a RotateCcw glyph, the title (truncated), and
 *  a faint secondary line with the cwd basename + relative time. */
function ResumeRow({
  session,
  active,
  onMouseEnter,
  onClick,
}: {
  session: ChatSessionInfo;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const dir = baseName(session.cwd || "");
  const when = session.mtime ? fmtRelativeTime(session.mtime) : "";
  const engine = session.engine || "claude";
  const model = session.model || "";
  const shortId = session.id ? session.id.slice(0, 8) : "";
  const sourceLabel =
    engine === "codex" ? "codex terminal/chat" : engine === "opencode" ? "opencode" : "chatpane";
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
        active ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel)]"
      }`}
    >
      <RotateCcw
        size={14}
        className={`shrink-0 ${
          active ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"
        }`}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-sans text-[13px] text-[var(--color-text)]">
            {session.title || "untitled session"}
          </span>
          <span className="shrink-0 rounded border border-[var(--color-border)] px-1 py-0.5 font-mono text-[9px] text-[var(--color-faint)]">
            {engine}
          </span>
        </span>
        <span className="mt-1 flex items-center gap-1.5 truncate font-sans text-[11px] text-[var(--color-faint)]">
          {dir && (
            <span className="inline-flex items-center gap-1">
              <Folder size={10} />
              {dir}
            </span>
          )}
          {dir && when && <span className="text-[var(--color-border-strong)]">·</span>}
          {when && (
            <span className="inline-flex items-center gap-1">
              <Clock size={10} />
              {when}
            </span>
          )}
          {model && <span className="text-[var(--color-border-strong)]">·</span>}
          {model && <span className="truncate">{model}</span>}
          {shortId && <span className="text-[var(--color-border-strong)]">·</span>}
          {shortId && <span className="font-mono">{shortId}</span>}
        </span>
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
        <span className="rounded-md border border-[var(--color-border)] px-1.5 py-0.5 font-sans text-[10px] text-[var(--color-faint)]">
          {sourceLabel}
        </span>
        {active && (
          <span className="inline-flex items-center gap-1 rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-panel)] px-1.5 py-0.5 font-sans text-[10px] text-[var(--color-text-2)]">
            resume
            <CornerDownLeft size={11} />
          </span>
        )}
      </span>
    </button>
  );
}

/** Faint inline pill noting which past session this chat was resumed from. */
function ResumedNote({ title, onClear }: { title: string; onClear: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-panel)]/70 px-2.5 py-1 font-sans text-[11px] text-[var(--color-text-2)]">
      <RotateCcw size={11} className="shrink-0 text-[var(--color-accent)]" />
      <span className="truncate">resumed: {title}</span>
      <button
        type="button"
        onClick={onClear}
        title="dismiss"
        className="ml-0.5 shrink-0 rounded-full p-0.5 text-[var(--color-muted)] hover:text-[var(--color-text)]"
      >
        <X size={11} />
      </button>
    </span>
  );
}
