/** ⌘P fuzzy file finder — the VS Code "Go to File" replacement (firaz's #1 pain:
 *  "find files is hard, still need vscode"). Reuses CommandPalette's modal shell
 *  + its fuzzyMatch scorer. On open it pulls the flat file list ONCE per root via
 *  `find_files` (honors .gitignore, prunes node_modules) and caches it. Scoring
 *  weights the basename 2× over the full relative path so `app.tsx` ranks
 *  `src/App.tsx` above `src/lib/appCommands.ts`. Empty query → recent files (MRU).
 *  Enter opens `${root}/${rel}` through the normal open path. */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, FileText, History, Search } from "lucide-react";

import { fuzzyMatch, Highlight } from "./CommandPalette";
import { findFiles } from "../lib/fs";

const MAX_RESULTS = 50;

function basename(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(i + 1) : rel;
}

interface Scored {
  rel: string;
  score: number;
  idx: number[]; // indices into the basename, for highlight
}

export function FileFinder({
  open,
  root,
  mru,
  onClose,
  onPick,
}: {
  open: boolean;
  /** Search root; the cached file list is keyed by this. */
  root: string;
  /** Recent-files list (absolute paths) shown when the query is empty. */
  mru: string[];
  onClose: () => void;
  /** Open the chosen ABSOLUTE path. */
  onPick: (absPath: string) => void;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // cache the flat file list per root so re-opening is instant.
  const cacheRef = useRef<Map<string, string[]>>(new Map());

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSel(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    if (!root) {
      setFiles([]);
      return;
    }
    const cached = cacheRef.current.get(root);
    if (cached) {
      setFiles(cached);
      return;
    }
    let alive = true;
    setLoading(true);
    findFiles(root, 20000)
      .then((list) => {
        if (!alive) return;
        cacheRef.current.set(root, list);
        setFiles(list);
      })
      .catch(() => alive && setFiles([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, root]);

  // MRU rows when the query is empty: relative-ize paths under root for display,
  // but keep them only if they actually live under root (so we can open them).
  const recentRels = useMemo(() => {
    if (!root) return [];
    const prefix = root.endsWith("/") ? root : `${root}/`;
    const out: string[] = [];
    for (const abs of mru) {
      if (abs.startsWith(prefix)) out.push(abs.slice(prefix.length));
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  }, [mru, root]);

  const results = useMemo<Scored[]>(() => {
    const q = deferredQuery.trim();
    if (!q) {
      // empty → recent files (no score, preserve MRU order).
      return recentRels.map((rel) => ({ rel, score: 0, idx: [] }));
    }
    const scored: Scored[] = [];
    for (const rel of files) {
      const base = basename(rel);
      const onBase = fuzzyMatch(q, base);
      const onPath = fuzzyMatch(q, rel);
      if (!onBase && !onPath) continue;
      // basename weighted 2× so a basename hit dominates a deep-path hit.
      const score = Math.max(
        onBase ? onBase.score * 2 : -Infinity,
        onPath ? onPath.score : -Infinity,
      );
      scored.push({ rel, score, idx: onBase ? onBase.idx : [] });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS);
  }, [deferredQuery, files, recentRels]);

  useEffect(() => {
    setSel((s) => (results.length ? Math.min(s, results.length - 1) : 0));
  }, [results.length]);

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

  const pickAbs = (rel: string) => {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    onClose();
    onPick(`${prefix}${rel}`);
  };

  const runSel = () => {
    const c = results[sel];
    if (c) pickAbs(c.rel);
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

  const showingRecent = !deferredQuery.trim();

  return (
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
            placeholder={root ? "go to file…" : "open a files pane first"}
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-transparent text-[15px] text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
          />
          {loading ? (
            <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">indexing…</span>
          ) : (
            results.length > 0 && (
              <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">{results.length}</span>
            )
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-2">
          {showingRecent && results.length > 0 && (
            <div className="px-4 pb-1 pt-1 text-[10px] font-medium lowercase tracking-[0.14em] text-[var(--color-faint)]">
              recent
            </div>
          )}
          {results.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 px-4 py-12 text-center">
              <img src="/mascot.png" alt="" className="h-10 w-10 rounded-full object-cover opacity-40" />
              <div className="text-[12.5px] text-[var(--color-muted)]">
                {root ? (loading ? "indexing files…" : `nothing matches “${query}”`) : "no files pane open"}
              </div>
            </div>
          ) : (
            results.map((c, pos) => {
              const active = pos === sel;
              const base = basename(c.rel);
              const dir = c.rel.length > base.length ? c.rel.slice(0, c.rel.length - base.length - 1) : "";
              return (
                <div key={c.rel} className="px-2">
                  <button
                    data-row={pos}
                    onMouseMove={() => setSel(pos)}
                    onClick={() => pickAbs(c.rel)}
                    className={`relative flex w-full items-center gap-3 rounded-[var(--aios-radius-md)] px-2.5 py-2 text-left transition-colors ${
                      active ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel-2)]/50"
                    }`}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--aios-radius-sm)] border transition-colors ${
                        active
                          ? "border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                          : "border-[var(--color-border)] bg-[var(--color-panel-2)]/50 text-[var(--color-muted)]"
                      }`}
                    >
                      {showingRecent ? <History size={14} /> : <FileText size={14} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--color-text)]">
                      <Highlight text={base} idx={c.idx} />
                    </span>
                    {dir && (
                      <span className="shrink-0 truncate font-mono text-[10.5px] text-[var(--color-faint)]" title={c.rel}>
                        {dir}
                      </span>
                    )}
                    {active && (
                      <span className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
                        open <CornerDownLeft size={10} />
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3.5 border-t border-[var(--color-border)] px-4 py-2 font-mono text-[10px] text-[var(--color-faint)]">
          <span>↑↓ navigate</span>
          <span className="flex items-center gap-1">
            <CornerDownLeft size={10} /> open
          </span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
