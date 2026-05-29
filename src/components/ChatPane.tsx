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
import { Channel } from "@tauri-apps/api/core";
import {
  ArrowUp,
  AtSign,
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  CornerDownLeft,
  FileText,
  Folder,
  HelpCircle,
  ListChecks,
  Loader2,
  Mic,
  Plus,
  RefreshCw,
  ShieldQuestion,
  Slash,
  Sparkles,
  Square,
  Target,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import {
  buildApprovalLine,
  chatInterrupt,
  chatSend,
  chatSendRaw,
  chatStart,
  chatStop,
  CHAT_MODELS,
  EFFORTS,
  PERMISSION_MODES,
  type ApprovalDecision,
  type ChatEvent,
  type ChatModel,
} from "../lib/chat";
import { readDir, type DirEntry } from "../lib/fs";
import { paneWriters } from "../lib/paneBus";

// ── transcript model ──────────────────────────────────────────────────────

type Turn =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
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
    };

let _uid = 0;
const uid = () => `t${++_uid}`;

// instruction prefixes for the composer modes
const PLAN_PREFIX =
  "Plan first: lay out a concise step-by-step plan and wait for my go-ahead before writing any code or running mutating commands.\n\n";
const GOAL_PREFIX = (goal: string) =>
  `Ongoing goal (keep pursuing this across turns until I say it's done): ${goal}\n\n`;

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

// ── component ────────────────────────────────────────────────────────────────

