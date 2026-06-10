/** ⌘K command palette — VS Code / Raycast style fuzzy launcher.
 *  Self-contained: own fuzzy matcher (subsequence + contiguity/word-boundary
 *  scoring), keyboard nav, grouped results, match highlighting. No deps beyond
 *  React + lucide-react. App.tsx owns the `open` state + global ⌘K listener and
 *  passes a `commands` array — see the usage snippet in the PR notes. */
import { lazy, memo, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

/** Max rows rendered at once. Scoring still ranks the full set; we just never
 *  paint more than this many buttons (the rest are unreachable noise anyway).
 *  Caps DOM churn so typing stays smooth even with hundreds of commands. */
const MAX_RESULTS = 50;

import { Brain, CornerDownLeft, Globe, MessageSquare, Search } from "lucide-react";
import { reportUsage } from "../lib/diag";

/** CDP "real Chrome" spike pane (dev-only reachability). The pane can't go
 *  through App.tsx's kind registry yet (that wiring is a later coordinated
 *  wave), so the palette hosts it as a fullscreen overlay it fully owns.
 *  Lazy so the spike never costs the normal palette bundle anything. */
const CdpChromePane = lazy(() =>
  import("./CdpChromePane").then((m) => ({ default: m.CdpChromePane })),
);

/** Run a palette command + emit a light usage event (kind:"usage") keyed by the
 *  command id — seeds the "what I use" prioritization. No argument values. */
function runCommand(c: Command) {
  reportUsage("command-palette", c.id);
  c.run();
}

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  group?: string;
  icon?: React.ReactNode;
  keywords?: string;
  /** Verb shown on the selected row's ⏎ chip ("open" / "resume" / "attach"). */
  actionLabel?: string;
  run: () => void;
}

/** Subsequence fuzzy match. Returns matched-char indices (into `title`) + a
 *  score, or null on no match. Scoring rewards contiguous runs and matches at
 *  word boundaries / the very start; later matches decay. Higher = better. */
export function fuzzyMatch(query: string, title: string): { score: number; idx: number[] } | null {
  const q = query.toLowerCase();
  const t = title.toLowerCase();
  if (!q) return { score: 0, idx: [] };

  const idx: number[] = [];
  let ti = 0;
  let score = 0;
  let prevMatch = -2;
  let run = 0;

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    idx.push(found);

    let pts = 1;
    if (found === prevMatch + 1) {
      run += 1;
      pts += 4 + run; // contiguous run bonus, escalating
    } else {
      run = 0;
    }
    const before = found > 0 ? t[found - 1] : "";
    const boundary = found === 0 || before === " " || before === "-" || before === "/" || before === ":" || before === "_";
    if (boundary) pts += 6;
    pts -= found * 0.05; // gentle decay for matches deep in the string

    score += pts;
    prevMatch = found;
    ti = found + 1;
  }

  // shorter titles that match are tighter — small length bonus
  score += Math.max(0, 8 - title.length * 0.05);
  return { score, idx };
}

/** Best score across title + subtitle + keywords, but only title indices are
 *  highlighted (we never highlight the muted subtitle). */
function scoreCommand(query: string, c: Command): { score: number; idx: number[] } | null {
  if (!query) return { score: 0, idx: [] };
  const onTitle = fuzzyMatch(query, c.title);
  const haystacks: (string | undefined)[] = [c.subtitle, c.keywords];
  let best = onTitle ? onTitle.score : -Infinity;
  for (const h of haystacks) {
    if (!h) continue;
    const m = fuzzyMatch(query, h);
    if (m && m.score - 5 > best) best = m.score - 5; // off-title matches rank slightly lower
  }
  if (best === -Infinity) return null;
  return { score: best, idx: onTitle ? onTitle.idx : [] };
}

/** Render a title with matched chars wrapped in accent spans. Emits one span
 *  per contiguous RUN (matched vs plain) rather than per character, so a 40-char
 *  title makes ~3 nodes instead of 40 — keeps the list cheap to repaint. Memoized
 *  so unchanged rows don't re-render while typing. */
