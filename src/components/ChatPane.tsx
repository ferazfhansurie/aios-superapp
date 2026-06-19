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
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Channel } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  ArrowUp,
  ArrowDown,
  PackageOpen,
  AtSign,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  CornerDownLeft,
  FileCode,
  FileText,
  FileType,
  Folder,
  Gauge,
  HelpCircle,
  History,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Mic,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldQuestion,
  Slash,
  Sparkles,
  Square,
  Target,
  Waypoints,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  buildApprovalLine,
  chatInterrupt,
  chatDetach,
  chatReattach,
  chatSend,
  chatSendRaw,
  chatSetTitle,
  chatStart,
  chatStop,
  webChatSend,
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
  type WebChatTurn,
} from "../lib/chat";
import { fileSrc, readDir, saveImageTemp, type DirEntry } from "../lib/fs";
import { loadSettings, saveSettings } from "../lib/settings";
import { idleRate, codexRate, resetIn } from "../lib/dashboard";
import { getMission, listAgents, wrmsSeedTasks } from "../lib/agents";
import {
  buildChatContextCapsule,
  composerContextChips,
  contextLedger,
  cycleQueueSelection,
  effortChipLabel,
  moveQueuedMessage,
  queueMessage,
  removeQueuedMessage,
  resumeTitle,
  sendContract,
  stopStrategy,
  updateQueuedMessage,
  usageStack,
  type ChatContextTurn,
  type ChatWorkspaceContext,
  type ContextBudgetMode,
  type QueuedMessage,
} from "../lib/chatPaneState";
import { usagePaceRisk } from "../lib/usagePace";
import { dictateCancel, dictateStart, dictateStop } from "../lib/voice";
import {
  chatHandles,
  chatSessions,
  paneWriters,
  paneSubmitters,
  paneImageDrop,
  openEditorFileInPane,
  openFileInPane,
  openViewerFileInPane,
  revealFileInPane,
} from "../lib/paneBus";
import { resolvePaneFileTarget, targetLabel } from "../lib/paneRouting";
import {
  emptyRunEventState,
  parseRunEventState,
  reduceRunEvents,
  serializeRunEventState,
  type RunEventState,
} from "../lib/runEvents";
import {
  finalizeStreamingTurns,
  reduceChatStreamEvent,
  type ChatTurn,
  type ChatStreamState,
} from "../lib/chatStream";
import { memorySearch, type MemoryHit } from "../lib/memory";
import {
  AUTOSCROLL_STICK_THRESHOLD_PX,
  distanceFromBottom,
  nextAutoscrollPaused,
  shouldAutoscroll,
  type ScrollIntent,
} from "../lib/chatScroll";
import { invoke, isTauriRuntime } from "../lib/tauri";
import {
  baseName,
  extFromMime,
  fmtClock,
  fmtDuration,
  fmtElapsed,
  fmtRelativeTime,
  uid,
} from "./chat/chatFormat";
import {
  ChatCwdContext,
  ChatFileOpenContext,
  useChatFileOpener,
  type ChatFileOpener,
} from "./chat/chatContext";
import {
  artifactFromTool,
  tokensFromUsage,
  toolFilePath,
  toolIcon,
  toolTarget,
  toolVerb,
  type Artifact,
  type ToolTurn,
} from "./chat/toolPresentation";
import { CopyButton, Markdown, parseButtons } from "./chat/ChatMarkdown";
import { ApprovalCard, QuestionCard } from "./chat/ApprovalCards";
import { PaneDropZone } from "./PaneDropZone";
import { reportDiag } from "../lib/diag";
import { pushNotification } from "../lib/notifications";

// ── transcript model ──────────────────────────────────────────────────────

/**
 * Mid-turn steer, per engine (backed by chat.rs `chat_steer`): claude injects
 * the user line (with image content blocks) into the persistent process's
 * stdin — verified against claude 2.1.170, the line is folded into the SAME
 * running turn; codex fires `turn/steer` (text-only). Rejects (no live turn /
 * unsupported engine / codex+images) → caller falls back to the queue.
 * lib/chat.ts's `chatSteer` wrapper is owned by another track and still
 * text-only, so the command is invoked directly here for the image arg.
 */
const steerTurn = (id: number, text: string, imagePaths?: string[]) =>
  invoke<void>("chat_steer", { sessionId: id, text, imagePaths: imagePaths ?? null });

type Turn = ChatTurn;

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
  // an AskUserQuestion tool call, lifted OUT of the collapsed activity group so
  // the question + options render as a tappable card instead of being buried.
  | { kind: "question"; id: string; turn: ToolTurn }
  | { kind: "result"; id: string; turn: Extract<Turn, { kind: "result" }> }
  | { kind: "activity"; id: string; tools: ToolTurn[]; durationMs?: number };

/** High-frequency streaming token events that are safe to batch on a rAF tick
 *  (text/thinking deltas). Structural events — assistant finals, tool results,
 *  result, control_request/response, system — are NOT coalescable and must be
 *  applied promptly and in order. */
function isCoalescableDelta(ev: ChatEvent): boolean {
  return (
    ev.type === "stream_event" &&
    ev.event?.type === "content_block_delta" &&
    (ev.event.delta?.type === "text_delta" ||
      ev.event.delta?.type === "thinking_delta")
  );
}

/** Debounced localStorage persist. `serialize` returns the string to write, or
 *  null to remove the key. Trailing debounce coalesces rapid changes into one
 *  write — critical for state that updates per stream-token (serializing the
 *  run-event log on every token was a major source of streaming jank). Always
 *  flushes the latest value on unmount so nothing is lost. */