export function ChatPane({ cwd, paneKey }: { cwd?: string; paneKey?: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [started, setStarted] = useState(false);

  // composer settings
  const [model, setModel] = useState<ChatModel>(CHAT_MODELS[0]);
  const [permission, setPermission] = useState(PERMISSION_MODES[0]);
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>(EFFORTS[1]);

  // mode chips
  const [planMode, setPlanMode] = useState(false);
  const [goal, setGoal] = useState<string>("");

  // open-dropdown tracking (single source so only one is open)
  const [openMenu, setOpenMenu] = useState<null | "model" | "perm" | "effort">(
    null,
  );

  // overlay popovers anchored to the composer (slash menu / @-files)
  const [overlay, setOverlay] = useState<null | "slash" | "mention">(null);
  const [overlayIdx, setOverlayIdx] = useState(0);
  const [mentionItems, setMentionItems] = useState<DirEntry[]>([]);
  const [mentionQuery, setMentionQuery] = useState("");

  const sessionIdRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // index into `turns` of the assistant bubble currently being streamed
  const streamingTurnId = useRef<string | null>(null);
  // last user prompt text actually sent to claude (for regenerate)
  const lastSentRef = useRef<string | null>(null);
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
    return () => {
      paneWriters.delete(paneKey);
    };
  }, [paneKey]);

  // ── event ingestion ───────────────────────────────────────────────────────

  const handleEvent = useCallback((ev: ChatEvent) => {
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

      // full assistant message — finalize text + spawn tool cards
      case "assistant": {
        const blocks = ev.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "tool_use") {
            const tid = b.id ?? uid();
            setTurns((prev) => {
              if (prev.some((t) => t.kind === "tool" && t.id === tid)) {
                return prev;
              }
              return [
                ...prev,
                {
                  kind: "tool",
                  id: tid,
                  name: b.name ?? "tool",
                  input: (b.input as Record<string, unknown>) ?? {},
                },
              ];
            });
          }
        }
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
          prev.map((t) =>
            t.kind === "assistant" && t.streaming
              ? { ...t, streaming: false }
              : t,
          ),
        );
        streamingTurnId.current = null;
        setStreaming(false);
        const dur = ev.duration_ms ? `${(ev.duration_ms / 1000).toFixed(1)}s` : "";
        const costNum =
          typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined;
        const cost = costNum != null ? `$${costNum.toFixed(4)}` : "";
        const tokens = tokensFromUsage(ev.usage);
        const tokStr =
          tokens != null ? `${tokens.toLocaleString()} tok` : "";
        const foot = [dur, tokStr, cost].filter(Boolean).join(" · ");
        if (foot) {
          setTurns((prev) => [
            ...prev,
            { kind: "result", id: uid(), text: foot, cost: costNum, tokens },
          ]);
        }
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
        setStreaming(false);
        return;
      }

      // system init / hooks / rate-limit → ignored in the transcript
      default:
        return;
    }
  }, []);

  // ── session lifecycle: one channel + one session per mount ─────────────────
  // `restartKey` lets `/clear` tear down + re-spin the session without changing
  // any of the model/permission deps.
  const [restartKey, setRestartKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    setStarted(false);
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

    chatStart(chan, {
      cwd: cwd ?? null,
      model: model.disabled ? null : model.id,
      permissionMode: permission.id,
      effort: effort.id,
    })
      .then((id) => {
        if (disposed) {
          chatStop(id).catch(() => {});
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
      if (id != null) chatStop(id).catch(() => {});
    };
    // model/permission/effort are captured at start; changing them restarts the session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.id, permission.id, effort.id, cwd, restartKey]);

  // autoscroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // autosize textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [input]);

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
    (display: string, opts?: { skipUserBubble?: boolean }) => {
      const id = sessionIdRef.current;
      if (id == null) return;
      let wire = display;
      if (goal.trim()) wire = GOAL_PREFIX(goal.trim()) + wire;
      if (planMode) wire = PLAN_PREFIX + wire;
      lastSentRef.current = display;
      if (!opts?.skipUserBubble) {
        setTurns((prev) => [...prev, { kind: "user", id: uid(), text: display }]);
      }
      setStreaming(true);
      streamingTurnId.current = null;
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
    [goal, planMode],
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || streaming || sessionIdRef.current == null) return;
    setInput("");
    setOverlay(null);
    dispatch(text);
  }, [input, streaming, dispatch]);

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

  // hard reset: clear transcript + re-spin the claude session
  const clearSession = useCallback(() => {
    setTurns([]);
    setStreaming(false);
    streamingTurnId.current = null;
    lastSentRef.current = null;
    setInput("");
    setOverlay(null);
    setRestartKey((k) => k + 1);
  }, []);

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
    [clearSession],
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

  // ── keyboard ─────────────────────────────────────────────────────────────────

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // overlay navigation takes priority
    if (overlay) {
      const list =
        overlay === "slash" ? slashFiltered : mentionFiltered;
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const canSend = input.trim().length > 0 && !streaming && started;

  // ── composer (shared between empty hero + docked) ──────────────────────────

  const composer = useMemo(
    () => (
      <div className="relative">
        {/* mode chips above the box: plan + pursue-goal */}
        {(planMode || goal) && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {planMode && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text)]">
                <ListChecks size={12} className="text-[var(--color-accent)]" />
                plan first
                <button
                  type="button"
                  onClick={() => setPlanMode(false)}
                  className="ml-0.5 rounded-full p-0.5 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  title="cancel plan mode"
                >
                  <X size={11} />
                </button>
              </span>
            )}
            {goal && (
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-panel)]/70 px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text-2)]">
                <Target size={12} className="shrink-0 text-[var(--color-accent)]" />
                <span className="truncate">goal: {goal}</span>
                <button
                  type="button"
                  onClick={() => setGoal("")}
                  className="ml-0.5 shrink-0 rounded-full p-0.5 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  title="clear goal"
                >
                  <X size={11} />
                </button>
              </span>
            )}
          </div>
        )}

        {/* slash / @-mention overlay */}
        {overlay === "slash" && slashFiltered.length > 0 && (
          <OverlayPanel>
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

        <div className="rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)]/70 shadow-2xl shadow-black/40 backdrop-blur transition-colors focus-within:border-[var(--color-accent)]/50">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => onChangeInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={planMode ? "describe the task to plan…" : "do anything"}
            spellCheck={false}
            className="block w-full resize-none bg-transparent px-5 pt-4 pb-2 font-sans text-[15px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
          />
          <div className="flex items-center gap-1.5 px-3 pb-3 pt-1">
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
              trigger={
                <>
                  <span>{effort.label}</span>
                  <ChevronDown size={12} className="text-[var(--color-faint)]" />
                </>
              }
            >
              {EFFORTS.map((ef) => (
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
              ))}
            </Dropdown>

            {/* plan toggle */}
            <button
              type="button"
              onClick={() => setPlanMode((p) => !p)}
              title="plan first on the next message"
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[11.5px] transition-colors ${
                planMode
                  ? "border-[var(--color-accent)]/50 bg-[var(--color-accent-soft)] text-[var(--color-text)]"
                  : "border-[var(--color-border)] bg-[var(--color-panel)]/50 text-[var(--color-text-2)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
              }`}
            >
              <ListChecks size={13} />
              <span>plan</span>
            </button>

            {/* pursue-goal pill: set / focus */}
            <button
              type="button"
              onClick={() => {
                const next = window.prompt(
                  "pursue goal — prepended as context each turn until cleared:",
                  goal,
                );
                if (next != null) setGoal(next.trim());
              }}
              title="set an ongoing goal"
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[11.5px] transition-colors ${
                goal
                  ? "border-[var(--color-accent)]/50 bg-[var(--color-accent-soft)] text-[var(--color-text)]"
                  : "border-[var(--color-border)] bg-[var(--color-panel)]/50 text-[var(--color-text-2)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
              }`}
            >
              <Target size={13} />
              <span>goal</span>
            </button>

            <div className="flex-1" />

            {/* model selector (right) */}
            <Dropdown
              open={openMenu === "model"}
              onToggle={() => setOpenMenu(openMenu === "model" ? null : "model")}
              align="right"
              trigger={
                <>
                  <span>{model.label}</span>
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

            {/* mic */}
            <button
              type="button"
              className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
              title="dictate (⌘J)"
            >
              <Mic size={16} />
            </button>

            {/* send / stop */}
            {streaming ? (
              <button
                type="button"
                onClick={stop}
                className="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-danger)] text-[var(--color-bg)] transition-all hover:opacity-90"
                title="stop"
              >
                <Square size={14} className="fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                className="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-accent)] text-[var(--color-bg)] transition-all hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-panel)] disabled:text-[var(--color-faint)]"
                title="send"
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    ),
    // re-render composer on the inputs that affect it
    [
      input,
      openMenu,
      permission,
      effort,
      model,
      streaming,
      canSend,
      send,
      stop,
      planMode,
      goal,
      overlay,
      overlayIdx,
      slashFiltered,
      mentionFiltered,
      cwd,
      pickSlash,
      pickMention,
    ],
  );

  // ── render ──────────────────────────────────────────────────────────────────

  if (empty) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center bg-[var(--color-bg)] px-6">
        <div className="w-full max-w-2xl">
          <h1 className="mb-7 text-center font-sans text-3xl font-medium tracking-tight text-[var(--color-text)]">
            what should we work on?
          </h1>
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
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-bg)]">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-5 px-6 py-8">
          {turns.map((t) => (
            <TurnView
              key={t.id}
              turn={t}
              streaming={streaming}
              onRegenerate={regenerate}
              onResolveApproval={resolveApproval}
            />
          ))}
          {streaming && streamingTurnId.current == null && <Thinking />}
        </div>
      </div>
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg)]/80 px-6 pb-5 pt-3 backdrop-blur">
        <div className="mx-auto max-w-2xl">{composer}</div>
      </div>
    </div>
  );
}

