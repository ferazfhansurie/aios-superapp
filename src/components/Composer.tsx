/**
 * Composer — the chat input surface, extracted out of ChatPane so that typing
 * (which is high-frequency) only re-renders THIS subtree instead of the whole
 * 5800-line ChatPane.
 *
 * The trick: `input`, `overlay`, and `overlayIdx` live in tiny external stores
 * (createStore) owned by ChatPane via refs. ChatPane keeps stable `setInput` /
 * `setOverlay` / `setOverlayIdx` setters callable from its ~50 existing call
 * sites; Composer subscribes reactively via useSyncExternalStore so a keystroke
 * re-renders only the composer. React.memo on the export keeps ChatPane's own
 * re-renders (transcript streaming) from re-rendering the composer when none of
 * the (stable) props actually change.
 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  ArrowDown,
  PackageOpen,
  Brain,
  Check,
  ChevronDown,
  Clock,
  CornerDownLeft,
  FileText,
  Folder,
  Gauge,
  History,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Mic,
  Pencil,
  RotateCcw,
  Search,
  ShieldQuestion,
  Sparkles,
  Square,
  Target,
  Waypoints,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  CHAT_MODELS,
  EFFORTS,
  PERMISSION_MODES,
  type ChatModel,
  type ChatSessionInfo,
} from "../lib/chat";
import { readDir, type DirEntry } from "../lib/fs";
import {
  composerContextChips,
  contextLedger,
  cycleQueueSelection,
  effortChipLabel,
  sendContract,
  type ContextBudgetMode,
  type QueuedMessage,
} from "../lib/chatPaneState";
import { memorySearch, type MemoryHit } from "../lib/memory";
import { baseName, fmtElapsed, fmtRelativeTime } from "./chat/chatFormat";
import { ModelIcon } from "./chat/modelIcons";

// ── external stores (input + overlay) ────────────────────────────────────────

/** A minimal external store: synchronous get/set + subscribe. The `.set`
 *  function is stable (created once) so ChatPane can hand it out as `setInput`
 *  etc. and React.memo'd consumers don't churn. */
export type Store<T> = {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (cb: () => void) => () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      const v = typeof next === "function" ? (next as (p: T) => T)(value) : next;
      if (v === value) return;
      value = v;
      subs.forEach((cb) => cb());
    },
    subscribe: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
}

/** The composer text store. Same shape as Store<string>; the `setInput`
 *  signature `(string | (prev) => string) => void` is preserved verbatim. */
export type InputStore = Store<string>;

export function createInputStore(initial: string): InputStore {
  return createStore<string>(initial);
}

export type OverlayKind = null | "slash" | "mention" | "resume";

// ── shared with ChatPane (RecentSessions imports these) ──────────────────────

/** The accent color for an engine — so claude/codex/opencode rows are
 *  distinguishable at a glance (claude=accent, codex=blue, opencode=amber). */
export function engineColorVar(engine: string): string {
  if (engine === "codex") return "var(--color-info)";
  if (engine === "opencode") return "var(--color-warning)";
  return "var(--color-accent)";
}

// Injected-context / system noise that pollutes first+last user messages in
// oracle sessions (the picker must never show these as a "title").
const BOILERPLATE_TITLE =
  /^#|AGENTS\.md|<INSTRUCTIONS>|critical_persona|you are AIOS|MICRO-CONTEXT|<system|reply with exactly|^resumed\b|<aios_context|aios_context>|<discord|discord_channel_context|purpose:\s*bounded|recent AIOS pushes|\[wa from|situational[- ]?context|<recent_cross_tool|<\/?[a-z_]+_context/i;

// Generic pane labels that say nothing about what the session is about.
const GENERIC_LABEL = /^(new\s+)?(codex\s+|opencode\s+|claude\s+)?chat$|^untitled|^session$/i;

export function resumeRowLabel(s: ChatSessionInfo): string {
  const clean = (v?: string | null) => (v || "").replace(/\s+/g, " ").trim();
  const usable = (v: string) =>
    v.length > 0 && v.length <= 200 && !BOILERPLATE_TITLE.test(v) && !GENERIC_LABEL.test(v);
  const first = clean(s.title);
  const last = clean(s.last_user);
  // prefer the first REAL message (stable label); fall back to the latest real one
  let label = usable(first) ? first : usable(last) ? last : "";
  if (!label) {
    // nothing meaningful in the transcript — stay honest (the engine/model/time
    // meta on the row still distinguishes it)
    const proj = baseName(s.cwd || "");
    label = proj && proj !== "firazfhansurie" ? `chat · ${proj}` : "untitled chat";
  }
  return label.length > 96 ? `${label.slice(0, 93)}…` : label;
}