function useDebouncedPersist<T>(
  key: string | null,
  value: T,
  serialize: (v: T) => string | null,
  delayMs: number,
) {
  const ref = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    key: string | null;
    value: T;
    serialize: (v: T) => string | null;
  }>({ timer: null, key, value, serialize });
  ref.current.key = key;
  ref.current.value = value;
  ref.current.serialize = serialize;

  const flush = () => {
    const r = ref.current;
    if (!r.key) return;
    try {
      const s = r.serialize(r.value);
      if (s == null) localStorage.removeItem(r.key);
      else localStorage.setItem(r.key, s);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!key) return;
    const r = ref.current;
    if (r.timer != null) return; // a flush is already scheduled; it reads latest
    r.timer = setTimeout(() => {
      r.timer = null;
      flush();
    }, delayMs);
    // value/key tracked via ref; effect just (re)arms the trailing timer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value, delayMs]);

  useEffect(
    () => () => {
      const r = ref.current;
      if (r.timer != null) {
        clearTimeout(r.timer);
        r.timer = null;
      }
      flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}
type ChatUsageRate = Awaited<ReturnType<typeof codexRate>>;
type UsageWin = { pct: number | null; resetsAt: number | null };
type UsageSnapshot = { fiveHour: UsageWin; sevenDay: UsageWin };

function isSparkModel(modelId: string): boolean {
  return /^gpt-5\.3-codex-spark$/i.test(modelId);
}

function usageProviderKey(model: ChatModel): string {
  if ((model.engine ?? "claude") === "codex" && isSparkModel(model.id)) {
    return "codex:gpt-5.3-spark";
  }
  return model.engine ?? "claude";
}

function usageProviderLabel(model: ChatModel): string {
  if ((model.engine ?? "claude") === "codex" && isSparkModel(model.id)) {
    return "gpt-5.3 spark";
  }
  return model.engine ?? "claude";
}

function codexUsageForModel(r: ChatUsageRate, model: ChatModel): UsageSnapshot | null {
  if ((model.engine ?? "claude") !== "codex") return null;
  if (!isSparkModel(model.id)) {
    return { fiveHour: r.fiveHour, sevenDay: r.sevenDay };
  }
  const sparkEntry =
    r.models[model.id] ??
    Object.entries(r.models).find(([id]) => /^gpt-5\.3-codex-spark$/i.test(id))?.[1];
  return sparkEntry ?? { fiveHour: r.fiveHour, sevenDay: r.sevenDay };
}

function hasUsageData(snapshot: UsageSnapshot | null): snapshot is UsageSnapshot {
  if (!snapshot) return false;
  return snapshot.fiveHour.pct != null || snapshot.sevenDay.pct != null;
}

function normalizeUsage(
  raw: Awaited<ReturnType<typeof idleRate>> | ChatUsageRate,
  provider: string,
  model: ChatModel,
): UsageSnapshot {
  if (provider === "codex" || provider === "codex:gpt-5.3-spark") {
    return codexUsageForModel(raw as ChatUsageRate, model) ?? {
      fiveHour: { pct: null, resetsAt: null },
      sevenDay: { pct: null, resetsAt: null },
    };
  }
  const normalized = raw as Awaited<ReturnType<typeof idleRate>>;
  return {
    fiveHour: normalized.fiveHour,
    sevenDay: normalized.sevenDay,
  };
}

/** A pasted/attached image: live thumbnail + its saved temp path (null while saving). */
interface ImageChip {
  id: string;
  url: string;
  path: string | null;
}
let _imgSeq = 0;
/** Precomputed equalizer bars for the inline dictation waveform (time-keyed). */
const WAVEFORM_BARS: { h: number; delay: number }[] = Array.from(
  { length: 40 },
  (_, i) => ({ h: 28 + ((i * 37) % 60), delay: (i * 70) % 900 }),
);
const WAVE_KEYFRAMES = `@keyframes aios-wave {
  0%, 100% { transform: scaleY(0.32); opacity: 0.55; }
  50% { transform: scaleY(1); opacity: 1; }
}`;

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

const CONTEXT_BUDGETS: Array<{ id: ContextBudgetMode; label: string; sub: string }> = [
  { id: "lean", label: "lean", sub: "stripped codex home, explicit context only" },
  { id: "agent", label: "agent", sub: "terminal-grade tools and instructions" },
  { id: "ultracode", label: "ultracode", sub: "xhigh + fanout, expensive by design" },
];

function memoryContextBlock(memories: MemoryHit[]): string {
  if (memories.length === 0) return "";
  return `Relevant AIOS memory context:\n${memories
    .map((m, i) => {
      const reasons = m.reasons.length ? ` reasons: ${m.reasons.join("; ")}` : "";
      return `${i + 1}. ${m.title} [${m.type}] — ${m.description || m.preview}${reasons}`;
    })
    .join("\n")}\n\n`;
}

function recentTurnsForContext(turns: Turn[]): ChatContextTurn[] {
  return turns
    .filter(
      (turn): turn is Extract<Turn, { kind: "user" | "assistant" | "result" }> =>
        turn.kind === "user" || turn.kind === "assistant" || turn.kind === "result",
    )
    .map((turn) => ({
      kind: turn.kind,
      text: turn.text,
    }))
    .slice(-8);
}

/** Resolve a file reference against `cwd` (backend existence check) and open it
 *  in a pane. Absolute/`~` paths skip resolution. Falls back to a BOUNDED fuzzy
 *  basename match via `find_files` only when an exact join fails — never a blind
 *  name search. Silent if nothing real resolves (no broken pane spawn). */
async function openChatFileReference(ref: string, cwd?: string | null): Promise<void> {
  const normalized = resolvePaneFileTarget(ref);
  // Absolute or home paths are already concrete — open directly (paneForFile
  // handles the existence/decoding). This matches harvested tool paths too.
  if (normalized.startsWith("/") || normalized.startsWith("~/")) {
    openFileInPane(normalized, targetLabel(normalized));
    return;
  }
  if (!isTauriRuntime() || !cwd) {
    // can't existence-check without a backend/cwd → best-effort as-is.
    openFileInPane(normalized, targetLabel(normalized));
    return;
  }
  try {
    const resolved = await invoke<string | null>("resolve_in_cwd", {
      cwd,
      reference: normalized,
    });
    if (resolved) {
      openFileInPane(resolved, targetLabel(resolved));
      return;
    }
    // last resort: bounded fuzzy basename match (exact join already failed).
    const base = targetLabel(normalized).toLowerCase();
    if (base.includes(".")) {
      const files = await invoke<string[]>("find_files", { root: cwd, max: 20000 });
      const hit =
        files.find((f) => f.toLowerCase().endsWith(`/${base}`)) ??
        files.find((f) => f.toLowerCase() === base);
      if (hit) {
        const abs = hit.startsWith("/") ? hit : `${cwd.replace(/\/+$/, "")}/${hit}`;
        openFileInPane(abs, targetLabel(abs));
      }
    }
  } catch {
    /* resolution failed → don't open a broken pane */
  }
}

// ── component ────────────────────────────────────────────────────────────────

const runEventsStorageKey = (sessionId: string) => `aios.chat.run-events:${sessionId}`;

export function ChatPane({
  cwd,
  paneKey,
  active,
  hidden,
  seed,
  resume,
  reattach,
  modelId,
  agentLabel,
  workspaceContext,
  onOpenUrl,
  onChatSession,
}: {
  cwd?: string;
  paneKey?: string;
  /** True when this is the focused/active pane. Drives composer auto-focus on
   *  becoming active (and on mount) — but never steals focus mid-action. */
  active?: boolean;
  /** True when the pane is minimized out of the grid (display:none). A hidden
   *  chat that hits a tool-approval prompt is invisible — so we fire a
   *  high-priority `chat.needs_input` notification that reattaches on click. */
  hidden?: boolean;
  seed?: string;
  modelId?: string;
  agentLabel?: string;
  workspaceContext?: ChatWorkspaceContext;
  /** Resume a prior chat session on mount (from the idle "continue" rail).
   *  engine/model carry the saved session's backend so a resumed codex thread
   *  boots on codex (not the default claude) — otherwise --resume sends a codex
   *  thread-id to the claude binary and the pane comes up blank. */
  resume?: { id: string; title: string; engine?: string; model?: string };
  /** Reattach to a still-live backgrounded session by its backend id (from the
   *  "running" tray) — replays its buffer and continues live instead of spawning. */
  reattach?: number;
  /** Open an http(s) link from rendered markdown in an in-app browser pane. */
  onOpenUrl?: (url: string) => void;
  /** Reports the LIVE chat session id (+ title/engine/model) up to the owning
   *  pane so it can be recorded into pane history WITH a resume handle. Without
   *  this, reopening a chat from history spawns a FRESH pane instead of
   *  continuing the conversation (the kind never learned its session id). */
  onChatSession?: (info: { id: string; title: string; engine?: string; model?: string }) => void;
}) {
  const nativeRuntime = useMemo(() => isTauriRuntime(), []);
  const webChatRuntime = !nativeRuntime;
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const [runEventState, setRunEventState] = useState<RunEventState>(() =>
    emptyRunEventState(),
  );
  const [runEventsKey, setRunEventsKey] = useState<string | null>(() =>
    resume?.id ? runEventsStorageKey(resume.id) : null,
  );
  useEffect(() => {
    if (!runEventsKey) return;
    try {
      const restored = parseRunEventState(localStorage.getItem(runEventsKey));
      if (!restored) return;
      setRunEventState((current) =>
        current.events.length > 0 ? current : restored,
      );
    } catch {
      /* ignore */
    }
  }, [runEventsKey]);
  // runEventState changes on every stream token and serializeRunEventState does
  // a full JSON.stringify of the (growing) event log — writing it synchronously
  // per token was the single biggest source of streaming lag. Debounce it.
  useDebouncedPersist(
    runEventsKey,
    runEventState,
    (s) => (s.events.length > 0 ? serializeRunEventState(s) : null),
    500,
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
  // persist the draft as it changes (cleared on send) — debounced so we don't
  // hit localStorage synchronously on every keystroke.
  useDebouncedPersist(draftKey, input, (v) => (v ? v : null), 300);
  const [isComposerCollapsed, setComposerCollapsed] = useState(false);

  const [streaming, setStreaming] = useState(false);
  const [backendBusy, setBackendBusy] = useState(false);
  const [started, setStarted] = useState(false);
  // claude's init event arrived (session_id known) — gates the seed auto-send
  // claudeReady is still tracked (init-event signal) but no longer gates the
  // seed auto-send — the retry loop polls sessionIdRef directly. Value unused.
  const [, setClaudeReady] = useState(false);

  // composer settings — boot from the saved default (settings.chatModel).
  // The model the user last picked in the composer IS their default; persisted
  // so codex / opus / whatever sticks across panes + restarts.
  const [model, setModel] = useState<ChatModel>(() => {
    // Resuming a prior chat: honor its saved model/engine FIRST so a codex thread
    // doesn't boot on claude (which would mis-route --resume to the wrong binary).
    if (resume?.model) {
      const byId = CHAT_MODELS.find((m) => m.id === resume.model);
      if (byId) return byId;
    }
    if (resume?.engine) {
      const byEngine = CHAT_MODELS.find((m) => (m.engine ?? "claude") === resume.engine);
      if (byEngine) return byEngine;
    }
    const preferred = modelId ?? loadSettings().chatModel;
    return CHAT_MODELS.find((m) => m.id === preferred) ?? CHAT_MODELS[0];
  });
  const [permission, setPermission] = useState(PERMISSION_MODES[0]);
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>(EFFORTS[1]);
  const [contextBudget, setContextBudget] = useState<ContextBudgetMode>("agent");
  const effectiveBudget: ContextBudgetMode =
    contextBudget === "ultracode" || effort.ultra ? "ultracode" : contextBudget;
  // running context size (prompt tokens of the latest turn) → composer indicator
  const [ctxTokens, setCtxTokens] = useState<number | null>(null);
  const activeModelRef = useRef(model);
  useEffect(() => {
    activeModelRef.current = model;
  }, [model.id, model.engine]);

  // ── live usage bar (Phase 1) ───────────────────────────────────────────────
  // The active engine's 5h/7d rate-limit windows, ticked as you talk: codex
  // pushes account/rateLimits/updated, claude re-reads usage.json after each turn
  // (both arrive as synthetic `usage` events from chat.rs). Seeded once on mount.
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
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [handoffPanelOpen, setHandoffPanelOpen] = useState(false);
  const [memoryHits, setMemoryHits] = useState<MemoryHit[]>([]);
  const [attachedMemoryPaths, setAttachedMemoryPaths] = useState<string[]>([]);
  const [lastAutoMemories, setLastAutoMemories] = useState<MemoryHit[]>([]);
  const [memoryContextStatus, setMemoryContextStatus] = useState<"ready" | "searching" | "error">("ready");
  const attachedMemories = useMemo(
    () => attachedMemoryPaths
      .map((path) => memoryHits.find((hit) => hit.path === path))
      .filter((hit): hit is MemoryHit => Boolean(hit)),
    [attachedMemoryPaths, memoryHits],
  );
  const openMemoryPanel = useCallback(() => {
    setMemoryPanelOpen(true);
  }, []);

  useEffect(() => {
    if (!memoryPanelOpen) {
      setMemoryHits([]);
      return;
    }
    const q = input.trim();
    if (q.length < 2) {
      setMemoryHits([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      memorySearch(q, cwd ?? null, 5)
        .then((hits) => {
          if (cancelled) return;
          setMemoryHits(hits);
          setAttachedMemoryPaths((paths) => paths.filter((path) => hits.some((h) => h.path === path)));
        })
        .catch(() => {
          if (!cancelled) setMemoryHits([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [input, cwd, memoryPanelOpen]);

  // open-dropdown tracking (single source so only one is open)
  const [openMenu, setOpenMenu] = useState<null | "model" | "perm" | "effort" | "advanced">(
    null,
  );

  // overlay popovers anchored to the composer (slash menu / @-files / resume)
  const [overlay, setOverlay] = useState<null | "slash" | "mention" | "resume">(
    null,
  );
  const [overlayIdx, setOverlayIdx] = useState(0);
  const [mentionItems, setMentionItems] = useState<DirEntry[]>([]);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionPrefix, setMentionPrefix] = useState("");

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
  // best-known human label for THIS chat, mirrored into a ref so the stable-deps
  // handleEvent closure can name it in a notification without going stale.
  const chatTitleRef = useRef<string>("");
  chatTitleRef.current = agentLabel ?? resumedTitle ?? "";
  // reactive mirror of claudeSessionIdRef — the engine session id currently open
  // in THIS pane, so the /resume picker can highlight "the one you're in".
  const [openSessionId, setOpenSessionId] = useState<string | null>(resume?.id ?? null);

  // Report the live engine session id up to the owning pane the moment it's
  // known (fresh chat establishes one, or a resume re-keys to a fork) so pane
  // history records this chat WITH a resume handle — that's what makes
  // reopening it from history CONTINUE the conversation instead of opening a
  // fresh pane. The send path fires onChatSession again with a better title.
  useEffect(() => {
    if (!openSessionId) return;
    const m = activeModelRef.current;
    onChatSession?.({
      id: openSessionId,
      title: chatTitleRef.current || resume?.title || "chat",
      engine: m.engine ?? "claude",
      model: m.id,
    });
    // chatTitleRef is a ref (not reactive); resumedTitle drives its value, so we
    // depend on it to re-fire when the human label is established.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSessionId, onChatSession, resumedTitle]);

  const sessionIdRef = useRef<number | null>(null);
  const webAbortRef = useRef<AbortController | null>(null);
  // live mirror of `streaming` for the close-handle closure (a turn in flight).
  const activeRunRef = useRef(false);
  activeRunRef.current = streaming || backendBusy;
  // set true when the pane is intentionally detached (kept running) — tells the
  // unmount cleanup NOT to kill the claude process.
  const detachedRef = useRef(false);
  // live mirror of "this chat is out of sight" for the (stable-deps) handleEvent
  // closure — so a tool-approval landing on a minimized OR detached pane can fire
  // a notification without re-creating handleEvent. Declared AFTER detachedRef so
  // it can read it (no TDZ).
  const hiddenRef = useRef(false);
  hiddenRef.current = (hidden ?? false) || detachedRef.current;
  // the `reattach` id whose background session this pane is currently bound to
  // AND whose engine/model we auto-synced into `model` state. While set, a
  // session-effect re-fire CAUSED by that auto-resync is a no-op (don't
  // re-replay the buffer or kill the externally-owned session). A MANUAL model
  // switch clears it (see below) so the pane re-spins on the new engine.
  const reattachBoundRef = useRef<number | null>(null);
  // armed right before the resync setModel; the very next session-effect cleanup
  // consumes it to SKIP teardown (that re-run is the benign resync, not a real
  // model change or unmount). Closure-independent, so no stale-model.id race.
  const skipResyncTeardownRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // index into `turns` of the assistant bubble currently being streamed
  const streamingTurnId = useRef<string | null>(null);
  // id of the thinking block currently being streamed (own block, precedes text)
  const thinkingTurnId = useRef<string | null>(null);
  // high-frequency stream deltas are buffered here and flushed on a single rAF
  // tick (≤~60Hz) instead of one state update per token — caps the render storm,
  // markdown re-parses, and layout reads regardless of how fast the model emits.
  const pendingDeltasRef = useRef<ChatEvent[]>([]);
  const rafRef = useRef<number | null>(null);
  // last user prompt text actually sent to claude (for regenerate)
  const lastSentRef = useRef<string | null>(null);
  const stopChatRef = useRef<() => void>(() => {});
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
  // wall-clock ms the in-flight turn began (null = idle). Changes at most once
  // per turn — NOT every second. The 1Hz "Working… m:ss" tick lives entirely
  // inside the <WorkingLine>/<ActivityGroup> leaves (useLiveElapsed) so the
  // running clock re-renders ONLY that subtree, never the whole message list.
  const [liveStart, setLiveStart] = useState<number | null>(null);
  // keep the latest input in a ref so the unmount writer-cleanup never goes stale
  const inputRef = useRef(input);
  inputRef.current = input;

  const empty = turns.length === 0;
  const usageProvider = usageProviderKey(model);
  const usageLabel = usageProviderLabel(model);

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

  // ── auto-focus the composer ────────────────────────────────────────────────
  // Focus the composer textarea when the pane MOUNTS and each time it BECOMES
  // the active pane (false→true transition only — never on every render). Don't
  // steal focus if the user is already typing/selecting in an editable field
  // (e.g. a terminal/editor/composer in another pane): only grab focus when the
  // current focus isn't an interactive input the user is mid-action in. Runs on
  // a rAF so it lands after the pane's layout/visibility settles.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    const isActive = active ?? true; // panes without an active signal focus on mount
    const becameActive = isActive && !wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (!becameActive) return;
    const ta = taRef.current;
    if (!ta) return;
    const raf = requestAnimationFrame(() => {
      // don't yank focus out from under a user mid-action in ANOTHER editable.
      const el = document.activeElement as HTMLElement | null;
      const inThisPane = el ? ta.closest("[data-chat-pane]")?.contains(el) : false;
      const editingElsewhere =
        el != null &&
        !inThisPane &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable ||
          // terminal/browser webviews capture keys via these
          el.tagName === "CANVAS" ||
          el.tagName === "IFRAME" ||
          el.tagName === "WEBVIEW");
      if (editingElsewhere) return;
      ta.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  // A path dragged from another pane (Files) → append it to the composer.
  const insertPath = useCallback((path: string) => {
    setInput((v) => (v ? v.trimEnd() + " " + path + " " : path + " "));
    taRef.current?.focus();
  }, []);

  // Deterministic in-chat file open, bound to THIS session's cwd. Provided via
  // context so deep markdown/tool renderers can open files without threading cwd.
  const openChatFile = useCallback<ChatFileOpener>(
    (ref: string) => {
      void openChatFileReference(ref, cwd);
    },
    [cwd],
  );

  // ── image attach: paste a screenshot / pick a file → temp file + thumbnail ──
  const [images, setImages] = useState<ImageChip[]>([]);
  // Live mirror of `images` so an async send can read the freshest paths after
  // awaiting in-flight saves (the closure-captured `images` would be stale).
  // SYNCHRONOUS mirror via setImagesSync: the old effect-synced ref lagged React
  // state by one commit, so a paste→Enter race could resolve the save (clearing
  // pendingSavesRef) before the effect copied the path into imagesRef — and
  // sendText then filtered the null-path chip out and shipped a text-only turn
  // (the "image never reaches the model" bug). Updating the ref inside the same
  // call that updates state removes that window entirely.
  const imagesRef = useRef<ImageChip[]>([]);
  const setImagesSync = useCallback(
    (updater: (prev: ImageChip[]) => ImageChip[]) => {
      setImages((prev) => {
        const next = updater(prev);
        imagesRef.current = next;
        return next;
      });
    },
    [],
  );
  // In-flight disk-save promises, keyed by chip id. send() awaits these so a
  // fast paste→Enter can't ship the turn before the image finishes saving.
  const pendingSavesRef = useRef<Map<string, Promise<void>>>(new Map());
  const imgInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addImage = useCallback(async (file: Blob, mime: string) => {
    const id = `img${++_imgSeq}`;
    const url = URL.createObjectURL(file);
    reportDiag("chat.image", "addImage:start", { id, mime, size: file.size });
    setImagesSync((prev) => [...prev, { id, url, path: null }]);
    const save = (async () => {
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        const path = await saveImageTemp(btoa(bin), extFromMime(mime));
        reportDiag("chat.image", "addImage:saved", { id, path });
        setImagesSync((prev) => prev.map((im) => (im.id === id ? { ...im, path } : im)));
      } catch (e) {
        reportDiag("chat.image", e, { action: "addImage:saveFailed", id });
        // surface the failure instead of vanishing the thumbnail silently —
        // otherwise the user thinks the image attached when it didn't.
        setImagesSync((prev) => {
          const gone = prev.find((im) => im.id === id);
          if (gone) URL.revokeObjectURL(gone.url);
          return prev.filter((im) => im.id !== id);
        });
        setTurns((prev) => [
          ...prev,
          { kind: "result", id: uid(), text: "couldn't attach that image (unsupported format or save failed) — not sent." },
        ]);
      } finally {
        pendingSavesRef.current.delete(id);
      }
    })();
    pendingSavesRef.current.set(id, save);
    await save;
  }, [setImagesSync]);
  const removeImage = useCallback((id: string) => {
    setImagesSync((prev) => {
      const gone = prev.find((im) => im.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((im) => im.id !== id);
    });
  }, [setImagesSync]);

  // Attach an image that already lives on disk (an OS file drop from Finder /
  // the desktop). Tauri's native drag-drop hands us a path, not a Blob, so we
  // skip the saveImageTemp round-trip: the chip's thumbnail renders straight off
  // the asset-protocol URL, and `path` is set immediately (already on disk).
  const addImageByPath = useCallback((path: string) => {
    const id = `img${++_imgSeq}`;
    reportDiag("chat.image", "addImageByPath", { id, path });
    setImagesSync((prev) => [...prev, { id, url: fileSrc(path), path }]);
  }, [setImagesSync]);

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
  const attachPickedFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      let missingPath = 0;
      for (const f of Array.from(files)) {
        if (f.type.startsWith("image/")) {
          void addImage(f, f.type);
          continue;
        }
        const path = (f as File & { path?: string }).path;
        if (path) insertPath(path);
        else missingPath += 1;
      }
      if (missingPath > 0) {
        setTurns((prev) => [
          ...prev,
          {
            kind: "result",
            id: uid(),
            text: "couldn't attach that file directly. drag it from files/finder into the chatpane, or mention it with @path.",
          },
        ]);
      }
    },
    [addImage, insertPath],
  );
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

  // applies ONE event synchronously (the full ingestion logic). handleEvent
  // below wraps this to coalesce high-frequency deltas; everything else flushes
  // the buffer first (to preserve order) then applies synchronously here.
  const applyEvent = useCallback((ev: ChatEvent) => {
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
        // If this chat is OUT OF SIGHT (minimized or detached), firaz has no idea
        // it's blocked waiting on him. Fire a high-priority, clickable notification
        // that reattaches to the approval card. Foreground chats stay silent — the
        // inline card is already visible. De-dupe is handled by the store (one live
        // needs_input per session). Skipped when the backend id isn't known yet.
        const sid = sessionIdRef.current;
        if (hiddenRef.current && sid != null && sid > 0) {
          pushNotification({
            kind: "chat.needs_input",
            level: "warning",
            priority: "high",
            sourceLabel: "chat",
            title: "chat needs your input",
            body: `${chatTitleRef.current || "a background chat"} is waiting to run ${String(toolName)}.`,
            target: { type: "chat", sessionId: sid, title: chatTitleRef.current || "chat" },
          });
        }
      }
      return;
    }
    if (ev.type === "control_response") {
      // ack of our interrupt; nothing to display.
      return;
    }

    const reduced = (() => {
      let handled = false;
      setTurns((prev) => {
        const result = reduceChatStreamEvent(
          {
            turns: prev,
            streamingTurnId: streamingTurnId.current,
            thinkingTurnId: thinkingTurnId.current,
          },
          ev,
          { now: Date.now(), uid },
        );
        if (!result.handled) return prev;
        handled = true;
        streamingTurnId.current = result.state.streamingTurnId;
        thinkingTurnId.current = result.state.thinkingTurnId;
        return result.state.turns;
      });
      return handled;
    })();
    if (reduced) return;

    switch (ev.type) {
      // final result for the turn → faint footer + close the streaming bubble
      case "result": {
        setTurns((prev) => {
          const finalized = finalizeStreamingTurns(
            {
              turns: prev,
              streamingTurnId: streamingTurnId.current,
              thinkingTurnId: thinkingTurnId.current,
            },
            Date.now(),
          );
          return finalized.turns;
        });
        streamingTurnId.current = null;
        thinkingTurnId.current = null;
        setStreaming(false);
        setBackendBusy(false);
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
        const resultText = typeof ev.text === "string" ? ev.text.trim() : "";
        // cost intentionally omitted — firaz runs on subs, $ figures are noise.
        const foot = [resultText, dur, tokStr].filter(Boolean).join(" · ");
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
        setBackendBusy(false);
        return;
      }

      // live usage tick (synthetic, from chat.rs) → move the composer's usage bar
      case "usage": {
        // Codex's app-server push can describe a model-specific CLI bucket. The
        // desktop usage panel uses /backend-api/wham/usage, so re-read that exact
        // account source instead of letting the push overwrite the visible meter.
        if ((ev.provider ?? "claude") === "codex") {
          const current = activeModelRef.current;
          void codexRate().then((r) => {
            const snap = codexUsageForModel(r, current);
            if (hasUsageData(snap)) {
              rememberUsage(usageProviderKey(current), snap);
            }
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
        if (ev.session_id) {
          const prev = claudeSessionIdRef.current;
          // claude's `--resume` emits a FRESH session_id and writes continued
          // turns to a new <id>.jsonl. If we were already recorded (a resume),
          // re-key the store entry to the new id — otherwise the next resume
          // reads the old transcript (truncated at the fork) and re-forks again.
          if (prev && prev !== ev.session_id && recordedRef.current) {
            const m = activeModelRef.current;
            const title = resume?.title ?? "chat";
            // re-keying on a resume fork is bookkeeping, not real activity →
            // don't bump mtime (preserve the session's genuine recency order).
            recordChatSession(ev.session_id, title, cwd ?? null, m.engine ?? "claude", m.id, false).catch((e) => reportDiag("chat.session", e, { action: "record" }));
          }
          claudeSessionIdRef.current = ev.session_id;
          setOpenSessionId(ev.session_id);
          setRunEventsKey(runEventsStorageKey(ev.session_id));
        }
        setClaudeReady(true);
        return;
      }

      // hooks / rate-limit / anything else → ignored in the transcript
      default:
        return;
    }
  }, [rememberUsage]);

  // Apply all buffered stream deltas in ONE pass: a single setRunEventState fold
  // and a single setTurns fold (threading the streaming/thinking ids through),
  // so N tokens cost one render instead of N. Safe to call anytime; no-op when
  // the buffer is empty. Cancels any pending rAF.
  const flushPending = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const evs = pendingDeltasRef.current;
    if (evs.length === 0) return;
    pendingDeltasRef.current = [];
    setRunEventState((state) => evs.reduce((s, e) => reduceRunEvents(s, e), state));
    setTurns((prev) => {
      let st: ChatStreamState = {
        turns: prev,
        streamingTurnId: streamingTurnId.current,
        thinkingTurnId: thinkingTurnId.current,
      };
      const now = Date.now();
      for (const e of evs) {
        const r = reduceChatStreamEvent(st, e, { now, uid });
        if (r.handled) st = r.state;
      }
      streamingTurnId.current = st.streamingTurnId;
      thinkingTurnId.current = st.thinkingTurnId;
      return st.turns;
    });
  }, []);

  const handleEvent = useCallback(
    (ev: ChatEvent) => {
      // buffer high-frequency text/thinking deltas; everything else (assistant
      // finals, tool results, result, control, system) must apply promptly and
      // IN ORDER, so flush the buffer first then handle it synchronously.
      if (isCoalescableDelta(ev)) {
        pendingDeltasRef.current.push(ev);
        if (rafRef.current == null) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            flushPending();
          });
        }
        return;
      }
      flushPending();
      applyEvent(ev);
    },
    [applyEvent, flushPending],
  );

  // cancel any in-flight rAF on unmount so a buffered flush never fires a
  // setState into an unmounted component.
  useEffect(
    () => () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    },
    [],
  );

  // ── session lifecycle: one channel + one session per mount ─────────────────
  // `restartKey` lets `/clear` tear down + re-spin the session without changing
  // any of the model/permission deps.
  const [restartKey, setRestartKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    // The resync's setModel re-fired this effect. The previous cleanup already
    // skipped teardown (skipResyncTeardownRef), the session is live + bound — so
    // this run must NOT re-reattach (double buffer replay) nor spawn. No-op.
    // The flag was consumed by the cleanup; here we just detect+skip the body.
    if (reattach != null && reattachBoundRef.current === reattach) {
      // distinguish the benign resync re-run from a real model switch: a real
      // switch went through the cleanup WITHOUT the skip flag, which cleared
      // reattachBoundRef. So if we're still bound here, it's the resync re-run.
      return;
    }
    setStarted(false);
    setClaudeReady(false);
    setCtxTokens(null);
    if (webChatRuntime) {
      sessionIdRef.current = 0;
      claudeSessionIdRef.current = `web-${paneKey ?? "chat"}`;
      setRunEventsKey(runEventsStorageKey(claudeSessionIdRef.current));
      setStarted(true);
      setClaudeReady(true);
      return () => {
        webAbortRef.current?.abort();
        webAbortRef.current = null;
        sessionIdRef.current = null;
      };
    }
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
    // On reattach the backend reports the session's real engine/model so we can
    // re-sync `model` state — otherwise a reattached codex run stays on the
    // default claude state (wrong stop-strategy, steer hidden, wrong usage).
    const startup =
      reattach != null
        ? chatReattach(reattach, chan).then((info) => ({
            id: reattach,
            busy: info.busy,
            engine: info.engine,
            model: info.model,
          }))
        : chatStart(chan, {
            engine: model.engine ?? "claude",
            cwd: cwd ?? null,
            model: model.disabled ? null : model.id,
            permissionMode: permission.id,
            // ultracode isn't a real --effort value; run it as xhigh (the
            // "+ workflows" half is applied per-message via ULTRA_PREFIX).
            effort: effectiveBudget === "ultracode" ? "xhigh" : effort.id,
            fast: effectiveBudget === "lean",
            resume: resumeId,
            // route claude turns through the Headroom compression proxy when
            // the cockpit toggle is on (claude engine only; rust ignores it
            // for codex/opencode).
            headroom:
              (model.engine ?? "claude") === "claude" &&
              loadSettings().headroomCompression,
            // box-backed model → run the session on the node instead of locally.
            node: model.node ?? null,
          }).then((id) => ({
            id,
            busy: false,
            engine: null as string | null,
            model: null as string | null,
          }));

    startup
      .then(({ id, busy, engine: liveEngine, model: liveModel }) => {
        if (disposed) {
          // only kill a freshly-spawned session we're abandoning; never a reattach.
          if (reattach == null) chatStop(id).catch((e) => reportDiag("chat.stop", e, { action: "stop" }));
          return;
        }
        // Reattach: mark this session bound (so the model re-sync below can't
        // re-replay it) and re-sync `model` state to the session's REAL
        // engine/model so stop-strategy, steer visibility, and usage provider
        // all match the engine that's actually running (not default claude).
        if (reattach != null) {
          reattachBoundRef.current = reattach;
          if (liveEngine) {
            const restored =
              (liveModel ? CHAT_MODELS.find((m) => m.id === liveModel) : undefined) ??
              CHAT_MODELS.find((m) => (m.engine ?? "claude") === liveEngine);
            if (restored && restored.id !== model.id) {
              // arm: the cleanup fired by this setModel must skip teardown.
              skipResyncTeardownRef.current = true;
              setModel(restored);
            }
          }
        }
        sessionIdRef.current = id;
        // Register the pane → backend-session-id binding so a notification click
        // (chat.done / chat.needs_input) can resolve "is this chat still open?"
        // and focus it, or reattach it if its pane was closed.
        if (paneKey && id != null) chatSessions.set(paneKey, id);
        setBackendBusy(busy);
        if (busy && turnStartRef.current == null) {
          const t0 = Date.now();
          turnStartRef.current = t0;
          setLiveStart(t0);
        }
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
      // The benign resync re-run: skip teardown entirely (session stays live +
      // bound). Consume the flag; reattachBoundRef stays set so the re-run body
      // no-ops. Closure-independent, so no stale model.id race.
      if (skipResyncTeardownRef.current) {
        skipResyncTeardownRef.current = false;
        return;
      }
      // A real teardown (manual model switch, /clear, resume, unmount): this is
      // no longer a passive resync, so drop the reattach binding.
      reattachBoundRef.current = null;
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      if (paneKey) chatSessions.delete(paneKey);
      // Skip the kill when the pane was intentionally detached (kept running in
      // the background) — chat_detach already cleared the sink.
      if (id != null && !detachedRef.current) chatStop(id).catch((e) => reportDiag("chat.stop", e, { action: "cleanup" }));
    };
    // model/permission/effort/resumeId are captured at start; changing them restarts the session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.id, permission.id, effort.id, effectiveBudget, cwd, restartKey, resumeId, reattach, webChatRuntime, paneKey]);

  // Publish a close-handle so App can detach (keep running) vs kill a busy chat.
  useEffect(() => {
    if (!paneKey) return;
    chatHandles.set(paneKey, {
      busy: () => activeRunRef.current,
      stop: () => stopChatRef.current(),
      detach: (notify: boolean) => {
        const id = sessionIdRef.current;
        if (id != null) {
          detachedRef.current = true;
          chatDetach(id, notify).catch((e) => reportDiag("chat.detach", e, { action: "detach" }));
        }
      },
    });
    return () => {
      chatHandles.delete(paneKey);
      chatSessions.delete(paneKey);
    };
  }, [paneKey]);

  // Seed the usage bar once on mount (and on engine switch) so it shows BEFORE
  // the first turn ticks it — claude reads usage.json, codex reads logs_2.sqlite.
  // After this, live `usage` events keep it moving as you talk.
  useEffect(() => {
    let alive = true;
    const provider = usageProviderKey(model);
    const label = model.engine ?? "claude";
    const fn = label === "codex" ? codexRate : idleRate;
    fn()
      .then((r) => {
        const next = normalizeUsage(r, provider, model);
        if (alive && hasUsageData(next)) {
          rememberUsage(provider, next);
        }
      })
      .catch((e) => reportDiag("chat.load", e, { action: "usage" }));
    return () => {
      alive = false;
    };
  }, [model.engine, model.id, rememberUsage]);

  // Queue flush: when a turn finishes (streaming → false) and messages are
  // queued, fire the next one. Routed through refs so this effect isn't a dep of
  // the (changing) dispatch/sendText closures. One per turn → the queue drains
  // in order — ChatGPT-style "stack the next message while one streams".
  const dispatchRef = useRef<(text: string) => void>(() => {});
  // The queued message goes back through the FULL send path (sendText), not the
  // raw dispatch — so a queued claude message gets the same context capsule,
  // auto-memory, and session recording a normally-typed message would. Routing
  // queued sends through the bare `dispatch` was the "claude queue sucks" gap:
  // the follow-up landed without any of that context.
  const flushSendRef = useRef<(text: string, images?: string[]) => void>(() => {});
  useEffect(() => {
    if (streaming) return;
    if (!started) return;
    if (queuedRef.current.length === 0) return;
    if (sessionIdRef.current == null) return;
    const [next, ...rest] = queuedRef.current;
    setQueued(rest);
    setQueuedIdx((idx) => (rest.length === 0 ? 0 : Math.min(idx, rest.length - 1)));
    flushSendRef.current(next.text, next.images);
  }, [streaming, started]);

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
  const lastScrollTopRef = useRef(0);
  const lastArrowDownRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const syncJumpVisibility = useCallback((el: HTMLDivElement | null, paused = pausedRef.current) => {
    if (!el) {
      setShowJump(paused);
      return;
    }
    setShowJump(
      paused ||
        distanceFromBottom({
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
          clientHeight: el.clientHeight,
        }) > 24,
    );
  }, []);
  const setPaused = useCallback((p: boolean) => {
    pausedRef.current = p;
    syncJumpVisibility(scrollRef.current, p);
  }, [syncJumpVisibility]);
  useLayoutEffect(() => {
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
        // wide stick threshold so a fast token stream can't overshoot the bottom
        // and silently fall off; the scroll/wheel handlers still pause the moment
        // the user scrolls up, so this only affects auto-pinning.
        AUTOSCROLL_STICK_THRESHOLD_PX,
      )
    ) {
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
    }
    if (el) {
      lastScrollHeightRef.current = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
      syncJumpVisibility(el);
    } else {
      lastScrollHeightRef.current = 0;
      lastScrollTopRef.current = 0;
      syncJumpVisibility(null);
    }
    // `now` deliberately DROPPED from deps: it ticks every second from the 1Hz
    // timer and re-ran this layout effect (thrashing layout) without new content.
    // Content/stream changes already re-fire this; the running clock must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, streaming, liveStart, syncJumpVisibility]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // swallow the one scroll event our own pin just emitted
      if (programmaticRef.current) {
        programmaticRef.current = false;
        lastScrollTopRef.current = el.scrollTop;
        return;
      }
      const intent: ScrollIntent =
        el.scrollTop < lastScrollTopRef.current ? "up" : el.scrollTop > lastScrollTopRef.current ? "down" : "unknown";
      const nextPaused = nextAutoscrollPaused(
        pausedRef.current,
        {
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
          clientHeight: el.clientHeight,
        },
        intent,
      );
      setPaused(nextPaused);
      lastScrollHeightRef.current = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
      syncJumpVisibility(el, nextPaused);
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
  }, [setPaused, syncJumpVisibility]);
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
      lastScrollHeightRef.current = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    }
    setPaused(false);
    syncJumpVisibility(el ?? null, false);
  }, [setPaused, syncJumpVisibility]);

  // autosize textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [input]);

  // (the 1Hz "Working…" tick now lives in the WorkingLine/ActivityGroup leaves
  // via useLiveElapsed — no parent-level timer that re-renders the whole list.)

  // ── approval resolution ─────────────────────────────────────────────────────

  const resolveApproval = useCallback(
    (requestId: string, toolName: string, decision: ApprovalDecision) => {
      const id = sessionIdRef.current;
      // optimistically reflect the decision on the card so it feels responsive
      setTurns((prev) =>
        prev.map((t) =>
          t.kind === "approval" && t.requestId === requestId
            ? { ...t, decision }
            : t,
        ),
      );
      if (id != null) {
        // chat.ts owns the exact control_response shape (buildApprovalLine).
        chatSendRaw(id, buildApprovalLine(requestId, decision, toolName)).catch(
          (e) => {
            reportDiag("chat.approval", e, { action: "resolve", toolName });
            // the control response never reached claude → the turn is stuck
            // waiting on an approval it'll never get. surface it instead of
            // leaving firaz staring at a silently-hung run.
            setTurns((prev) => [
              ...prev,
              {
                kind: "result",
                id: uid(),
                text: `approval for ${toolName} failed to send — the run may be stuck; try stop then resend`,
              },
            ]);
          },
        );
      }
    },
    [],
  );

  // ── submit ─────────────────────────────────────────────────────────────────

  // Sends an already-composed user line to claude. `display` is what shows in
  // the transcript (the raw text the user typed); `wire` is what claude receives
  // (display + any plan / goal prefixes). Regenerate replays the same display.
  const dispatch = useCallback(
    (
      display: string,
      opts?: { skipUserBubble?: boolean; wirePrefix?: string; imagePaths?: string[] },
    ) => {
      const id = sessionIdRef.current;
      if (id == null) return;
      // No per-turn preamble. claude/codex already know `cwd` natively, attached
      // memories ride as their own content blocks, and the old shell-context lines
      // bragged about "native ops" (open panes / route artifacts / reattach runs)
      // that the chat session has NO tools to actually perform — telling the model
      // it has powers it lacks induces hallucinated tool-talk and measurably dumbs
      // it. Repeating any preamble every turn is context bloat (and re-inflates
      // resumed codex threads). Session identity belongs in CLAUDE.md / AGENTS.md,
      // read once via cwd by each engine — not stapled to every user message.
      let wire = (opts?.wirePrefix ?? "") + display;
      if (goal.trim()) wire = GOAL_PREFIX(goal.trim()) + wire;
      if (planMode) wire = PLAN_PREFIX + wire;
      if (effectiveBudget === "ultracode") wire = ULTRA_PREFIX + wire;
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
        setTurns((prev) => [
          ...prev,
          { kind: "user", id: uid(), text: display, images: opts?.imagePaths },
        ]);
      }
      setStreaming(true);
      setBackendBusy(true);
      streamingTurnId.current = null;
      thinkingTurnId.current = null;
      // start the turn timer (drives "Working… m:ss" → "Worked for Xs")
      const t0 = Date.now();
      turnStartRef.current = t0;
      setLiveStart(t0);
      // plan-mode is a per-message instruction; clear it after firing
      if (planMode) setPlanMode(false);
      if (webChatRuntime) {
        webAbortRef.current?.abort();
        const controller = new AbortController();
        webAbortRef.current = controller;
        const messages: WebChatTurn[] = turnsRef.current.flatMap((turn): WebChatTurn[] => {
          if (turn.kind === "user") return [{ role: "user" as const, text: turn.text }];
          if (turn.kind === "assistant") return [{ role: "assistant" as const, text: turn.text }];
          return [];
        });
        webChatSend(wire, {
          model: model.disabled ? null : model.id,
          messages,
          signal: controller.signal,
        })
          .then((reply) => {
            if (controller.signal.aborted) return;
            handleEvent({
              type: "assistant",
              model: reply.model,
              message: {
                role: "assistant",
                model: reply.model,
                content: [{ type: "text", text: reply.text }],
              },
            });
            handleEvent({
              type: "result",
              duration_ms: Date.now() - t0,
              usage: reply.usage,
            });
          })
          .catch((err) => {
            if (controller.signal.aborted) return;
            setTurns((prev) => [
              ...prev,
              { kind: "result", id: uid(), text: `send failed: ${err}` },
            ]);
            setStreaming(false);
            setBackendBusy(false);
          })
          .finally(() => {
            if (webAbortRef.current === controller) webAbortRef.current = null;
          });
        return;
      }
      chatSend(id, wire, opts?.imagePaths).catch((err) => {
        setTurns((prev) => [
          ...prev,
          { kind: "result", id: uid(), text: `send failed: ${err}` },
        ]);
        setStreaming(false);
        setBackendBusy(false);
      });
    },
    [
      goal,
      planMode,
      effectiveBudget,
      cwd,
      paneKey,
      attachedMemories.length,
      webChatRuntime,
      model.id,
      model.disabled,
      handleEvent,
    ],
  );
  // keep the flush effect calling the latest dispatch closure
  dispatchRef.current = dispatch;

  // FIX 3b — pin queued temp images until they're sent. Queue entries reference
  // paste temp files under /tmp/aios-paste; the OS (or anything else) can reap
  // those before the queue drains, and the backend's user_line_with_images
  // SILENTLY skips unreadable paths — the message would flush with its images
  // gone. So at queue time we slurp the bytes into memory, and just before the
  // entry fires we re-write them to the SAME content-hashed path (save_image_temp
  // is deterministic on content), making the flush immune to temp-file lifetime.
  // OS-dropped files (real user files outside aios-paste) are durable already.
  const pinnedImagesRef = useRef<Map<string, { b64: string; ext: string }>>(new Map());
  const pinQueuedImages = useCallback((paths: string[]) => {
    for (const path of paths) {
      if (!path.includes("aios-paste") || pinnedImagesRef.current.has(path)) continue;
      void (async () => {
        try {
          const res = await fetch(fileSrc(path));
          const bytes = new Uint8Array(await res.arrayBuffer());
          let bin = "";
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
          }
          const ext = path.split(".").pop() ?? "png";
          pinnedImagesRef.current.set(path, { b64: btoa(bin), ext });
        } catch (e) {
          reportDiag("chat.image", e, { action: "pinQueued", path });
        }
      })();
    }
  }, []);
  const restorePinnedImages = useCallback(async (paths: string[]) => {
    await Promise.allSettled(
      paths.map(async (path) => {
        const pin = pinnedImagesRef.current.get(path);
        if (!pin) return;
        try {
          // content-hashed filename → rewriting the same bytes recreates the
          // exact same path; harmless when the file still exists.
          await saveImageTemp(pin.b64, pin.ext);
        } catch (e) {
          reportDiag("chat.image", e, { action: "restorePinned", path });
        } finally {
          pinnedImagesRef.current.delete(path);
        }
      }),
    );
  }, []);

  // Queue a message instead of sending it (used while a turn is streaming). It
  // fires automatically when the current turn completes (see the flush effect).
  const enqueue = useCallback((raw: string, images?: string[]) => {
    if (images?.length) pinQueuedImages(images);
    setQueued((items) => {
      const next = queueMessage(items, raw, images);
      setQueuedIdx(next.selected);
      return next.items;
    });
    setInput("");
    setOverlay(null);
  }, [pinQueuedImages]);

  const removeQueued = useCallback((id: string) => {
    const gone = queuedRef.current.find((q) => q.id === id);
    gone?.images?.forEach((path) => pinnedImagesRef.current.delete(path));
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

  // Explicitly inject one highlighted pending message into the live turn.
  // claude steers over stdin (images ride as real content blocks); codex steers
  // via turn/steer (text-only — image entries wait for the normal flush).
  // If the backend cannot steer yet, leave it queued so normal auto-send wins.
  const steerQueued = useCallback(
    (queuedId: string) => {
      const item = queuedRef.current.find((q) => q.id === queuedId);
      const engine = model.engine ?? "claude";
      if (!item || (engine !== "codex" && engine !== "claude")) return;
      if (engine === "codex" && item.images?.length) return;
      const id = sessionIdRef.current;
      if (id == null) return;
      void (async () => {
        try {
          if (item.images?.length) await restorePinnedImages(item.images);
          await steerTurn(id, item.text, item.images);
          removeQueued(queuedId);
          const bubble =
            item.text ||
            (item.images?.length
              ? `[${item.images.length} image${item.images.length > 1 ? "s" : ""}]`
              : "");
          setTurns((prev) => [
            ...prev,
            { kind: "user", id: uid(), text: bubble, steered: true, images: item.images },
          ]);
        } catch (e) {
          // no active turn yet → keep queued for automatic send
          reportDiag("chat.steer", e, { action: "queued" });
        }
      })();
    },
    [model.engine, removeQueued, restorePinnedImages],
  );

  // Send an explicit string (used by send() with the composer text, and by the
  // external "send to AI" submitter which passes the note body directly so it
  // doesn't race the input state).
  const sendText = useCallback(
    async (raw: string, queuedImages?: string[]) => {
      const text = raw.trim();
      // Always drain in-flight disk saves before collecting paths. The old guard
      // (`some(path==null) && pendingSavesRef.size`) had a race: a save could
      // resolve (clearing pendingSavesRef) a beat before its path landed in
      // imagesRef, so the guard short-circuited and the null-path chip got
      // filtered out below — shipping a text-only turn with the image silently
      // dropped (the "image never reaches the model" bug). Awaiting
      // unconditionally + reading the synchronously-mirrored imagesRef AFTER the
      // await closes that window entirely.
      if (pendingSavesRef.current.size) {
        await Promise.allSettled([...pendingSavesRef.current.values()]);
      }
      // attached images are sent as REAL image content blocks (the backend reads
      // these temp paths → base64/localImage), so they land on every turn, not
      // just the first. allow a send with images even when the text is empty.
      //
      // FIX 3a — a queue flush passes the entry's OWN images (queuedImages), and
      // anything attached to the composer SINCE the entry was queued is MERGED in
      // (dedup by path) instead of silently thrown away: the old `queuedImages ??
      // composer` meant "queue a message, then attach the screenshot it needs"
      // dropped the screenshot when the entry flushed. Composer chips that ride
      // along are consumed (cleared) like any sent attachment.
      const composerPaths = imagesRef.current
        .filter((im) => im.path)
        .map((im) => im.path as string);
      const imgPaths = queuedImages
        ? [...new Set([...queuedImages, ...composerPaths])]
        : composerPaths;
      const consumeComposerImages = () => {
        if (composerPaths.length === 0) return;
        setImagesSync((prev) => {
          prev.forEach((im) => URL.revokeObjectURL(im.url));
          return [];
        });
      };
      reportDiag("chat.image", "sendText:collect", {
        total: imagesRef.current.length,
        withPath: imgPaths.length,
        queued: Boolean(queuedImages),
      });
      if (!text && imgPaths.length === 0) return;
      // FIX 3b — a flushing queue entry's temp files may have been reaped since
      // it was queued; rewrite any pinned bytes back to their paths first so
      // the backend never silently skips them.
      if (queuedImages?.length) {
        await restorePinnedImages(queuedImages);
      }
      // Submitting while a turn is in flight: STEER it into the running turn
      // when the engine supports it (claude = stdin inject incl. images, codex
      // = turn/steer text-only), render it as a normal sent bubble; otherwise
      // queue it ChatGPT-style to fire when the turn finishes.
      if (activeRunRef.current) {
        const engine = model.engine ?? "claude";
        const sid = sessionIdRef.current;
        const steerable =
          sid != null &&
          !webChatRuntime &&
          (engine === "claude" || (engine === "codex" && imgPaths.length === 0));
        if (steerable) {
          try {
            await steerTurn(sid, text, imgPaths.length ? imgPaths : undefined);
            const bubble =
              text || `[${imgPaths.length} image${imgPaths.length > 1 ? "s" : ""}]`;
            setTurns((prev) => [
              ...prev,
              {
                kind: "user",
                id: uid(),
                text: bubble,
                steered: true,
                images: imgPaths.length ? imgPaths : undefined,
              },
            ]);
            consumeComposerImages();
            setInput("");
            setOverlay(null);
            return;
          } catch (e) {
            // no live turn after all (it just ended / hasn't started) or the
            // write failed → fall back to the queue; the flush effect wins.
            reportDiag("chat.steer", e, { action: "sendText" });
          }
        }
        enqueue(text, imgPaths.length ? imgPaths : undefined);
        consumeComposerImages();
        return;
      }
      if (sessionIdRef.current == null) {
        enqueue(text, imgPaths.length ? imgPaths : undefined);
        consumeComposerImages();
        setInput("");
        setOverlay(null);
        setTurns((prev) => [
          ...prev,
          {
            kind: "result",
            id: uid(),
            text: "chat is still starting — queued message will send automatically.",
          },
        ]);
        return;
      }
      // Claude keeps its original first-message labels. Codex starts with a
      // provisional label for low-signal openers, then promotes the first real
      // request into a compact stable topic.
      const engine = model.engine ?? "claude";
      const suggested = resumeTitle(text, engine);
      const stableTitle = agentLabel ?? suggested.title;
      const firstRecord = !recordedRef.current;
      const promoteCodex =
        engine === "codex" && !codexTitleLockedRef.current && suggested.meaningful;
      const sid = claudeSessionIdRef.current;
      if (sid && (firstRecord || promoteCodex)) {
        if (firstRecord) recordedRef.current = true;
        if (promoteCodex) codexTitleLockedRef.current = true;
        recordChatSession(sid, stableTitle, cwd ?? null, engine, model.id).catch(() => {
          // failed to persist → allow a later send to retry
          if (firstRecord) recordedRef.current = false;
          if (promoteCodex) codexTitleLockedRef.current = false;
        });
        // Label the backend session for the background tray + done-notification.
        if (sessionIdRef.current != null)
          chatSetTitle(sessionIdRef.current, stableTitle).catch((e) => reportDiag("chat.title", e, { action: "setTitle" }));
        // Re-report with the now-meaningful first-message title so pane history
        // shows a real label (not "resumed chat · <dir>") when reopened.
        onChatSession?.({ id: sid, title: stableTitle, engine, model: model.id });
      }
      setInput("");
      consumeComposerImages();
      setOverlay(null);
      const attachedMemoryBlock = memoryContextBlock(attachedMemories);
      let autoMemories: MemoryHit[] = [];
      const autoLimit = effectiveBudget === "lean" ? 1 : effectiveBudget === "ultracode" ? 6 : 3;
      if (text) {
        setMemoryContextStatus("searching");
        try {
          const attachedPaths = new Set(attachedMemories.map((memory) => memory.path));
          autoMemories = (await memorySearch(text, cwd ?? null, autoLimit + attachedPaths.size))
            .filter((memory) => !attachedPaths.has(memory.path))
            .slice(0, autoLimit);
          setLastAutoMemories(autoMemories);
          setMemoryContextStatus("ready");
        } catch (e) {
          setLastAutoMemories([]);
          setMemoryContextStatus("error");
          reportDiag("memory.search", e, { action: "autoContext" });
        }
      } else {
        setLastAutoMemories([]);
        setMemoryContextStatus("ready");
      }
      const contextCapsule = buildChatContextCapsule({
        cwd,
        engine,
        modelLabel: model.label,
        contextBudget: effectiveBudget,
        userText: text,
        memories: autoMemories,
        attachedMemoryCount: attachedMemories.length,
        recentTurns: recentTurnsForContext(turnsRef.current),
        workspace: workspaceContext ?? null,
        runPhase: runEventState.phase,
        missionBoard: {
          mission: getMission(),
          agents: listAgents().map((a) => ({ label: a.label, status: a.status ?? "idle" })),
          openTasks: wrmsSeedTasks().map((t) => t.id),
        },
      });
      setAttachedMemoryPaths([]);
      // images ride as native content blocks (opts.imagePaths), not text paths —
      // the user bubble shows the text and a "[n image(s)]" hint when text-empty.
      const bubble = text || (imgPaths.length ? `[${imgPaths.length} image${imgPaths.length > 1 ? "s" : ""}]` : "");
      dispatch(bubble, { wirePrefix: `${contextCapsule}${attachedMemoryBlock}`, imagePaths: imgPaths });
    },
    // `images` intentionally NOT a dep: sendText reads the synchronously-mirrored
    // imagesRef.current (fresh after the pending-save await), so depending on the
    // images STATE would only re-create this closure on every attach for nothing.
    // `streaming` is read through activeRunRef (always-fresh), not as a dep.
    [dispatch, cwd, model, attachedMemories, effectiveBudget, workspaceContext, runEventState.phase, setImagesSync, enqueue, restorePinnedImages, webChatRuntime],
  );

  // The single submit entry — sendText routes per state: idle → normal send;
  // turn in flight → steer (claude/codex) or queue; session not up → queue.
  const send = useCallback(() => sendText(input), [sendText, input]);

  // Keep a fresh ref to sendText so the external submitter (registered once per
  // paneKey) always calls the latest closure without re-registering.
  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;
  // The queue-flush effect (declared earlier) fires queued messages through the
  // full send path so they get the same context capsule / memory / recording a
  // freshly-typed message gets.
  flushSendRef.current = (text: string, images?: string[]) => {
    void sendText(text, images).catch((e) => reportDiag("chat.send", e, { action: "queueFlush" }));
  };

  // ── launcher seed: auto-send as the first turn ─────────────────────────────
  // The idle page hands over the prompt you typed as `seed`; fire it once the
  // session is live (started) and claude's init has landed (claudeReady, so the
  // chat records into /resume) — so the text you typed on the idle page IS the
  // first message. No "type once to launch, type again to send".
  //
  // Hardening (fix 6.1): a resume / model-switch / restart nulls sessionIdRef
  // mid-flight, and dispatch() early-returns when the id is null — so naively
  // firing on (started && claudeReady) could send into a stale/null session and
  // silently lose the seed. Gate strictly on a LIVE session id, send the seed
  // text explicitly (not racy `input` state), and only mark it sent once the
  // dispatch had a live session. If the session never comes live, surface a
  // visible note instead of swallowing the prompt.
  // Retry until the session is live, then send the seed as the first turn.
  // Earlier this was a one-shot gate on (started && claudeReady) plus a 12s
  // give-up that prefilled the composer — under load (slow init, session
  // re-spawn after an app restart) the gate lost the race and the seed sat in
  // the composer unsent. A poll removes every timing assumption: the instant a
  // live backend session id exists and we're not mid-stream, fire it. Only
  // surface a note after a long window (sessions normally come live in seconds).
  useEffect(() => {
    if (!seed || seedSentRef.current) return;
    let cancelled = false;
    let tries = 0;
    const tick = () => {
      if (cancelled || seedSentRef.current) return;
      if (sessionIdRef.current != null && !streamingRef.current) {
        seedSentRef.current = true;
        void sendTextRef.current(seed).catch((e) => reportDiag("chat.send", e, { action: "seed" }));
        return;
      }
      if (++tries > 120) {
        // ~60s and still no live session — keep the prompt, surface a note.
        seedSentRef.current = true;
        setTurns((prev) => [
          ...prev,
          {
            kind: "result",
            id: uid(),
            text: "couldn't auto-send your opening message — the session didn't come live. press send.",
          },
        ]);
        setInput((cur) => (cur ? cur : seed));
        return;
      }
      window.setTimeout(tick, 500);
    };
    const t = window.setTimeout(tick, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  // Stable handler for an assistant message's `[[btn:…]]` choice. Routes through
  // dispatchRef + streamingRef (kept fresh below) so its identity NEVER changes
  // across renders — otherwise every streamed token recreates this closure and
  // breaks React.memo on every AssistantBubble in the list (the re-render storm).
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const handleAssistantButton = useCallback((label: string) => {
    if (!streamingRef.current && sessionIdRef.current != null) {
      dispatchRef.current(label);
    }
  }, []);

  // AskUserQuestion answers: once firaz picks, we record the choice (so the card
  // collapses to a verdict and can't be re-answered) and send it back as the
  // next user turn — which is exactly what claude is waiting for after it
  // auto-dismisses the tool in headless mode. Keyed by the tool turn id.
  const [answeredQuestions, setAnsweredQuestions] = useState<Record<string, string>>({});
  const answeredQuestionsRef = useRef<Set<string>>(new Set());
  const handleQuestionAnswer = useCallback((turnId: string, text: string) => {
    if (sessionIdRef.current == null) return;
    if (answeredQuestionsRef.current.has(turnId)) return; // guard double-tap
    answeredQuestionsRef.current.add(turnId);
    setAnsweredQuestions((prev) => ({ ...prev, [turnId]: text }));
    if (text.trim()) dispatchRef.current(text);
  }, []);

  // regenerate: replay the last user turn (no extra user bubble)
  const regenerate = useCallback(() => {
    const last = lastSentRef.current;
    if (!last || streaming || sessionIdRef.current == null) return;
    dispatch(last, { skipUserBubble: true });
  }, [streaming, dispatch]);

  const finalizeStreaming = useCallback(
    (note: string, mode: "interrupt" | "kill-and-restart" = "interrupt") => {
      const id = sessionIdRef.current;
      // apply any buffered deltas before finalizing, else a pending rAF flush
      // could re-open the bubble we just closed.
      flushPending();
      setTurns((prev) =>
        finalizeStreamingTurns(
          {
            turns: prev,
            streamingTurnId: streamingTurnId.current,
            thinkingTurnId: thinkingTurnId.current,
          },
          Date.now(),
        ).turns,
      );
      streamingTurnId.current = null;
      thinkingTurnId.current = null;
      turnStartRef.current = null;
      setLiveStart(null);
      setStreaming(false);
      setBackendBusy(false);
      setTurns((prev) => [...prev, { kind: "result", id: uid(), text: note }]);
      if (webChatRuntime) {
        webAbortRef.current?.abort();
        webAbortRef.current = null;
        return;
      }
      if (id != null) {
        if (mode === "kill-and-restart") {
          sessionIdRef.current = null;
          chatStop(id)
            .catch((e) => reportDiag("chat.stop", e, { action: "killRestart" }))
            .finally(() => {
              setRunEventState(emptyRunEventState());
              setRunEventsKey(null);
              setRestartKey((k) => k + 1);
            });
        } else {
          chatInterrupt(id).catch((e) => reportDiag("chat.interrupt", e, { action: "interrupt" }));
        }
      }
    },
    [webChatRuntime, flushPending],
  );

  // true interrupt of the in-flight turn (process survives)
  const stop = useCallback(() => {
    if (sessionIdRef.current == null) return;
    const strategy = stopStrategy(model.engine);
    finalizeStreaming(
      strategy === "kill-and-restart"
        ? "stopped by user — backend restarted"
        : "stopped by user",
      strategy,
    );
  }, [finalizeStreaming, model.engine]);
  stopChatRef.current = stop;

  // hard reset: clear transcript + re-spin a FRESH claude session (drops any
  // resume id, so a new chat / /clear never keeps continuing a past session).
  const clearSession = useCallback(() => {
    if (runEventsKey) {
      try {
        localStorage.removeItem(runEventsKey);
      } catch {
        /* ignore */
      }
    }
    setTurns([]);
    setRunEventState(emptyRunEventState());
    setRunEventsKey(null);
    setStreaming(false);
    webAbortRef.current?.abort();
    webAbortRef.current = null;
    streamingTurnId.current = null;
    thinkingTurnId.current = null;
    lastSentRef.current = null;
    turnStartRef.current = null;
    setLiveStart(null);
    setInput("");
    setOverlay(null);
    setQueued([]);
    setQueuedIdx(0);
    usageBaselineRef.current = {};
    setResumeId(null);
    setResumedTitle(null);
    // fresh chat → forget the prior session id + recording flag so the next
    // first-send records a brand-new /resume entry (not the old one).
    claudeSessionIdRef.current = null;
    setOpenSessionId(null);
    recordedRef.current = false;
    codexTitleLockedRef.current = false;
    setRestartKey((k) => k + 1);
  }, [runEventsKey]);

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

  useEffect(() => {
    if (!resume?.id) return;
    let cancelled = false;
    claudeSessionIdRef.current = resume.id;
    setOpenSessionId(resume.id);
    setRunEventsKey(runEventsStorageKey(resume.id));
    recordedRef.current = true;
    codexTitleLockedRef.current = true;
    setResumeId(resume.id);
    setResumedTitle(resume.title);
    const resumeModel =
      CHAT_MODELS.find((m) => resume.model && m.id === resume.model) ??
      CHAT_MODELS.find((m) => (m.engine ?? "claude") === (resume.engine || "claude"));
    if (resumeModel && resumeModel.id !== activeModelRef.current.id) setModel(resumeModel);
    setRunEventState(emptyRunEventState());
    readChatTranscript(resume.id)
      .then((rows) => {
        if (!cancelled && rows.length) setTurns(transcriptToTurns(rows));
      })
      .catch(() => {
        /* transcript unavailable; the pane is still resumable */
      });
    return () => {
      cancelled = true;
    };
  }, [resume?.id, resume?.title, resume?.engine, resume?.model, transcriptToTurns]);

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
      setOpenSessionId(session.id);
      setRunEventsKey(runEventsStorageKey(session.id));
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
        id: "memory",
        label: "/memory",
        desc: "search and attach memory context",
        icon: <Brain size={14} />,
        run: () => {
          setInput("");
          setOverlay(null);
          setMemoryPanelOpen(true);
          setTimeout(() => taRef.current?.focus(), 0);
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
        desc: "package this session for a target model",
        icon: <PackageOpen size={14} />,
        run: () => {
          setInput("");
          setOverlay(null);
          setHandoffPanelOpen(true);
          setTimeout(() => taRef.current?.focus(), 0);
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

  // load dir entries for the @-mention picker. Plain @foo searches cwd; path
  // prefixes like @src/ or @/Applications/ browse that directory.
  const loadMentions = useCallback(async (query = "") => {
    const root = cwd;
    if (!root) {
      setMentionItems([]);
      return;
    }
    const slash = query.lastIndexOf("/");
    const leaf = slash >= 0 ? query.slice(slash + 1) : query;
    const prefix = slash >= 0 ? query.slice(0, slash + 1) : "";
    const candidates =
      slash < 0
        ? [root]
        : prefix.startsWith("/")
          ? [prefix || "/"]
          : [`${root.replace(/\/$/, "")}/${prefix}`, `/${prefix}`];
    try {
      let entries: DirEntry[] = [];
      let resolvedPrefix = prefix;
      for (const dir of candidates) {
        try {
          entries = await readDir(dir);
          resolvedPrefix = slash >= 0 ? (dir.endsWith("/") ? dir : `${dir}/`) : "";
          break;
        } catch {
          /* try next candidate */
        }
      }
      // dirs first, then files; cap to keep the popover tight
      entries.sort((a, b) =>
        a.is_dir === b.is_dir
          ? a.name.localeCompare(b.name)
          : a.is_dir
            ? -1
            : 1,
      );
      setMentionPrefix(resolvedPrefix);
      setMentionQuery(leaf);
      setMentionItems(entries.slice(0, 200));
    } catch {
      setMentionPrefix(prefix);
      setMentionQuery(leaf);
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
        const query = m[1] ?? "";
        setMentionQuery(query.includes("/") ? query.slice(query.lastIndexOf("/") + 1) : query);
        if (overlay !== "mention") {
          setOverlay("mention");
          setOverlayIdx(0);
        }
        void loadMentions(query);
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
      const base = mentionPrefix || "";
      const insert = entry.is_dir ? `${base}${entry.name}/` : `${base}${entry.name}`;
      setInput((v) => v.replace(/(^|\s)@([^\s]*)$/, `$1@${insert} `));
      setOverlay(null);
      taRef.current?.focus();
    },
    [mentionPrefix],
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
  const activeRun = streaming || backendBusy;

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
    // follow-up, then Enter injects the highlighted row into the live turn
    // (claude stdin inject / codex turn/steer — steerQueued routes per engine).
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
    if (e.key === "ArrowDown" && !overlay) {
      const now = e.timeStamp || performance.now();
      if (now - lastArrowDownRef.current < 360) {
        e.preventDefault();
        lastArrowDownRef.current = 0;
        jumpToLatest();
        return;
      }
      lastArrowDownRef.current = now;
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
      // one entry point: sendText routes a mid-turn Enter per engine — claude
      // injects into the running turn over stdin, codex fires turn/steer
      // (text-only), opencode/image-on-codex queues for the next turn.
      send();
    }
  };

  // Pane-level double-tap ↓ → jump to bottom + re-latch autoscroll. The composer
  // textarea handles its own double-tap (see onKeyDown) so it can also recall the
  // last message on a single ↑; here we cover the REST of the pane (transcript,
  // tool cards, focus on the pane root) so ↓↓ works anywhere. Skip when focus is
  // in any editable field so it never fights cursor movement / a search input.
  const onPaneKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "ArrowDown") return;
      const t = e.target as HTMLElement | null;
      if (t === taRef.current) return; // composer owns its own ↓↓
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      const stamp = e.timeStamp || performance.now();
      if (stamp - lastArrowDownRef.current < 360) {
        e.preventDefault();
        lastArrowDownRef.current = 0;
        jumpToLatest();
        return;
      }
      lastArrowDownRef.current = stamp;
    },
    [jumpToLatest],
  );

  const hasDraft = input.trim().length > 0;
  const hasReadyImages = images.some((im) => im.path);
  const action = sendContract({
    streaming: activeRun,
    hasDraft,
    hasImages: hasReadyImages,
    engine: model.engine ?? "claude",
    started,
  });
  const contextChips = composerContextChips({
    cwd,
    modelLabel: model.label,
    effortLabel: effortChipLabel(effort.id, effort.label, model.engine ?? "claude"),
    permissionLabel: permission.label,
    engine: model.engine ?? "claude",
    contextBudget: effectiveBudget,
    queuedCount: queued.length,
    imageCount: images.length,
    planMode,
    hasGoal: Boolean(goal.trim()),
  });
  const contextBuckets = contextLedger({
    draft: input,
    goal,
    planMode,
    memoryCount: attachedMemories.length,
    imageCount: images.length,
    queuedCount: queued.length,
    contextBudget: effectiveBudget,
  });
  const estimatedContextTokens = contextBuckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  const contextLedgerWarning = contextBuckets.some((bucket) => bucket.level === "warning");
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
                ) : chip.id === "attachments" ? (
                  <ImageIcon size={12} className="shrink-0 text-[var(--color-accent)]" />
                ) : chip.id === "queue" ? (
                  <Waypoints size={12} className="shrink-0 text-[var(--color-accent)]" />
                ) : chip.id === "plan" ? (
                  <ListChecks size={12} className="shrink-0 text-[var(--color-accent)]" />
                ) : chip.id === "goal" ? (
                  <Target size={12} className="shrink-0 text-[var(--color-accent)]" />
                ) : chip.id === "budget" ? (
                  <Gauge size={12} className="shrink-0 text-[var(--color-muted)]" />
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
            <button
              type="button"
              onClick={openMemoryPanel}
              className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[11.5px] transition-colors ${
                memoryContextStatus === "error"
                  ? "border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)]"
                  : lastAutoMemories.length > 0
                    ? "border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] text-[var(--color-text)]"
                    : "border-[var(--color-border-strong)] bg-[var(--color-panel)]/70 text-[var(--color-text-2)] hover:border-[var(--color-accent)]/45 hover:text-[var(--color-accent)]"
              }`}
              title={
                memoryContextStatus === "searching"
                  ? "searching memory for this send"
                  : lastAutoMemories.length > 0
                    ? `auto memory used: ${lastAutoMemories.map((m) => m.title).join("; ")}`
                    : "auto memory is on. click to inspect inline"
              }
            >
              <Brain size={12} className="shrink-0 text-[var(--color-accent)]" />
              <span className="truncate">
                {memoryContextStatus === "searching"
                  ? "memory searching"
                  : memoryContextStatus === "error"
                    ? "memory error"
                    : lastAutoMemories.length > 0
                      ? `${lastAutoMemories.length} auto memories`
                      : "memory on"}
              </span>
            </button>
            {attachedMemories.length > 0 && (
              <button
                type="button"
                onClick={openMemoryPanel}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text)]"
                title="show inline memory"
              >
                <Brain size={12} className="shrink-0 text-[var(--color-accent)]" />
                <span className="truncate">{attachedMemories.length} memories attached</span>
              </button>
            )}
          </div>
        )}

        <div
          className={`mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 font-mono text-[10px] ${
            contextLedgerWarning ? "text-[var(--color-warning)]" : "text-[var(--color-faint)]"
          }`}
          title="estimated tokens added by the next send; exact billing comes from provider usage"
        >
          <span>~{estimatedContextTokens.toLocaleString()} tok next send</span>
          {/* per-bucket breakdown only when there's an actual breakdown — a
              single bucket just repeats the total ("agent:650" noise). */}
          {contextBuckets.length > 1 &&
            contextBuckets.map((bucket) => (
              <span
                key={bucket.id}
                className={bucket.level === "warning" ? "text-[var(--color-warning)]" : undefined}
              >
                · {bucket.label} {bucket.tokens.toLocaleString()}
              </span>
            ))}
        </div>

        {memoryPanelOpen && (
          <div className="mb-2 flex max-h-36 flex-col gap-1 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]/80 p-1.5">
            <div className="flex items-center justify-between px-1 pb-1">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-2)]">
                <Brain size={12} className="text-[var(--color-accent)]" />
                memory
              </span>
              <button
                type="button"
                onClick={() => setMemoryPanelOpen(false)}
                className="rounded p-0.5 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                title="close memory search"
              >
                <X size={12} />
              </button>
            </div>
            {input.trim().length < 2 ? (
              <div className="px-2 py-2 text-[11.5px] text-[var(--color-muted)]">type to search memory</div>
            ) : memoryHits.length === 0 ? (
              <div className="px-2 py-2 text-[11.5px] text-[var(--color-muted)]">no memory matches</div>
            ) : (
              memoryHits.slice(0, 5).map((hit) => {
                const attached = attachedMemoryPaths.includes(hit.path);
                return (
                  <button
                    key={hit.path}
                    type="button"
                    onClick={() =>
                      setAttachedMemoryPaths((paths) =>
                        attached ? paths.filter((path) => path !== hit.path) : [...paths, hit.path],
                      )
                    }
                    className={`flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left font-sans text-[11.5px] transition-colors ${
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
              })
            )}
          </div>
        )}

        {handoffPanelOpen && (
          <div className="mb-2 flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]/85 p-1.5">
            <div className="flex items-center justify-between px-1 pb-1">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-2)]">
                <PackageOpen size={12} className="text-[var(--color-accent)]" />
                handoff target
              </span>
              <button
                type="button"
                onClick={() => setHandoffPanelOpen(false)}
                className="rounded p-0.5 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                title="close handoff targets"
              >
                <X size={12} />
              </button>
            </div>
            {CHAT_MODELS.map((target) => (
              <button
                key={target.id}
                type="button"
                disabled={target.disabled}
                onClick={() => {
                  if (target.disabled) return;
                  setHandoffPanelOpen(false);
                  const engine = target.engine ?? "claude";
                  sendText(
                    `create a clean handoff for continuing this exact session in ${target.label} (${engine} / ${target.id}). include: current objective, important user preferences, shipped changes, files touched, verification already run, known caveats, and the next best actions. make it compact but complete enough that the target model can resume without rereading the whole chat.`,
                  );
                }}
                className="flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-[11.5px] text-[var(--color-text-2)] transition-colors hover:bg-[var(--color-panel-2)] disabled:cursor-not-allowed disabled:opacity-45"
                title={target.note}
              >
                <Sparkles size={12} className="shrink-0 text-[var(--color-accent)]" />
                <span className="min-w-0 flex-1 truncate">{target.label}</span>
                <span className="shrink-0 rounded border border-[var(--color-border)] px-1 py-0.5 font-mono text-[9px] text-[var(--color-faint)]">
                  {target.engine ?? "claude"}
                </span>
              </button>
            ))}
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
              <div className="flex flex-col gap-2 px-3 py-2 font-sans text-[11.5px] text-[var(--color-muted)]">
                <div className="flex items-center gap-2">
                  <Search size={13} className="text-[var(--color-faint)]" />
                  <span className="min-w-0 flex-1 truncate">
                    no matches in {mentionPrefix ? mentionPrefix : baseName(cwd)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setInput((v) => v.replace(/(^|\s)@([^\s]*)$/, "$1@/Applications/"));
                      setMentionQuery("");
                      void loadMentions("/Applications/");
                      taRef.current?.focus();
                    }}
                    className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-2)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
                  >
                    browse /applications
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInput((v) => v.replace(/(^|\s)@([^\s]*)$/, "$1@/"));
                      setMentionQuery("");
                      void loadMentions("/");
                      taRef.current?.focus();
                    }}
                    className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-2)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
                  >
                    browse root
                  </button>
                </div>
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
            currentSessionId={openSessionId}
            searchRef={resumeSearchRef}
            onQueryChange={setResumeQuery}
            onKeyDown={onResumeKeyDown}
            onHover={setOverlayIdx}
            onPick={resumeSession}
            onClose={closeResume}
          />
        )}

        {/* pending steer queue belongs with the composer in every layout. first
            Enter queues, arrows highlight, explicit steer injects when possible. */}
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
                  <span className="min-w-0 flex-1 truncate">
                    {q.text || "(image only)"}
                  </span>
                )}
                {q.images && q.images.length > 0 && (
                  <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-[var(--color-accent)]">
                    <ImageIcon size={11} /> {q.images.length}
                  </span>
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
                {streaming &&
                  ((model.engine ?? "claude") === "claude" ||
                    (model.engine === "codex" && !q.images?.length)) && (
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
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              attachPickedFiles(e.target.files);
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
          <div className="flex flex-wrap items-center justify-end gap-1.5 px-3 pb-3 pt-1">
            {/* advanced controls stay available, but the composer stays clean.
                min-w-0 + wrap (NOT shrink-0): on a narrow pane the pills wrap to
                a second row instead of bleeding out the left edge of the card. */}
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            {!empty && (
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  setComposerCollapsed(true);
                }}
                className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                title="hide composer"
              >
                <ChevronDown size={15} />
              </button>
            )}
            <Dropdown
              open={openMenu === "advanced"}
              onToggle={() => setOpenMenu(openMenu === "advanced" ? null : "advanced")}
              align="right"
              triggerClassName="grid h-8 w-8 place-items-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
              trigger={<Wrench size={15} />}
            >
              <div className="px-3 pb-1 pt-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
                tools
              </div>
              <MenuItem
                onClick={() => {
                  setResumeQuery("");
                  setOverlay("resume");
                  setOverlayIdx(0);
                  void loadResumeSessions();
                  setOpenMenu(null);
                  setTimeout(() => resumeSearchRef.current?.focus(), 0);
                }}
              >
                <span className="flex items-center gap-2">
                  <History size={13} /> resume session
                </span>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  imgInputRef.current?.click();
                  setOpenMenu(null);
                }}
              >
                <span className="flex items-center gap-2">
                  <ImageIcon size={13} /> attach image
                </span>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  fileInputRef.current?.click();
                  setOpenMenu(null);
                }}
              >
                <span className="flex items-center gap-2">
                  <FileText size={13} /> attach file/doc
                </span>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  void micStart();
                  setOpenMenu(null);
                }}
              >
                <span className="flex items-center gap-2">
                  <Mic size={13} /> dictate
                </span>
              </MenuItem>
              <div className="mt-1 border-t border-[var(--color-border)] px-3 pb-1 pt-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
                context
              </div>
              {CONTEXT_BUDGETS.map((b) => (
                <MenuItem
                  key={b.id}
                  active={b.id === effectiveBudget}
                  title={b.sub}
                  onClick={() => {
                    setContextBudget(b.id);
                    if (b.id === "ultracode") {
                      const ultra = EFFORTS.find((ef) => ef.ultra);
                      if (ultra) setEffort(ultra);
                    } else if (effort.ultra) {
                      setEffort(EFFORTS[1]);
                    }
                    setOpenMenu(null);
                  }}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2">
                      {b.id === "ultracode" && <Sparkles size={13} className="text-[#a855f7]" />}
                      {b.label}
                    </span>
                    <span className="truncate text-[10.5px] text-[var(--color-faint)]">{b.sub}</span>
                  </span>
                </MenuItem>
              ))}
            </Dropdown>
            {/* permission mode — promoted out of the wrench menu: what the
                agent is ALLOWED to do is a safety setting, not an advanced
                tool. Subtle when restricted, accent-tinted on full access. */}
            <Dropdown
              open={openMenu === "perm"}
              onToggle={() => setOpenMenu(openMenu === "perm" ? null : "perm")}
              align="right"
              triggerClassName={
                permission.id === "bypassPermissions"
                  ? "flex items-center gap-1.5 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-panel)]/70 px-3 py-1 font-sans text-[12px] font-medium text-[var(--color-text-2)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                  : "flex items-center gap-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-panel)]/70 px-3 py-1 font-sans text-[12px] font-medium text-[var(--color-text-2)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
              }
              trigger={
                <>
                  <ShieldQuestion
                    size={13}
                    className={`shrink-0 ${
                      permission.id === "bypassPermissions"
                        ? "text-[var(--color-accent)]"
                        : "text-[var(--color-muted)]"
                    }`}
                  />
                  <span className="whitespace-nowrap">{permission.label}</span>
                  <ChevronDown size={12} className="text-[var(--color-faint)]" />
                </>
              }
            >
              <div className="px-3 pb-1 pt-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
                access
              </div>
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
            {/* mic — one-click voice dictation (the wrench menu still has it,
                but voice deserves a visible button). Recording swaps the
                textarea for the waveform; this hides until idle again. */}
            {voicePhase === "idle" && (
              <button
                type="button"
                onClick={() => void micStart()}
                className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
                title="dictate (esc to cancel)"
              >
                <Mic size={15} />
              </button>
            )}
            {/* effort selector — promoted out of the wrench menu so the
                reasoning tier is always one click away. The pill is
                tier-colored: faint → accent as effort climbs, animated purple
                gradient at ultracode. */}
            <Dropdown
              open={openMenu === "effort"}
              onToggle={() => setOpenMenu(openMenu === "effort" ? null : "effort")}
              align="right"
              triggerClassName={
                effort.ultra
                  ? "flex items-center gap-1.5 rounded-full border border-transparent bg-[linear-gradient(110deg,#7c3aed,#a855f7,#ec4899,#a855f7,#7c3aed)] bg-[length:220%_100%] px-3 py-1 font-sans text-[12px] font-semibold text-white shadow-[0_0_16px_-3px_#a855f7] [animation:aios-ultra-sweep_4s_ease_infinite] transition-shadow hover:shadow-[0_0_20px_-2px_#a855f7]"
                  : effort.id === "xhigh" || effort.id === "max"
                    ? "flex items-center gap-1.5 rounded-full border border-[var(--color-accent)]/60 bg-[var(--color-accent-soft)] px-3 py-1 font-sans text-[12px] font-semibold text-[var(--color-text)] shadow-[0_0_12px_-4px_var(--color-accent)] transition-colors hover:border-[var(--color-accent)]"
                    : "flex items-center gap-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-panel)]/70 px-3 py-1 font-sans text-[12px] font-medium text-[var(--color-text-2)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
              }
              trigger={
                <>
                  {effort.ultra ? (
                    <Sparkles size={13} className="shrink-0" />
                  ) : (
                    <Zap
                      size={13}
                      className={`shrink-0 ${
                        effort.id === "xhigh" || effort.id === "max"
                          ? "text-[var(--color-accent)]"
                          : "text-[var(--color-muted)]"
                      }`}
                    />
                  )}
                  <span className="whitespace-nowrap">
                    {effortChipLabel(effort.id, effort.label, model.engine ?? "claude")}
                  </span>
                  <ChevronDown size={12} className={effort.ultra ? "text-white/70" : "text-[var(--color-faint)]"} />
                </>
              }
            >
              <div className="px-3 pb-1 pt-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
                effort
              </div>
              {EFFORTS.map((ef) => (
                <MenuItem
                  key={ef.id}
                  active={ef.id === effort.id}
                  title={ef.sub}
                  onClick={() => {
                    setEffort(ef);
                    setOpenMenu(null);
                  }}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2">
                      {ef.ultra && <Sparkles size={13} className="text-[#a855f7]" />}
                      {ef.label}
                    </span>
                    {ef.sub && (
                      <span className="truncate text-[10.5px] text-[var(--color-faint)]">{ef.sub}</span>
                    )}
                  </span>
                </MenuItem>
              ))}
            </Dropdown>
            {/* model selector (right) — the headline pill: accent glow, hot
                models get the sparkle. */}
            <Dropdown
              open={openMenu === "model"}
              onToggle={() => setOpenMenu(openMenu === "model" ? null : "model")}
              align="right"
              triggerClassName={
                model.hot
                  ? "flex items-center gap-1.5 rounded-full border border-[var(--color-accent)]/60 bg-[var(--color-accent-soft)] px-3 py-1 font-sans text-[12px] font-semibold text-[var(--color-text)] shadow-[0_0_16px_-3px_var(--color-accent)] transition-all hover:border-[var(--color-accent)] hover:shadow-[0_0_20px_-2px_var(--color-accent)]"
                  : "flex items-center gap-1.5 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-3 py-1 font-sans text-[12px] font-semibold text-[var(--color-text)] shadow-[0_0_12px_-5px_var(--color-accent)] transition-colors hover:border-[var(--color-accent)]"
              }
              trigger={
                <>
                  {model.hot ? (
                    <Sparkles size={13} className="shrink-0 text-[var(--color-accent)]" />
                  ) : (
                    <Brain size={13} className="shrink-0 text-[var(--color-accent)]" />
                  )}
                  <span className="whitespace-nowrap">{model.label}</span>
                  <ChevronDown size={12} className="text-[var(--color-faint)]" />
                </>
              }
            >
              {CHAT_MODELS.map((m, i) => {
                const eng = m.engine ?? "claude";
                const prevEng = i > 0 ? (CHAT_MODELS[i - 1].engine ?? "claude") : null;
                return (
                  <Fragment key={m.id}>
                    {eng !== prevEng && (
                      <div
                        className={`px-3 pb-1 pt-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--color-faint)] ${
                          i > 0 ? "mt-1 border-t border-[var(--color-border)] pt-2" : ""
                        }`}
                      >
                        {eng === "codex" ? "codex · chatgpt sub" : eng === "opencode" ? "opencode · free" : "claude"}
                      </div>
                    )}
                    <MenuItem
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
                        {m.hot && <Sparkles size={13} className="text-[var(--color-accent)]" />}
                        {m.label}
                        {m.hot && (
                          <span className="rounded-full bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-accent)]">
                            new
                          </span>
                        )}
                        {m.disabled && m.note && (
                          <span className="rounded bg-[var(--color-panel)] px-1.5 py-0.5 text-[10px] text-[var(--color-faint)]">
                            {m.note}
                          </span>
                        )}
                      </span>
                    </MenuItem>
                  </Fragment>
                );
              })}
            </Dropdown>

            {voicePhase === "transcribing" ? (
              <div className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-accent)]">
                <Loader2 size={16} className="animate-spin" />
              </div>
            ) : null}

            {/* send / steer / queue / stop. The label is the contract. */}
            {activeRun ? (
              <>
                {hasDraft && (
                  <button
                    type="button"
                    onClick={send}
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
      empty,
      openMenu,
      permission,
      effort,
      model,
      ctxTokens,
      images,
      voicePhase,
      voiceElapsed,
      streaming,
      backendBusy,
      activeRun,
      action,
      contextChips,
      memoryHits,
      lastAutoMemories,
      memoryContextStatus,
      attachedMemoryPaths,
      attachedMemories,
      openMemoryPanel,
      handoffPanelOpen,
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
        // AskUserQuestion is interactive — surface it as its own card, never
        // fold it into the silent "Worked for Xs" activity group.
        if (t.name === "AskUserQuestion") {
          flushTools();
          out.push({ kind: "question", id: t.id, turn: t });
          continue;
        }
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
      <ChatFileOpenContext.Provider value={openChatFile}>
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
            <span>{started ? "ready" : `starting ${model.engine ?? "claude"}…`}</span>
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
      </ChatFileOpenContext.Provider>
    );
  }

  return (
    <ChatCwdContext.Provider value={cwd ?? null}>
    <ChatFileOpenContext.Provider value={openChatFile}>
    <PaneDropZone onPath={insertPath} label="drop to add to message">
    <div
      data-chat-pane
      tabIndex={-1}
      onKeyDown={onPaneKeyDown}
      className="relative flex h-full min-h-0 w-full flex-col bg-[var(--color-bg)] outline-none"
    >
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-5 px-6 py-8">
          {resumedTitle && (
            <div className="flex justify-center">
              <ResumedNote title={resumedTitle} onClear={() => setResumedTitle(null)} />
            </div>
          )}
          <TranscriptBlocks
            blocks={blocks}
            streaming={streaming}
            lastActivityIdx={lastActivityIdx}
            liveStart={liveStart}
            onRegenerate={regenerate}
            onAssistantButton={handleAssistantButton}
            onOpenUrl={onOpenUrl}
            onResolveApproval={resolveApproval}
            answeredQuestions={answeredQuestions}
            onQuestionAnswer={handleQuestionAnswer}
          />
          {/* turn in flight with neither streamed text nor a live activity group
              yet (the very first beat) → the bare working timer */}
          {streaming &&
            streamingTurnId.current == null &&
            !(
              lastActivityIdx >= 0 &&
              (blocks[lastActivityIdx] as Extract<RenderBlock, { kind: "activity" }>)
                .durationMs == null
            ) && (
              <WorkingLine liveStart={liveStart} />
            )}
        </div>
      </div>
      {/* jump-to-latest pill — appears when autoscroll is paused or viewport is off-bottom */}
      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          title="scroll to bottom"
          className="absolute bottom-24 right-5 z-20 grid h-9 w-9 place-items-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-panel-2)]/95 text-[var(--color-text-2)] shadow-2xl shadow-black/40 backdrop-blur transition-colors hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)]"
        >
          <ArrowDown size={15} />
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
          <UsageStrip
            usage={usage}
            baseline={usageBaselineRef.current[usageProvider] ?? null}
            window={usageWindow}
            onWindowChange={setUsageWindow}
            engine={usageLabel}
          />
          {isComposerCollapsed ? (
            <button
              type="button"
              onClick={() => setComposerCollapsed(false)}
              title="show composer"
              className="flex min-h-10 w-full items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)]/80 px-3 py-2 text-left text-[12px] text-[var(--color-text-2)] shadow-xl shadow-black/25 backdrop-blur transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <CornerDownLeft size={14} className="shrink-0 text-[var(--color-accent)]" />
                <span className="truncate">composer hidden</span>
              </span>
              <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">
                {hasDraft ? "draft saved" : activeRun ? "run active" : "open"}
              </span>
            </button>
          ) : (
            composer
          )}
        </div>
      </div>
    </div>
    </PaneDropZone>
    </ChatFileOpenContext.Provider>
    </ChatCwdContext.Provider>
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
  engine,
}: {
  usage: { fiveHour: { pct: number | null; resetsAt: number | null }; sevenDay: { pct: number | null; resetsAt: number | null } } | null;
  baseline: { fiveHour: { pct: number | null; resetsAt: number | null }; sevenDay: { pct: number | null; resetsAt: number | null } } | null;
  window: "fiveHour" | "sevenDay";
  onWindowChange: (window: "fiveHour" | "sevenDay") => void;
  engine: string;
}) {
  const current = usage?.[window].pct ?? null;
  const initial = baseline?.[window].pct ?? current;
  // nothing to show yet (e.g. codex before its first rate-limit push) → hide.
  if (current == null) return null;
  const stack = current != null && initial != null ? usageStack(current, initial) : null;
  const reset = usage?.[window].resetsAt ? resetIn(usage[window].resetsAt) : "";
  const remaining = stack ? 100 - stack.total : null;
  const paceRisk =
    (engine === "codex" || engine === "spark") && usage
      ? usagePaceRisk({
          pct: current,
          resetsAt: usage[window].resetsAt,
          windowSeconds: window === "fiveHour" ? 5 * 3600 : 7 * 24 * 3600,
        })
      : null;
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
          {paceRisk && (
            <span
              className={`shrink-0 rounded border px-1.5 py-0.5 ${
                paceRisk.level === "danger"
                  ? "border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-[var(--color-danger)]"
                  : "border-[color-mix(in_srgb,var(--color-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] text-[var(--color-warning)]"
              }`}
              title={paceRisk.detail}
            >
              {paceRisk.title}
            </span>
          )}
          {reset && <span className="shrink-0">resets {reset}</span>}
        </>
      ) : (
        <span className="flex-1" />
      )}
    </div>
  );
}