// ── sub-views ────────────────────────────────────────────────────────────────

function TurnView({
  turn,
  streaming,
  onRegenerate,
  onResolveApproval,
}: {
  turn: Turn;
  streaming: boolean;
  onRegenerate: () => void;
  onResolveApproval: (
    requestId: string,
    toolName: string,
    decision: ApprovalDecision,
  ) => void;
}) {
  if (turn.kind === "user") {
    return <UserBubble turn={turn} streaming={streaming} onRegenerate={onRegenerate} />;
  }

  if (turn.kind === "assistant") {
    return <AssistantBubble turn={turn} />;
  }

  if (turn.kind === "tool") {
    return <ToolCard turn={turn} />;
  }

  if (turn.kind === "approval") {
    return <ApprovalCard turn={turn} onResolve={onResolveApproval} />;
  }

  // result footer
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

function AssistantBubble({
  turn,
}: {
  turn: Extract<Turn, { kind: "assistant" }>;
}) {
  return (
    <div className="group flex flex-col items-start gap-1">
      <div className="max-w-[92%] font-sans text-[14.5px] leading-relaxed text-[var(--color-text-2)]">
        <Markdown text={turn.text} />
        {turn.streaming && (
          <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse bg-[var(--color-accent)]" />
        )}
      </div>
      {!turn.streaming && turn.text.trim() && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={turn.text} title="copy response" />
        </div>
      )}
    </div>
  );
}