function resumeAbsoluteTime(mtime: number): string {
  if (!mtime) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(mtime * 1000));
  } catch {
    return "";
  }
}

// ── waveform / context budget constants ──────────────────────────────────────

/** Precomputed equalizer bars for the inline dictation waveform (time-keyed). */
const WAVEFORM_BARS: { h: number; delay: number }[] = Array.from(
  { length: 40 },
  (_, i) => ({ h: 28 + ((i * 37) % 60), delay: (i * 70) % 900 }),
);
const WAVE_KEYFRAMES = `@keyframes aios-wave {
  0%, 100% { transform: scaleY(0.32); opacity: 0.55; }
  50% { transform: scaleY(1); opacity: 1; }
}`;

const CONTEXT_BUDGETS: Array<{ id: ContextBudgetMode; label: string; sub: string }> = [
  { id: "lean", label: "lean", sub: "minimal hidden context, full tools" },
  { id: "agent", label: "agent", sub: "full tools, explicit context files" },
  { id: "ultracode", label: "ultracode", sub: "xhigh + fanout, expensive by design" },
];

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
  const [pos, setPos] = useState<{
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const pad = 8;
      const gap = 6;
      const spaceAbove = b.top - pad;
      const spaceBelow = window.innerHeight - b.bottom - pad;
      const horizontal =
        align === "right"
          ? { right: Math.max(pad, window.innerWidth - b.right) }
          : { left: Math.max(pad, b.left) };
      // Open toward whichever side has more room and cap the menu to it, so a
      // tall list (the model picker) scrolls internally instead of running off
      // the top/bottom of the window and clipping rows.
      if (spaceAbove >= spaceBelow) {
        setPos({ ...horizontal, bottom: window.innerHeight - b.top + gap, maxHeight: Math.max(140, spaceAbove - gap) });
      } else {
        setPos({ ...horizontal, top: b.bottom + gap, maxHeight: Math.max(140, spaceBelow - gap) });
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
              top: pos.top,
              bottom: pos.bottom,
              left: pos.left,
              right: pos.right,
              zIndex: 70,
              maxWidth: "min(92vw, 360px)",
              maxHeight: pos.maxHeight,
            }}
            className="min-w-[140px] overflow-y-auto rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] py-1 shadow-2xl shadow-black/50"
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