// ── sub-views ────────────────────────────────────────────────────────────────

/**
 * The 1Hz "Working… m:ss" tick, owned BY THE LEAF that shows it. Given the turn's
 * start timestamp (`liveStart`, which changes at most once per turn), it runs its
 * own per-second interval and returns the elapsed ms — so the running clock
 * re-renders only this tiny component, never the whole message list. When
 * `liveStart` is null (idle) no interval runs and it returns 0.
 */
function useLiveElapsed(liveStart: number | null): number {
  const [elapsed, setElapsed] = useState(() =>
    liveStart != null ? Date.now() - liveStart : 0,
  );
  useEffect(() => {
    if (liveStart == null) {
      setElapsed(0);
      return;
    }
    // paint immediately, then tick each second
    setElapsed(Date.now() - liveStart);
    const iv = setInterval(() => setElapsed(Date.now() - liveStart), 1000);
    return () => clearInterval(iv);
  }, [liveStart]);
  return elapsed;
}

/**
 * Codex-style activity group: one subtle, hairline-free line — "Worked for Xs ›"
 * (or a live "Working… m:ss" with a shimmer while the turn is in flight) — that
 * collapses an entire run of tool calls. Click to expand the tight step list;
 * each step is one line (icon + verb + truncated target). Any files the steps
 * wrote (Write/Edit/NotebookEdit) surface as artifact cards beneath the list.
 */
