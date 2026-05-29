/** ⌘K command palette — VS Code / Raycast style fuzzy launcher.
 *  Self-contained: own fuzzy matcher (subsequence + contiguity/word-boundary
 *  scoring), keyboard nav, grouped results, match highlighting. No deps beyond
 *  React + lucide-react. App.tsx owns the `open` state + global ⌘K listener and
 *  passes a `commands` array — see the usage snippet in the PR notes. */
import { useEffect, useMemo, useRef, useState } from "react";

import { CornerDownLeft, Search } from "lucide-react";

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  group?: string;
  icon?: React.ReactNode;
  keywords?: string;
  run: () => void;
}

/** Subsequence fuzzy match. Returns matched-char indices (into `title`) + a
 *  score, or null on no match. Scoring rewards contiguous runs and matches at
 *  word boundaries / the very start; later matches decay. Higher = better. */
function fuzzyMatch(query: string, title: string): { score: number; idx: number[] } | null {
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

/** Render a title with matched chars wrapped in accent spans. */
function Highlight({ text, idx }: { text: string; idx: number[] }) {
  if (!idx.length) return <>{text}</>;
  const set = new Set(idx);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      out.push(
        <span key={i} className="font-medium text-[var(--color-accent)]">
          {text[i]}
        </span>,
      );
    } else {
      out.push(<span key={i}>{text[i]}</span>);
    }
  }
  return <>{out}</>;
}

interface Scored extends Command {
  _idx: number[];
  _score: number;
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
    const scored: Scored[] = [];
    for (const c of commands) {
      const m = scoreCommand(query, c);
      if (m) scored.push({ ...c, _idx: m.idx, _score: m.score });
    }
    if (query) {
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
    return flat;
  }, [commands, query]);

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

  if (!open) return null;

  const move = (delta: number) => {
    if (!results.length) return;
    setSel((s) => (s + delta + results.length) % results.length);
  };

  const runSel = () => {
    const c = results[sel];
    if (!c) return;
    onClose();
    c.run();
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

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-in glass absolute top-[120px] flex max-h-[60vh] w-[560px] flex-col overflow-hidden rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-panel)]/90 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* search row */}
        <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-3.5 py-3">
          <Search size={15} className="shrink-0 text-[var(--color-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="type a command…"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-transparent text-[14px] text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
          />
        </div>

        {/* results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1.5">
          {results.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <img src="/mascot.png" alt="" className="h-9 w-9 rounded-full object-cover opacity-50" />
              <div className="text-[12px] text-[var(--color-muted)]">no commands match</div>
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
                    <div className="px-3.5 pb-1 pt-2 text-[10px] font-medium lowercase tracking-wider text-[var(--color-faint)]">
                      {g}
                    </div>
                  )}
                  <button
                    data-row={pos}
                    onMouseMove={() => setSel(pos)}
                    onClick={() => {
                      onClose();
                      c.run();
                    }}
                    className={`relative flex w-full items-center gap-3 px-3.5 py-2 text-left ${
                      active ? "bg-[var(--color-accent-soft)]" : ""
                    }`}
                  >
                    {active && (
                      <span className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-[var(--color-accent)]" />
                    )}
                    {c.icon && (
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center ${
                          active ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"
                        }`}
                      >
                        {c.icon}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text)]">
                      <Highlight text={c.title} idx={c._idx} />
                    </span>
                    {c.subtitle && (
                      <span className="shrink-0 truncate text-[11px] text-[var(--color-muted)]">
                        {c.subtitle}
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* footer hint */}
        <div className="flex items-center gap-3 border-t border-[var(--color-border)] px-3.5 py-2 font-mono text-[10px] text-[var(--color-faint)]">
          <span className="flex items-center gap-1">↑↓ navigate</span>
          <span className="flex items-center gap-1">
            <CornerDownLeft size={10} /> select
          </span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