function ToolCard({ turn }: { turn: Extract<Turn, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const args = previewArgs(turn.input);
  const isShell = turn.name.toLowerCase() === "bash";
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]/60">
      <button
        type="button"
        onClick={() => turn.result != null && setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left"
      >
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          {isShell ? <Terminal size={13} /> : <Wrench size={13} />}
        </span>
        <span className="shrink-0 font-mono text-[12px] font-medium text-[var(--color-text)]">
          {turn.name}
        </span>
        {args && (
          <span className="truncate font-mono text-[11.5px] text-[var(--color-muted)]">
            {args}
          </span>
        )}
        <span className="flex-1" />
        {turn.result == null ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-[var(--color-faint)]" />
        ) : (
          <ChevronDown
            size={13}
            className={`shrink-0 text-[var(--color-faint)] transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>
      {open && turn.result != null && (
        <pre
          className={`max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-[var(--color-border)] px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed ${
            turn.isError ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"
          }`}
        >
          {turn.result}
        </pre>
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

function Thinking() {
  return (
    <div className="flex items-center gap-2 font-sans text-[13px] text-[var(--color-faint)]">
      <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
      <span className="animate-pulse">thinking…</span>
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

function Markdown({ text }: { text: string }) {
  const segments = useMemo(() => splitFences(text), [text]);
  return (
    <div className="flex flex-col gap-2">
      {segments.map((seg, i) =>
        seg.code ? (
          <CodeBlock key={i} lang={seg.lang} body={seg.body} />
        ) : (
          <MarkdownBlocks key={i} text={seg.body} />
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
function MarkdownBlocks({ text }: { text: string }) {
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
                <Inline text={it} />
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
                <Inline text={it} />
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
          <Inline text={h[2]} />
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
        <Inline text={line} />
      </p>,
    );
  }
  flushList();
  return <>{out}</>;
}

/** Inline span formatting: `code`, **bold**, *italic* / _italic_, [text](url).
 *  Single-pass tokenizer — partial markers (e.g. a lone trailing `**` during
 *  streaming) just render literally, never throw. */
function Inline({ text }: { text: string }) {
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
        nodes.push(
          <code
            key={`c${k++}`}
            className="rounded bg-[var(--color-panel)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--color-text)]"
          >
            {text.slice(i + 1, end)}
          </code>,
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
            <Inline text={text.slice(i + 2, end)} />
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
          nodes.push(
            <a
              key={`a${k++}`}
              href={url}
              target="_blank"
              rel="noreferrer"
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
}: {
  open: boolean;
  onToggle: () => void;
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]/50 px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
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
function OverlayPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute bottom-full left-0 right-0 z-40 mb-2 max-h-64 overflow-y-auto rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] py-1 shadow-2xl shadow-black/50">
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