const ActivityGroup = memo(function ActivityGroup({
  tools,
  durationMs,
  live,
  liveStart,
}: {
  tools: ToolTurn[];
  durationMs?: number;
  live: boolean;
  /** Turn-start timestamp; the live timer ticks internally off this leaf. */
  liveStart: number | null;
}) {
  // expanded while the turn is live (so you watch tools run in real time), then
  // auto-collapses to "Worked for Xs ›" when done — unless the user toggled it.
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? live;
  // own the 1Hz tick here (only while THIS group is live) so the running clock
  // doesn't re-render the parent / the rest of the transcript.
  const elapsedMs = useLiveElapsed(live ? liveStart : null);

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
});

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
  // the real, model-emitted file path this tool acted on → deterministic open.
  const filePath = toolFilePath(turn);
  const openInPane = useChatFileOpener();

  // running step opens itself while the turn is live, and an errored step always
  // opens (you want to see what broke); otherwise user-controlled. (AI Elements
  // `Tool` lifecycle: auto-expand on running, error.)
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? ((live && running) || turn.isError === true);

  return (
    <div className="group/step flex flex-col">
      <div className="flex w-full items-center gap-2 rounded-md py-0.5 pr-1">
      <button
        type="button"
        onClick={() => expandable && setUserToggled(!open)}
        title={full || undefined}
        className={`flex min-w-0 flex-1 items-center gap-2 text-left ${
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
      </button>
        {filePath && (
          <button
            type="button"
            title={`open ${filePath} in pane`}
            onClick={(e) => {
              e.stopPropagation();
              openInPane(filePath);
            }}
            className="shrink-0 grid h-5 w-5 place-items-center rounded text-[var(--color-faint)] opacity-0 transition-opacity hover:bg-[var(--color-panel)] hover:text-[var(--color-accent)] group-hover/step:opacity-100"
          >
            <FileText size={12} />
          </button>
        )}
        {running ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-[var(--color-faint)]" />
        ) : turn.isError ? (
          <X size={12} className="shrink-0 text-[var(--color-danger)]" />
        ) : expandable ? (
          <button
            type="button"
            onClick={() => setUserToggled(!open)}
            className="shrink-0"
          >
            <ChevronRight
              size={12}
              className={`text-[var(--color-faint)] transition-transform ${open ? "rotate-90" : ""}`}
            />
          </button>
        ) : null}
      </div>
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
  const openInPane = useChatFileOpener();
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
  const openWith = (mode: "editor" | "viewer" | "files") => {
    setErr(null);
    const ok =
      mode === "editor"
        ? openEditorFileInPane(artifact.path, artifact.name)
        : mode === "viewer"
          ? openViewerFileInPane(artifact.path, artifact.name)
          : revealFileInPane(artifact.path, artifact.name);
    if (ok) return;
    openPath(artifact.path).catch((e) => {
      setErr(String(e));
      console.error("openPath failed:", artifact.path, e);
    });
  };
  const open = () => {
    setErr(null);
    // absolute path (claude file_path) → open directly; a relative one (some
    // codex apply_patch paths) → resolve against the session cwd first. Both
    // route through the same paneBus open primitive as FilesPane.
    if (artifact.path.startsWith("/") || artifact.path.startsWith("~/")) {
      if (openFileInPane(artifact.path, artifact.name)) return;
      openPath(artifact.path).catch((e) => {
        setErr(String(e));
        console.error("openPath failed:", artifact.path, e);
      });
      return;
    }
    openInPane(artifact.path);
  };
  return (
    <div
      title={err ? `${err} — ${artifact.path}` : `open ${artifact.path}`}
      className={`group/file flex max-w-full items-center gap-2.5 rounded-lg border bg-[var(--color-panel-2)] px-3 py-2 text-left transition-colors ${
        err
          ? "border-[var(--color-danger)]/50"
          : "border-[var(--color-border)] hover:border-[var(--color-accent)]/50"
      }`}
    >
      <button type="button" onClick={open} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
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
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/file:opacity-100">
        <ArtifactActionButton label="editor" icon={<Pencil size={12} />} onClick={() => openWith("editor")} />
        <ArtifactActionButton label="viewer" icon={<FileType size={12} />} onClick={() => openWith("viewer")} />
        <ArtifactActionButton label="files" icon={<Folder size={12} />} onClick={() => openWith("files")} />
      </span>
    </div>
  );
}

function ArtifactActionButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid h-6 w-6 place-items-center rounded text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
    >
      {icon}
    </button>
  );
}

/** The bare live working line when a turn is in flight before any tool runs.
 *  Owns its own 1Hz tick (useLiveElapsed off the turn-start timestamp) so the
 *  running clock re-renders ONLY this leaf, not the whole transcript. */
function WorkingLine({ liveStart }: { liveStart: number | null }) {
  const elapsedMs = useLiveElapsed(liveStart);
  return (
    <div className="flex items-center gap-1.5 font-sans text-[12.5px] text-[var(--color-muted)]">
      <Loader2 size={13} className="shrink-0 animate-spin text-[var(--color-accent)]" />
      <span className="animate-pulse">Working… {fmtClock(elapsedMs)}</span>
    </div>
  );
}

/** Faint, centered turn footer — tokens · cost · (duration on text-only turns). */
const ResultFooter = memo(function ResultFooter({
  turn,
}: {
  turn: Extract<Turn, { kind: "result" }>;
}) {
  return (
    <div className="text-center font-mono text-[10.5px] text-[var(--color-faint)]">
      {turn.text}
    </div>
  );
});

/** The conversation body, extracted + memo'd so composer keystrokes — which
 *  re-render the whole ChatPane (input is root state) — stop re-building and
 *  re-diffing the entire transcript element tree on every keypress. That diff
 *  was the main source of typing lag in long chats. All handler props are
 *  useCallback-stable, so this only re-renders when blocks/stream state move. */
const TranscriptBlocks = memo(function TranscriptBlocks({
  blocks,
  streaming,
  lastActivityIdx,
  liveStart,
  onRegenerate,
  onAssistantButton,
  onOpenUrl,
  onResolveApproval,
  answeredQuestions,
  onQuestionAnswer,
}: {
  blocks: RenderBlock[];
  streaming: boolean;
  lastActivityIdx: number;
  liveStart: number | null;
  onRegenerate: () => void;
  onAssistantButton: (label: string) => void;
  onOpenUrl?: (url: string) => void;
  onResolveApproval: (requestId: string, toolName: string, decision: ApprovalDecision) => void;
  answeredQuestions: Record<string, string>;
  onQuestionAnswer: (turnId: string, text: string) => void;
}) {
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === "activity" ? (
          <ActivityGroup
            key={b.id}
            tools={b.tools}
            durationMs={b.durationMs}
            // live only on the final activity group, while a turn is in
            // flight and it hasn't been closed by a result yet
            live={streaming && b.durationMs == null && i === lastActivityIdx}
            // pass the START timestamp (stable per-turn), not a per-second
            // elapsed value — the leaf owns its own 1Hz tick so this prop
            // change doesn't re-render the whole list every second.
            liveStart={liveStart}
          />
        ) : b.kind === "user" ? (
          <UserBubble key={b.id} turn={b.turn} streaming={streaming} onRegenerate={onRegenerate} />
        ) : b.kind === "assistant" ? (
          <AssistantBubble
            key={b.id}
            turn={b.turn}
            onButton={onAssistantButton}
            disabled={streaming}
            onOpenUrl={onOpenUrl}
          />
        ) : b.kind === "thinking" ? (
          <ThinkingBlock key={b.id} turn={b.turn} />
        ) : b.kind === "approval" ? (
          <ApprovalCard key={b.id} turn={b.turn} onResolve={onResolveApproval} />
        ) : b.kind === "question" ? (
          <QuestionCard
            key={b.id}
            turn={b.turn}
            answered={answeredQuestions[b.turn.id]}
            onAnswer={onQuestionAnswer}
          />
        ) : (
          <ResultFooter key={b.id} turn={b.turn} />
        ),
      )}
    </>
  );
});

const UserBubble = memo(function UserBubble({
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
      {turn.images && turn.images.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {turn.images.map((p) => (
            <img
              key={p}
              src={fileSrc(p)}
              alt="attached image"
              className="h-24 max-w-[180px] rounded-xl border border-[var(--color-border-strong)] object-cover"
            />
          ))}
        </div>
      )}
      {turn.text && !(turn.images?.length && /^\[\d+ images?\]$/.test(turn.text)) && (
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[var(--color-accent-soft)] px-4 py-2.5 font-sans text-[14px] leading-relaxed text-[var(--color-text)]">
          {turn.text}
        </div>
      )}
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
});

/** The model's extended-thinking trace — dim + collapsible. Auto-expanded while
 *  the tokens are streaming in (so you read the reasoning live), then collapses
 *  to a faint "Thought ›" line you can re-open. Mirrors claude-code's quiet trace. */
const ThinkingBlock = memo(function ThinkingBlock({
  turn,
}: {
  turn: Extract<Turn, { kind: "thinking" }>;
}) {
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
});

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

const AssistantBubble = memo(function AssistantBubble({
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
});

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
  // The panel renders through a PORTAL to document.body, fixed-positioned above
  // the trigger. An absolutely-positioned menu inside a pane card got clipped at
  // the window edge AND hidden under overlapping sibling cards (each card is its
  // own stacking context) — the portal escapes both. Repositions on window
  // resize / any scroll while open, and clamps to the viewport with internal
  // scroll for tall menus.
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ left?: number; right?: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const pad = 8;
      const bottom = window.innerHeight - b.top + 6;
      if (align === "right") {
        setPos({ right: Math.max(pad, window.innerWidth - b.right), bottom });
      } else {
        setPos({ left: Math.max(pad, b.left), bottom });
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align]);
  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={onToggle}
        className={
          triggerClassName ??
          "flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]/50 px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
        }
      >
        {trigger}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            style={{
              position: "fixed",
              bottom: pos.bottom,
              left: pos.left,
              right: pos.right,
              zIndex: 70,
              maxWidth: "min(92vw, 360px)",
            }}
            className="max-h-[min(55vh,420px)] min-w-[140px] overflow-y-auto rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] py-1 shadow-2xl shadow-black/50"
          >
            {children}
          </div>,
          document.body,
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
  currentSessionId,
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
  /** The engine session id currently open in THIS pane — its row gets an
   *  accent ring + "current" dot so "which one am I in" is obvious. */
  currentSessionId: string | null;
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
                    current={!!currentSessionId && s.id === currentSessionId}
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

/** The accent color for an engine — so claude/codex/opencode rows are
 *  distinguishable at a glance (claude=accent, codex=blue, opencode=amber). */
function engineColorVar(engine: string): string {
  if (engine === "codex") return "var(--color-info)";
  if (engine === "opencode") return "var(--color-warning)";
  return "var(--color-accent)";
}

/** One row in the /resume picker. Shows the title (stable first message), an
 *  engine-colored badge, a "where you left off" preview of the LATEST user
 *  message, and a faint meta line (project · relative time · model · id). The
 *  session currently open in THIS pane gets an accent ring + "current" dot so
 *  it's unmistakable which one you're working in. */
function ResumeRow({
  session,
  active,
  current,
  onMouseEnter,
  onClick,
}: {
  session: ChatSessionInfo;
  active: boolean;
  current: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const dir = baseName(session.cwd || "");
  const when = session.mtime ? fmtRelativeTime(session.mtime) : "";
  const engine = session.engine || "claude";
  const model = session.model || "";
  const preview = (session.last_user || "").trim();
  const engineColor = engineColorVar(engine);
  const sourceLabel =
    engine === "codex" ? "codex" : engine === "opencode" ? "opencode" : "chat";
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      style={current ? { boxShadow: `inset 2px 0 0 ${engineColor}` } : undefined}
      className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
        active
          ? "bg-[var(--color-accent-soft)]"
          : current
            ? "bg-[var(--color-panel)]/60"
            : "hover:bg-[var(--color-panel)]"
      }`}
    >
      <RotateCcw
        size={14}
        style={{ color: active || current ? engineColor : "var(--color-muted)" }}
        className="mt-0.5 shrink-0"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-sans text-[13px] text-[var(--color-text)]">
            {session.title || "untitled session"}
          </span>
          <span
            style={{ color: engineColor, borderColor: `color-mix(in srgb, ${engineColor} 40%, transparent)` }}
            className="shrink-0 rounded border px-1 py-0.5 font-mono text-[9px]"
          >
            {engine}
          </span>
          {current && (
            <span
              style={{ color: engineColor, borderColor: `color-mix(in srgb, ${engineColor} 50%, transparent)` }}
              className="shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-sans text-[9px] uppercase tracking-[0.06em]"
            >
              <span style={{ background: engineColor }} className="h-1.5 w-1.5 rounded-full" />
              current
            </span>
          )}
        </span>
        {preview && (
          <span className="mt-0.5 truncate font-sans text-[11.5px] text-[var(--color-text-2)]">
            {preview}
          </span>
        )}
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
        </span>
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 pt-0.5 sm:flex">
        <span className="rounded-md border border-[var(--color-border)] px-1.5 py-0.5 font-sans text-[10px] text-[var(--color-muted)]">
          {sourceLabel}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-sans text-[10px] ${
            active
              ? "border-[var(--color-accent)]/40 bg-[var(--color-panel)] text-[var(--color-text-2)]"
              : "border-transparent text-[var(--color-faint)]"
          }`}
        >
          resume
          <CornerDownLeft size={11} />
        </span>
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
