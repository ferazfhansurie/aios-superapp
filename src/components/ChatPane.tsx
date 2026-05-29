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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import {
  ArrowUp,
  ChevronDown,
  Loader2,
  Mic,
  Plus,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  chatSend,
  chatStart,
  chatStop,
  CHAT_MODELS,
  EFFORTS,
  PERMISSION_MODES,
  type ChatEvent,
  type ChatModel,
} from "../lib/chat";

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
  | { kind: "result"; id: string; text: string };

let _uid = 0;
const uid = () => `t${++_uid}`;


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

// ── component ────────────────────────────────────────────────────────────────

export function ChatPane({ cwd }: { cwd?: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [started, setStarted] = useState(false);

  // composer settings
  const [model, setModel] = useState<ChatModel>(CHAT_MODELS[0]);
  const [permission, setPermission] = useState(PERMISSION_MODES[0]);
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>(EFFORTS[1]);

  // open-dropdown tracking (single source so only one is open)
  const [openMenu, setOpenMenu] = useState<null | "model" | "perm" | "effort">(
    null,
  );

  const sessionIdRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // index into `turns` of the assistant bubble currently being streamed
  const streamingTurnId = useRef<string | null>(null);

  const empty = turns.length === 0;

  // ── event ingestion ───────────────────────────────────────────────────────

  const handleEvent = useCallback((ev: ChatEvent) => {
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
        const cost =
          typeof ev.total_cost_usd === "number"
            ? `$${ev.total_cost_usd.toFixed(4)}`
            : "";
        const foot = [dur, cost].filter(Boolean).join(" · ");
        if (foot) {
          setTurns((prev) => [
            ...prev,
            { kind: "result", id: uid(), text: foot },
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

  useEffect(() => {
    let disposed = false;
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
      if (id != null) chatStop(id).catch(() => {});
    };
    // model/permission/effort are captured at start; changing them restarts the session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.id, permission.id, effort.id, cwd]);

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

  // ── submit ─────────────────────────────────────────────────────────────────

  const send = useCallback(() => {
    const text = input.trim();
    const id = sessionIdRef.current;
    if (!text || streaming || id == null) return;
    setTurns((prev) => [...prev, { kind: "user", id: uid(), text }]);
    setInput("");
    setStreaming(true);
    streamingTurnId.current = null;
    chatSend(id, text).catch((err) => {
      setTurns((prev) => [
        ...prev,
        { kind: "result", id: uid(), text: `send failed: ${err}` },
      ]);
      setStreaming(false);
    });
  }, [input, streaming]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const canSend = input.trim().length > 0 && !streaming && started;

  // ── composer (shared between empty hero + docked) ──────────────────────────

  const composer = useMemo(
    () => (
      <div className="rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)]/70 shadow-2xl shadow-black/40 backdrop-blur transition-colors focus-within:border-[var(--color-accent)]/50">
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="do anything"
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
            title="voice (coming)"
          >
            <Mic size={16} />
          </button>

          {/* send */}
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            className="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-accent)] text-[var(--color-bg)] transition-all hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-panel)] disabled:text-[var(--color-faint)]"
            title="send"
          >
            {streaming ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <ArrowUp size={16} />
            )}
          </button>
        </div>
      </div>
    ),
    // re-render composer on the inputs that affect it
    [input, openMenu, permission, effort, model, streaming, canSend, send],
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
          <p className="mt-3 text-center font-mono text-[11px] text-[var(--color-faint)]">
            {started ? "claude · ready" : "starting claude…"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-bg)]">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-5 px-6 py-8">
          {turns.map((t) => (
            <TurnView key={t.id} turn={t} />
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

function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[var(--color-accent-soft)] px-4 py-2.5 font-sans text-[14px] leading-relaxed text-[var(--color-text)]">
          {turn.text}
        </div>
      </div>
    );
  }

  if (turn.kind === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] whitespace-pre-wrap break-words font-sans text-[14.5px] leading-relaxed text-[var(--color-text-2)]">
          {turn.text}
          {turn.streaming && (
            <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse bg-[var(--color-accent)]" />
          )}
        </div>
      </div>
    );
  }

  if (turn.kind === "tool") {
    return <ToolCard turn={turn} />;
  }

  // result footer
  return (
    <div className="text-center font-mono text-[10.5px] text-[var(--color-faint)]">
      {turn.text}
    </div>
  );
}

function ToolCard({
  turn,
}: {
  turn: Extract<Turn, { kind: "tool" }>;
}) {
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

function Thinking() {
  return (
    <div className="flex items-center gap-2 font-sans text-[13px] text-[var(--color-faint)]">
      <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
      <span className="animate-pulse">thinking…</span>
    </div>
  );
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