export const Highlight = memo(function Highlight({ text, idx }: { text: string; idx: number[] }) {
  if (!idx.length) return <>{text}</>;
  const set = new Set(idx);
  const out: React.ReactNode[] = [];
  let i = 0;
  let part = 0;
  while (i < text.length) {
    const on = set.has(i);
    let j = i + 1;
    while (j < text.length && set.has(j) === on) j++;
    const seg = text.slice(i, j);
    out.push(
      on ? (
        <span key={part} className="font-medium text-[var(--color-accent)]">
          {seg}
        </span>
      ) : (
        <span key={part}>{seg}</span>
      ),
    );
    i = j;
    part++;
  }
  return <>{out}</>;
});

interface Scored extends Command {
  _idx: number[];
  _score: number;
}

export function CommandPalette({
  open,
  onClose,
  commands,
  onAsk,
  onDeepSearch,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  onAsk?: (query: string) => void;
  onDeepSearch?: (query: string) => void;
}) {
  const [query, setQuery] = useState("");
  // Defer the value the scorer reads so keystrokes paint instantly and the
  // (heavier) re-rank/re-render runs at lower priority — React's built-in debounce.
  const deferredQuery = useDeferredValue(query);
  const [sel, setSel] = useState(0);
  // CDP real-Chrome spike overlay (dev-only entry below spawns it).
  const [cdpPaneOpen, setCdpPaneOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // dev-only spike launcher — the only palette-reachable way to open the CDP
  // pane until App.tsx wires a real pane kind (later coordinated wave).
  const devCommands = useMemo<Command[]>(
    () =>
      import.meta.env.DEV
        ? [
            {
              id: "dev.cdp-chrome",
              title: "dev: real chrome (cdp spike)",
              subtitle: "supervised chrome tab via devtools protocol",
              group: "dev",
              icon: <Globe size={14} />,
              keywords: "cdp chrome devtools screencast netflix spike browser real",
              actionLabel: "open",
              run: () => setCdpPaneOpen(true),
            },
          ]
        : [],
    [],
  );

  // reset query + selection every time it opens; focus the input.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      // focus after paint so the autofocus lands reliably
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // flat, ranked, group-ordered list. Stable order when query is empty.
  const results = useMemo<Scored[]>(() => {
    const q = deferredQuery.trim();
    const intentCommands: Command[] = q.length >= 2
      ? [
          ...(onAsk
            ? [{
                id: `ai.ask.${q}`,
                title: `ask aios: ${q}`,
                subtitle: "open chatpane with this as the prompt",
                group: "ai",
                icon: <MessageSquare size={14} />,
                keywords: `ask ai chatpane answer prompt ${q}`,
                actionLabel: "ask",
                run: () => onAsk(q),
              }]
            : []),
          ...(onDeepSearch
            ? [{
                id: `ai.search.${q}`,
                title: `deep search: ${q}`,
                subtitle: "use chatpane intelligence to inspect memory, panes, and files",
                group: "ai",
                icon: <Brain size={14} />,
                keywords: `search find memory files panes chat history intelligence ${q}`,
                actionLabel: "search",
                run: () => onDeepSearch(q),
              }]
            : []),
        ]
      : [];
    const scored: Scored[] = [];
    for (const c of [...intentCommands, ...commands, ...devCommands]) {
      const m = scoreCommand(deferredQuery, c);
      if (m) scored.push({ ...c, _idx: m.idx, _score: m.score });
    }
    if (deferredQuery) {
      scored.sort((a, b) => b._score - a._score);
    }
    // group while preserving (sorted) order — first-seen group wins position.
    const order: string[] = [];
    const byGroup = new Map<string, Scored[]>();
    for (const s of scored) {
      const g = s.group ?? "";
      if (!byGroup.has(g)) {
        byGroup.set(g, []);
        order.push(g);
      }
      byGroup.get(g)!.push(s);
    }
    const flat: Scored[] = [];
    for (const g of order) flat.push(...byGroup.get(g)!);
    return flat.slice(0, MAX_RESULTS);
  }, [commands, devCommands, onAsk, onDeepSearch, deferredQuery]);

  // clamp selection when results shrink
  useEffect(() => {
    setSel((s) => (results.length ? Math.min(s, results.length - 1) : 0));
  }, [results.length]);

  // keep the selected row in view
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel, open]);

  // The spike overlay outlives the palette modal (the palette closes the moment
  // the command runs), so it renders regardless of `open`.
  const cdpOverlay = cdpPaneOpen ? (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[var(--color-bg)]">
      <Suspense
        fallback={
          <div className="grid h-full place-items-center text-[11px] text-[var(--color-faint)]">
            loading cdp spike…
          </div>
        }
      >
        <CdpChromePane onClose={() => setCdpPaneOpen(false)} />
      </Suspense>
    </div>
  ) : null;

  if (!open) return cdpOverlay;

  const move = (delta: number) => {
    if (!results.length) return;
    setSel((s) => (s + delta + results.length) % results.length);
  };

  const runSel = () => {
    const c = results[sel];
    if (!c) return;
    onClose();
    runCommand(c);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Tab":
        e.preventDefault();
        move(e.shiftKey ? -1 : 1);
        break;
      case "Enter":
        e.preventDefault();
        runSel();
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  // index → row position so hover/selection align across group headers
  let rowPos = -1;
  let lastGroup: string | null = null;
  const selCmd = results[sel];
  const selAction = selCmd?.actionLabel ?? "select";

  return (
    <>
    {cdpOverlay}
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-in glass absolute top-[14vh] flex max-h-[64vh] w-[600px] flex-col overflow-hidden rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-panel)]/95 shadow-2xl ring-1 ring-black/20"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* search row */}
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3.5">
          <Search size={17} className="shrink-0 text-[var(--color-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="launch, ask, or resume anything…"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-transparent text-[15px] text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
          />
          {results.length > 0 && (
            <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">{results.length}</span>
          )}
        </div>

        {/* results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-2">
          {results.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 px-4 py-12 text-center">
              <img src="/mascot.png" alt="" className="h-10 w-10 rounded-full object-cover opacity-40" />
              <div className="text-[12.5px] text-[var(--color-muted)]">nothing matches “{query}”</div>
            </div>
          ) : (
            results.map((c) => {
              rowPos += 1;
              const pos = rowPos;
              const g = c.group ?? "";
              const showHeader = g && g !== lastGroup;
              lastGroup = g;
              const active = pos === sel;
              return (
                <div key={c.id}>
                  {showHeader && (
                    <div className="px-4 pb-1 pt-2.5 text-[10px] font-medium lowercase tracking-[0.14em] text-[var(--color-faint)]">
                      {g}
                    </div>
                  )}
                  <div className="px-2">
                    <button
                      data-row={pos}
                      onMouseMove={() => setSel(pos)}
                      onClick={() => {
                        onClose();
                        runCommand(c);
                      }}
                      className={`relative flex w-full items-center gap-3 rounded-[var(--aios-radius-md)] px-2.5 py-2 text-left transition-colors ${
                        active ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel-2)]/50"
                      }`}
                    >
                      {c.icon && (
                        <span
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--aios-radius-sm)] border transition-colors ${
                            active
                              ? "border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                              : "border-[var(--color-border)] bg-[var(--color-panel-2)]/50 text-[var(--color-muted)]"
                          }`}
                        >
                          {c.icon}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--color-text)]">
                        <Highlight text={c.title} idx={c._idx} />
                      </span>
                      {c.subtitle && (
                        <span className="shrink-0 truncate font-mono text-[10.5px] text-[var(--color-faint)]">
                          {c.subtitle}
                        </span>
                      )}
                      {active && (
                        <span className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
                          {c.actionLabel ?? "select"} <CornerDownLeft size={10} />
                        </span>
                      )}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* footer hint */}
        <div className="flex items-center gap-3.5 border-t border-[var(--color-border)] px-4 py-2 font-mono text-[10px] text-[var(--color-faint)]">
          <span>↑↓ navigate</span>
          <span className="flex items-center gap-1">
            <CornerDownLeft size={10} /> {selAction}
          </span>
          <span>esc close</span>
        </div>
      </div>
    </div>
    </>
  );
}
