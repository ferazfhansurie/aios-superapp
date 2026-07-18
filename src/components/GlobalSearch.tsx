/** ⌘⇧F global content search — VS Code "Search in Files" replacement. Debounced
 *  `search_in_files` (literal, case-insensitive; ripgrep w/ Rust fallback; honors
 *  .gitignore + prunes node_modules). Flat hits are grouped by file client-side
 *  and rendered ripgrep-style: a file header (relative path + match count) then
 *  each hit as `line:col  trimmed-text` with the matched substring highlighted.
 *  Click a hit → open the file AND jump to that line (open-at-line). */
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Loader2, Search } from "lucide-react";

import { searchInFiles, type SearchHit } from "../lib/fs";

const DEBOUNCE_MS = 180;

interface FileGroup {
  path: string;
  hits: SearchHit[];
}

/** A flattened, navigable row: either a file header or a hit under it. */
type Row =
  | { kind: "file"; path: string; count: number }
  | { kind: "hit"; path: string; hit: SearchHit };

/** Highlight every case-insensitive occurrence of `query` (literal) inside the
 *  trimmed match text. We match on the text itself rather than trusting the
 *  backend `col` (which indexes the UNtrimmed line). */
function HitText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let part = 0;
  while (i < text.length) {
    const found = lower.indexOf(q, i);
    if (found === -1) {
      out.push(<span key={part++}>{text.slice(i)}</span>);
      break;
    }
    if (found > i) out.push(<span key={part++}>{text.slice(i, found)}</span>);
    out.push(
      <span key={part++} className="rounded-sm bg-[var(--color-accent)]/20 font-medium text-[var(--color-accent)]">
        {text.slice(found, found + q.length)}
      </span>,
    );
    i = found + q.length;
  }
  return <>{out}</>;
}

export function GlobalSearch({
  open,
  root,
  onClose,
  onPick,
}: {
  open: boolean;
  root: string;
  onClose: () => void;
  /** Open the ABSOLUTE path and jump to (line, col) — both 1-based. */
  onPick: (absPath: string, line: number, col: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    setSearched("");
    setSel(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // debounced search
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q || !root) {
      setHits([]);
      setLoading(false);
      setSearched(q);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      searchInFiles(root, q, 1000)
        .then((res) => {
          if (!alive) return;
          setHits(res);
          setSearched(q);
        })
        .catch(() => alive && setHits([]))
        .finally(() => alive && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, root, open]);

  // group flat hits by file (preserve first-seen order = backend traversal order)
  const groups = useMemo<FileGroup[]>(() => {
    const order: string[] = [];
    const byPath = new Map<string, SearchHit[]>();
    for (const h of hits) {
      if (!byPath.has(h.path)) {
        byPath.set(h.path, []);
        order.push(h.path);
      }
      byPath.get(h.path)!.push(h);
    }
    return order.map((p) => ({ path: p, hits: byPath.get(p)! }));
  }, [hits]);

  // flatten into navigable rows (file header + its hits)
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of groups) {
      out.push({ kind: "file", path: g.path, count: g.hits.length });
      for (const h of g.hits) out.push({ kind: "hit", path: g.path, hit: h });
    }
    return out;
  }, [groups]);

  // selectable rows = hits only (file headers aren't a jump target)
  const hitRowIdx = useMemo(() => rows.map((r, i) => (r.kind === "hit" ? i : -1)).filter((i) => i >= 0), [rows]);

  useEffect(() => {
    setSel((s) => (hitRowIdx.length ? Math.min(s, hitRowIdx.length - 1) : 0));
  }, [hitRowIdx.length]);

  useEffect(() => {
    if (!open) return;
    const rowIdx = hitRowIdx[sel];
    if (rowIdx == null) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row="${rowIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel, open, hitRowIdx]);

  if (!open) return null;

  const prefix = root.endsWith("/") ? root : `${root}/`;
  const pick = (path: string, hit: SearchHit) => {
    onClose();
    onPick(`${prefix}${path}`, hit.line, hit.col);
  };

  const move = (delta: number) => {
    if (!hitRowIdx.length) return;
    setSel((s) => (s + delta + hitRowIdx.length) % hitRowIdx.length);
  };

  const runSel = () => {
    const rowIdx = hitRowIdx[sel];
    const row = rowIdx != null ? rows[rowIdx] : null;
    if (row && row.kind === "hit") pick(row.path, row.hit);
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

  const selRowIdx = hitRowIdx[sel];

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-in glass absolute top-[10vh] flex max-h-[74vh] w-[680px] flex-col overflow-hidden rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-panel)]/95 shadow-2xl ring-1 ring-black/20"
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
            placeholder={root ? "search in files…" : "open a files pane first"}
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-transparent text-[15px] text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
          />
          {loading ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-[var(--color-faint)]" />
          ) : (
            hits.length > 0 && (
              <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">
                {hits.length} in {groups.length}
              </span>
            )
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1.5">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 px-4 py-12 text-center">
              <img src="/mascot.png" alt="" className="h-10 w-10 rounded-full object-cover opacity-40" />
              <div className="text-[12.5px] text-[var(--color-muted)]">
                {!root
                  ? "no files pane open"
                  : !query.trim()
                    ? "type to search file contents"
                    : loading
                      ? "searching…"
                      : searched
                        ? `no matches for “${searched}”`
                        : "searching…"}
              </div>
            </div>
          ) : (
            rows.map((row, rowIdx) =>
              row.kind === "file" ? (
                <div
                  key={`f:${row.path}`}
                  className="flex items-center gap-2 px-4 pb-0.5 pt-2 font-mono text-[11px] text-[var(--color-text-2)]"
                  title={`${prefix}${row.path}`}
                >
                  <span className="truncate">{row.path}</span>
                  <span className="shrink-0 text-[10px] text-[var(--color-faint)]">{row.count}</span>
                </div>
              ) : (
                <div key={`h:${row.path}:${row.hit.line}:${row.hit.col}`} className="px-2">
                  <button
                    data-row={rowIdx}
                    onMouseMove={() => {
                      const i = hitRowIdx.indexOf(rowIdx);
                      if (i >= 0) setSel(i);
                    }}
                    onClick={() => pick(row.path, row.hit)}
                    className={`flex w-full items-baseline gap-3 rounded-[var(--aios-radius-md)] px-2.5 py-1 text-left transition-colors ${
                      rowIdx === selRowIdx ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel-2)]/50"
                    }`}
                  >
                    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--color-faint)]">
                      {row.hit.line}:{row.hit.col}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--color-text)]">
                      <HitText text={row.hit.text} query={searched} />
                    </span>
                  </button>
                </div>
              ),
            )
          )}
        </div>

        <div className="flex items-center gap-3.5 border-t border-[var(--color-border)] px-4 py-2 font-mono text-[10px] text-[var(--color-faint)]">
          <span>↑↓ navigate</span>
          <span className="flex items-center gap-1">
            <CornerDownLeft size={10} /> open at line
          </span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