export interface SlashCommand {
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
  // Flip up/down based on room around the composer anchor and cap height to the
  // available space — otherwise the upward `bottom-full` panel runs off the top
  // of the window in the empty/idle state (composer sits high) and the top of
  // the session list is clipped. Mirrors the Dropdown placement logic.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{ dir: "up" | "down"; maxHeight: number }>(
    () => ({ dir: "up", maxHeight: Math.round(window.innerHeight * 0.6) }),
  );
  useLayoutEffect(() => {
    const place = () => {
      const anchor = rootRef.current?.offsetParent as HTMLElement | null;
      const rect = anchor?.getBoundingClientRect();
      if (!rect) return;
      const pad = 12;
      const gap = 8;
      const spaceAbove = rect.top - pad;
      const spaceBelow = window.innerHeight - rect.bottom - pad;
      if (spaceBelow > spaceAbove) {
        setPlacement({ dir: "down", maxHeight: Math.max(180, spaceBelow - gap) });
      } else {
        setPlacement({ dir: "up", maxHeight: Math.max(180, spaceAbove - gap) });
      }
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [sessions.length, loading]);
  return (
    <div
      ref={rootRef}
      style={{ maxHeight: placement.maxHeight }}
      className={`absolute left-0 right-0 z-40 flex flex-col overflow-hidden rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] shadow-2xl shadow-black/50 ${
        placement.dir === "up" ? "bottom-full mb-2" : "top-full mt-2"
      }`}
    >
      {/* sticky search header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
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
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
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
  const absoluteWhen = resumeAbsoluteTime(session.mtime);
  const engine = session.engine || "claude";
  const model = session.model || "";
  const titleText = resumeRowLabel(session);
  const lastUser = (session.last_user || "").replace(/\s+/g, " ").trim();
  // only show the preview when it adds info beyond the (possibly last_user) title
  const preview = lastUser && lastUser !== titleText ? lastUser : "";
  const engineColor = engineColorVar(engine);
  const sourceLabel =
    engine === "codex" ? "codex" : engine === "opencode" ? "opencode" : "chat";
  const tooltip = [
    titleText,
    preview ? `last: ${preview}` : "",
    session.cwd,
    absoluteWhen,
    model || engine,
    session.id,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <button
      type="button"
      title={tooltip}
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
            {titleText || "untitled session"}
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
          <span className="mt-0.5 line-clamp-2 font-sans text-[11.5px] leading-snug text-[var(--color-text-2)]">
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
            <span className="inline-flex items-center gap-1" title={absoluteWhen || undefined}>
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

// ── Composer ─────────────────────────────────────────────────────────────────

/** A pasted/attached image: live thumbnail + its saved temp path (null while saving). */
export interface ComposerImage {
  id: string;
  url: string;
  path: string | null;
}

export interface ComposerProps {
  // ── stores (owned by ChatPane) ──
  store: InputStore;
  overlayStore: Store<OverlayKind>;
  overlayIdxStore: Store<number>;

  // ── persistence ──
  draftKey: string | null;

  // ── primitives / flags ──
  recording: boolean;
  empty: boolean;
  planMode: boolean;
  streaming: boolean;
  backendBusy: boolean;
  activeRun: boolean;
  started: boolean;
  model: ChatModel;
  permission: (typeof PERMISSION_MODES)[number];
  effort: (typeof EFFORTS)[number];
  effectiveBudget: ContextBudgetMode;
  cwd?: string;
  goal: string;
  runPhase: string;
  runEventCount: number;

  // ── computed-in-ChatPane (input-independent, memoized) ──
  contextChips: ReturnType<typeof composerContextChips>;

  // ── refs (owned by ChatPane, shared) ──
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  historyRef: React.MutableRefObject<string[]>;
  lastSentRef: React.MutableRefObject<string | null>;
  lastArrowDownRef: React.MutableRefObject<number>;
  imgInputRef: React.RefObject<HTMLInputElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  resumeSearchRef: React.RefObject<HTMLInputElement | null>;

  // ── images ──
  images: ComposerImage[];
  addImage: (file: Blob, mime: string) => void | Promise<void>;
  removeImage: (id: string) => void;
  attachPickedFiles: (files: FileList | null) => void;
  onPasteImage: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;

  // ── memory ──
  memoryPanelOpen: boolean;
  handoffPanelOpen: boolean;
  memoryHits: MemoryHit[];
  attachedMemoryPaths: string[];
  lastAutoMemories: MemoryHit[];
  memoryContextStatus: "ready" | "searching" | "error";
  attachedMemories: MemoryHit[];
  openMemoryPanel: () => void;
  setMemoryPanelOpen: (open: boolean) => void;
  setHandoffPanelOpen: (open: boolean) => void;
  setMemoryHits: React.Dispatch<React.SetStateAction<MemoryHit[]>>;
  setAttachedMemoryPaths: React.Dispatch<React.SetStateAction<string[]>>;

  // ── slash commands / voice ──
  slashCommands: SlashCommand[];
  voicePhase: "idle" | "recording" | "transcribing";
  voiceElapsed: number;
  micStart: () => void | Promise<void>;
  micStop: () => void | Promise<void>;

  // ── actions ──
  switchModel: (m: ChatModel) => void;
  runHandoff: (m: ChatModel) => void;
  sendText: (text: string) => void;
  stop: () => void;
  steerQueued: (id: string) => void;
  jumpToLatest: () => void;

  // ── queue ──
  queued: QueuedMessage[];
  queuedIdx: number;
  setQueuedIdx: React.Dispatch<React.SetStateAction<number>>;
  editingQueuedId: string | null;
  editingQueuedText: string;
  setEditingQueuedId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditingQueuedText: React.Dispatch<React.SetStateAction<string>>;
  editQueued: (item: QueuedMessage) => void;
  saveQueuedEdit: () => void;
  moveQueued: (id: string, delta: number) => void;
  removeQueued: (id: string) => void;

  // ── resume picker ──
  resumeSessions: ChatSessionInfo[];
  resumeFiltered: ChatSessionInfo[];
  resumeLoading: boolean;
  resumeQuery: string;
  setResumeQuery: (v: string) => void;
  loadResumeSessions: () => void | Promise<void>;
  resumeSession: (s: ChatSessionInfo) => void;
  closeResume: () => void;
  openSessionId: string | null;

  // ── menus / mode setters ──
  setPlanMode: React.Dispatch<React.SetStateAction<boolean>>;
  setGoal: React.Dispatch<React.SetStateAction<string>>;
  setComposerCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setOpenMenu: React.Dispatch<
    React.SetStateAction<null | "model" | "perm" | "effort" | "advanced">
  >;
  openMenu: null | "model" | "perm" | "effort" | "advanced";
  setContextBudget: React.Dispatch<React.SetStateAction<ContextBudgetMode>>;
  setEffort: React.Dispatch<React.SetStateAction<(typeof EFFORTS)[number]>>;
  setPermission: React.Dispatch<
    React.SetStateAction<(typeof PERMISSION_MODES)[number]>
  >;
}

function ComposerInner(props: ComposerProps) {
  const {
    store,
    overlayStore,
    overlayIdxStore,
    draftKey,
    recording,
    empty,
    planMode,
    streaming,
    backendBusy: _backendBusy,
    activeRun,
    started,
    model,
    permission,
    effort,
    effectiveBudget,
    cwd,
    goal,
    runPhase,
    runEventCount,
    contextChips,
    taRef,
    historyRef,
    lastSentRef,
    lastArrowDownRef,
    imgInputRef,
    fileInputRef,
    resumeSearchRef,
    images,
    addImage,
    removeImage,
    attachPickedFiles,
    onPasteImage,
    memoryPanelOpen,
    handoffPanelOpen,
    memoryHits,
    attachedMemoryPaths,
    lastAutoMemories,
    memoryContextStatus,
    attachedMemories,
    openMemoryPanel,
    setMemoryPanelOpen,
    setHandoffPanelOpen,
    setMemoryHits,
    setAttachedMemoryPaths,
    slashCommands,
    voicePhase,
    voiceElapsed,
    micStart,
    micStop,
    switchModel,
    runHandoff,
    sendText,
    stop,
    steerQueued,
    jumpToLatest,
    queued,
    queuedIdx,
    setQueuedIdx,
    editingQueuedId,
    editingQueuedText,
    setEditingQueuedId,
    setEditingQueuedText,
    editQueued,
    saveQueuedEdit,
    moveQueued,
    removeQueued,
    resumeSessions,
    resumeFiltered,
    resumeLoading,
    resumeQuery,
    setResumeQuery,
    loadResumeSessions,
    resumeSession,
    closeResume,
    openSessionId,
    setPlanMode,
    setGoal,
    setComposerCollapsed,
    setOpenMenu,
    openMenu,
    setContextBudget,
    setEffort,
    setPermission,
  } = props;

  void _backendBusy; // part of the contract (activeRun is derived in parent)

  const input = useSyncExternalStore(store.subscribe, store.get);
  const overlay = useSyncExternalStore(overlayStore.subscribe, overlayStore.get);
  const overlayIdx = useSyncExternalStore(overlayIdxStore.subscribe, overlayIdxStore.get);
  const setInput = store.set;
  const setOverlay = overlayStore.set;
  const setOverlayIdx = overlayIdxStore.set;

  // @-mention picker state — driven by typing, so it lives here.
  const [mentionItems, setMentionItems] = useState<DirEntry[]>([]);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionPrefix, setMentionPrefix] = useState("");

  // persist the draft as it changes (cleared on send) — debounced so we don't
  // hit localStorage synchronously on every keystroke. Replicates the
  // useDebouncedPersist behavior ChatPane used to own: trailing 300ms debounce,
  // flush latest on unmount, write input if truthy else removeItem.
  const persistRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    key: string | null;
    value: string;
  }>({ timer: null, key: draftKey, value: input });
  persistRef.current.key = draftKey;
  persistRef.current.value = input;
  const flushPersist = useCallback(() => {
    const r = persistRef.current;
    if (!r.key) return;
    try {
      if (r.value) localStorage.setItem(r.key, r.value);
      else localStorage.removeItem(r.key);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (!draftKey) return;
    const r = persistRef.current;
    if (r.timer != null) return; // a flush is already scheduled; it reads latest
    r.timer = setTimeout(() => {
      r.timer = null;
      flushPersist();
    }, 300);
    // value/key tracked via ref; effect just (re)arms the trailing timer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, input]);
  useEffect(
    () => () => {
      const r = persistRef.current;
      if (r.timer != null) {
        clearTimeout(r.timer);
        r.timer = null;
      }
      flushPersist();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // auto memory: search as the draft changes while the panel is open
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
  }, [input, cwd, memoryPanelOpen, setMemoryHits, setAttachedMemoryPaths]);

  // autosize textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [input, taRef]);

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
        if (overlayStore.get() !== "mention") {
          setOverlay("mention");
          setOverlayIdx(0);
        }
        void loadMentions(query);
        return;
      }
      if (overlayStore.get()) setOverlay(null);
    },
    [overlayStore, setOverlay, setOverlayIdx, loadMentions],
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

  // keep the /resume highlight in-bounds as the typed filter shrinks the list
  useEffect(() => {
    if (overlay !== "resume") return;
    setOverlayIdx((i) =>
      resumeFiltered.length === 0 ? 0 : Math.min(i, resumeFiltered.length - 1),
    );
  }, [resumeFiltered.length, overlay, setOverlayIdx]);

  const pickSlash = useCallback((cmd: SlashCommand) => {
    cmd.run();
  }, []);

  const pickMention = useCallback(
    (entry: DirEntry) => {
      const base = mentionPrefix || "";
      const insert = entry.is_dir ? `${base}${entry.name}/` : `${base}${entry.name}`;
      setInput((v) => v.replace(/(^|\s)@([^\s]*)$/, `$1@${insert} `));
      setOverlay(null);
      taRef.current?.focus();
    },
    [mentionPrefix, setInput, setOverlay, taRef],
  );

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
        if (list.length) resumeSession(list[overlayIdxStore.get()] ?? list[0]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeResume();
      }
    },
    [resumeFiltered, overlayIdxStore, setOverlayIdx, resumeSession, closeResume],
  );

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
  }, [input, overlay, recording, historyRef]);
  const ghostRef = useRef("");
  ghostRef.current = ghost;
  const acceptGhost = useCallback(() => {
    if (ghostRef.current) setInput((v) => v + ghostRef.current);
  }, [setInput]);

  // build the live send from the store so it stays stable yet reads fresh text
  const send = useCallback(() => sendText(store.get()), [sendText, store]);

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

  // ── input-derived computations (kept here so typing doesn't re-render parent) ──
  const hasDraft = input.trim().length > 0;
  const hasReadyImages = images.some((im) => im.path);
  const action = sendContract({
    streaming: activeRun,
    hasDraft,
    hasImages: hasReadyImages,
    engine: model.engine ?? "claude",
    started,
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

  return (
    <div className="relative">
      {/* context contract: what this send will use, before the user fires it. */}
      {contextChips.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {contextChips.map((chip) => (
            <span
              key={chip.id}
              className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[11.5px] ${
                chip.id === "plan" || chip.id === "goal"
                  ? "border-white/15 bg-white/[0.07] text-[var(--color-text)] backdrop-blur-md"
                  : "border-white/10 bg-white/[0.05] text-[var(--color-text-2)] backdrop-blur-md"
              }`}
              title={chip.label}
            >
              {chip.id === "cwd" ? (
                <Folder size={12} className="shrink-0 text-[#60a5fa]" />
              ) : chip.id === "attachments" ? (
                <ImageIcon size={12} className="shrink-0 text-[var(--color-muted)]" />
              ) : chip.id === "queue" ? (
                <Waypoints size={12} className="shrink-0 text-[var(--color-muted)]" />
              ) : chip.id === "plan" ? (
                <ListChecks size={12} className="shrink-0 text-[#34d399]" />
              ) : chip.id === "goal" ? (
                <Target size={12} className="shrink-0 text-[#f59e0b]" />
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
            <span
              className={`inline-flex max-w-full items-center gap-1.5 rounded-full border bg-white/[0.05] px-2.5 py-1 font-sans text-[11.5px] backdrop-blur-md ${
                /fail|error|blocked/i.test(runPhase)
                  ? "border-[var(--color-danger)]/40 text-[var(--color-danger)]"
                  : "border-white/10 text-[var(--color-text-2)]"
              }`}
            >
              <Waypoints
                size={12}
                className={`shrink-0 ${
                  /fail|error|blocked/i.test(runPhase)
                    ? "text-[var(--color-danger)]"
                    : "text-[var(--color-muted)]"
                }`}
              />
              <span className="truncate">run: {runPhase}</span>
            </span>
          )}
          <button
            type="button"
            onClick={openMemoryPanel}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[11.5px] backdrop-blur-md transition-colors ${
              memoryContextStatus === "error"
                ? "border-[var(--color-danger)]/45 bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)]"
                : lastAutoMemories.length > 0
                  ? "border-[#a78bfa]/35 bg-white/[0.06] text-[var(--color-text)]"
                  : "border-white/10 bg-white/[0.05] text-[var(--color-text-2)] hover:border-white/20 hover:text-[var(--color-text)]"
            }`}
            title={
              memoryContextStatus === "searching"
                ? "searching memory for this send"
                : lastAutoMemories.length > 0
                  ? `auto memory used: ${lastAutoMemories.map((m) => m.title).join("; ")}`
                  : "auto memory is on. click to inspect inline"
            }
          >
            <Brain size={12} className="shrink-0 text-[#a78bfa]" />
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
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#a78bfa]/35 bg-white/[0.06] px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text)] backdrop-blur-md"
              title="show inline memory"
            >
              <Brain size={12} className="shrink-0 text-[#a78bfa]" />
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
              onClick={() => runHandoff(target)}
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
                      <Folder size={14} className="text-[#60a5fa]" />
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

      <div className="flash-composer relative rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] shadow-lg shadow-black/20 transition-colors focus-within:border-[var(--color-accent)]/35 focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_18%,transparent)]">
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
                    : "ask, build, or pick up where you left off…"
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
                ? "flex items-center gap-1.5 rounded-full border border-[#34d399]/35 bg-white/[0.06] px-3 py-1 font-sans text-[12px] font-medium text-[var(--color-text-2)] backdrop-blur-md transition-colors hover:border-[#34d399]/55 hover:text-[var(--color-text)]"
                : "flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 font-sans text-[12px] font-medium text-[var(--color-text-2)] backdrop-blur-md transition-colors hover:border-white/20 hover:text-[var(--color-text)]"
            }
            trigger={
              <>
                <ShieldQuestion
                  size={13}
                  className={`shrink-0 ${
                    permission.id === "bypassPermissions"
                      ? "text-[#34d399]"
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
                  ? "flex items-center gap-1.5 rounded-full border border-[#a855f7]/40 bg-white/[0.06] px-3 py-1 font-sans text-[12px] font-semibold text-[var(--color-text)] backdrop-blur-md transition-colors hover:border-[#a855f7]/60"
                  : "flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 font-sans text-[12px] font-medium text-[var(--color-text-2)] backdrop-blur-md transition-colors hover:border-white/20 hover:text-[var(--color-text)]"
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
            triggerClassName="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 font-sans text-[12px] font-semibold text-[var(--color-text)] backdrop-blur-md transition-colors hover:border-white/20 hover:bg-white/[0.1]"
            trigger={
              <>
                <span className="shrink-0">
                  <ModelIcon model={model} size={13} />
                </span>
                <span className="whitespace-nowrap">{model.label}</span>
                {model.hot && (
                  <Sparkles size={11} className="shrink-0 text-[#a78bfa]" />
                )}
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
                      switchModel(m);
                      setOpenMenu(null);
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <span className="shrink-0 text-[var(--color-accent)]">
                        <ModelIcon model={m} size={13} />
                      </span>
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
                  className="flex h-8 items-center gap-1.5 rounded-full border border-[var(--color-accent)]/45 bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] px-3 text-[12px] font-medium text-[var(--color-accent)] backdrop-blur-md transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_32%,transparent)] disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-[var(--color-faint)]"
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
              className="flex h-8 items-center gap-1.5 rounded-full border border-[var(--color-accent)]/45 bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] px-3 text-[12px] font-medium text-[var(--color-accent)] backdrop-blur-md transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_32%,transparent)] disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-[var(--color-faint)]"
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
  );
}

export const Composer = memo(ComposerInner);
