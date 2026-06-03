/** Memory pane — an obsidian-style explorer for Firaz's auto-memory vault,
 *  rendered as a FLASHY 3D force-directed graph via three.js (`3d-force-graph`).
 *
 *  Layout:
 *    toolbar — network icon · "memory vault" · "{count} notes · {links} links" · refresh
 *    body    — LEFT searchable file list grouped by type | CENTER 3D graph | RIGHT markdown reader
 *
 *  The graph gets the dominant space and resizes via a ResizeObserver feeding
 *  `graph.width()/height()`. Nodes glow (emissive + UnrealBloom), are sized by
 *  link-degree and colored by type; links flow animated directional particles.
 *  Clicking a node (graph, list, or [[wikilink]] chip) selects it + flies the
 *  camera toward it. Backed by the Rust `memory_graph` / `memory_file` commands.
 *  Polls every 30s; selection is preserved across refreshes when the node lives. */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import {
  FileText,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Table2,
  Trash2,
  X,
} from "lucide-react";

import {
  memoryFile,
  memoryGraph,
  type MemoryGraph,
  type MemoryNode,
} from "../lib/memory";
import { memoryDelete, memorySave } from "../lib/db";

const Graph3D = lazy(() => import("./MemoryGraph3D").then((m) => ({ default: m.Graph3D })));

// ── type → brand color map ───────────────────────────────────────────────
const TYPE_COLOR: Record<string, string> = {
  user: "var(--color-accent)",
  feedback: "var(--color-warning)",
  project: "var(--color-info)",
  reference: "var(--color-success)",
};
export const typeColor = (t: string) => TYPE_COLOR[t] ?? "var(--color-muted)";

export const TYPE_ORDER = ["user", "feedback", "project", "reference"];


// ════════════════════════════════════════════════════════════════════════
// MemoryView — the memory vault rendered as a database: a sortable table of
// notes (primary), a toggle to the flashy 3D graph, and an inline editor for
// create / update / delete straight to the markdown files.
// ════════════════════════════════════════════════════════════════════════

type SortKey = "title" | "type" | "links";
type ViewMode = "table" | "graph";

interface Draft {
  oldName?: string;
  name: string;
  type: string;
  description: string;
  body: string;
}

export function MemoryView({ onOpenUrl }: { onOpenUrl?: (url: string) => void } = {}) {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>("table");
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [contentErr, setContentErr] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "title", dir: 1 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const g = await memoryGraph();
      setGraph(g);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 30_000);
    return () => clearInterval(t);
  }, [load]);

  // selected file body (reader mode).
  useEffect(() => {
    if (!selected || !graph) {
      setContent("");
      return;
    }
    const node = graph.nodes.find((n) => n.id === selected);
    if (!node) return;
    setContentErr(null);
    memoryFile(node.path)
      .then(setContent)
      .catch((e) => setContentErr(e instanceof Error ? e.message : String(e)));
  }, [selected, graph]);

  const nodesById = useMemo(() => {
    const m = new Map<string, MemoryNode>();
    graph?.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [graph]);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    graph?.nodes.forEach((n) => d.set(n.id, 0));
    graph?.edges.forEach((e) => {
      d.set(e.source, (d.get(e.source) ?? 0) + 1);
      d.set(e.target, (d.get(e.target) ?? 0) + 1);
    });
    return d;
  }, [graph]);

  // filtered + sorted rows for the table.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (graph?.nodes ?? []).filter(
      (n) =>
        !q ||
        n.id.toLowerCase().includes(q) ||
        n.title.toLowerCase().includes(q) ||
        n.description.toLowerCase().includes(q),
    );
    const dir = sort.dir;
    return [...list].sort((a, b) => {
      if (sort.key === "links") {
        return ((degree.get(a.id) ?? 0) - (degree.get(b.id) ?? 0)) * dir;
      }
      const av = sort.key === "type" ? a.type : a.title;
      const bv = sort.key === "type" ? b.type : b.title;
      return av.toLowerCase().localeCompare(bv.toLowerCase()) * dir;
    });
  }, [graph, query, sort, degree]);

  const selNode = selected ? nodesById.get(selected) ?? null : null;

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));

  const startNew = () => setDraft({ name: "", type: "reference", description: "", body: "" });

  const startEdit = useCallback(async () => {
    if (!selNode) return;
    try {
      const raw = await memoryFile(selNode.path);
      setDraft({
        oldName: selNode.id,
        name: selNode.id,
        type: selNode.type,
        description: selNode.description,
        body: stripFrontmatter(raw).trim(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selNode]);

  const saveDraft = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      setError("name must be a slug: letters, digits, - or _ only");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await memorySave({
        name,
        nodeType: draft.type,
        description: draft.description,
        body: draft.body,
        oldName: draft.oldName && draft.oldName !== name ? draft.oldName : undefined,
      });
      setDraft(null);
      await load(true);
      setSelected(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const delNote = async (name: string) => {
    if (!confirm(`delete memory “${name}”? this removes the markdown file.`)) return;
    setBusy(true);
    try {
      await memoryDelete(name);
      if (selected === name) setSelected(null);
      setDraft(null);
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-bg)] text-[13px] text-[var(--color-text)]">
      {/* toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2.5 text-[var(--color-muted)]">
        <Network size={13} className="text-[var(--color-accent)]" />
        <span className="font-mono text-[11px] lowercase">memory vault</span>
        {graph && (
          <span className="text-[11px] text-[var(--color-faint)]">
            {graph.count} notes · {graph.edges.length} links
          </span>
        )}
        {/* search */}
        <div className="ml-2 flex min-w-0 max-w-[260px] flex-1 items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-0.5">
          <Search size={11} className="text-[var(--color-faint)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search…"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-[var(--color-faint)] hover:text-[var(--color-text)]">
              <X size={11} />
            </button>
          )}
        </div>
        {/* view toggle */}
        <div className="ml-auto flex items-center rounded border border-[var(--color-border)] p-0.5 text-[11px]">
          <button
            onClick={() => setView("table")}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${view === "table" ? "bg-[var(--color-accent-soft)] text-[var(--color-text)]" : "hover:text-[var(--color-text)]"}`}
          >
            <Table2 size={11} /> table
          </button>
          <button
            onClick={() => setView("graph")}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${view === "graph" ? "bg-[var(--color-accent-soft)] text-[var(--color-text)]" : "hover:text-[var(--color-text)]"}`}
          >
            <Network size={11} /> graph
          </button>
        </div>
        <button
          onClick={startNew}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="new memory"
        >
          <Plus size={12} /> new
        </button>
        <button
          onClick={() => load()}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && <p className="px-3 py-1.5 text-[12px] text-[var(--color-danger)]">{error}</p>}

      {/* body */}
      <div className="flex min-h-0 flex-1">
        {/* main: table or graph */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {view === "table" ? (
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead className="sticky top-0 z-10 bg-[var(--color-panel)] text-[var(--color-muted)]">
                  <tr className="border-b border-[var(--color-border)]">
                    <Th label="name" active={sort.key === "title"} dir={sort.dir} onClick={() => toggleSort("title")} />
                    <Th label="type" active={sort.key === "type"} dir={sort.dir} onClick={() => toggleSort("type")} />
                    <th className="px-3 py-1.5 text-left font-medium">description</th>
                    <Th label="links" active={sort.key === "links"} dir={sort.dir} onClick={() => toggleSort("links")} className="w-16 text-right" />
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((n) => (
                    <tr
                      key={n.id}
                      onClick={() => setSelected(n.id)}
                      className={`group cursor-pointer border-b border-[var(--color-border)]/40 ${
                        selected === n.id ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel-2)]"
                      }`}
                    >
                      <td className="max-w-[280px] truncate px-3 py-1.5 text-[var(--color-text)]">{n.title}</td>
                      <td className="px-3 py-1.5">
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px]"
                          style={{ color: typeColor(n.type), background: `color-mix(in srgb, ${typeColor(n.type)} 14%, transparent)` }}
                        >
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: typeColor(n.type) }} />
                          {n.type}
                        </span>
                      </td>
                      <td className="max-w-[420px] truncate px-3 py-1.5 text-[var(--color-text-2)]">{n.description}</td>
                      <td className="px-3 py-1.5 text-right text-[var(--color-faint)]">{degree.get(n.id) ?? 0}</td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            delNote(n.id);
                          }}
                          className="text-[var(--color-faint)] opacity-0 transition-opacity hover:text-[var(--color-danger)] group-hover:opacity-100"
                          title="delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {graph && rows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-3 text-center text-[12px] text-[var(--color-muted)]/60">
                        {query ? "no matches" : loading ? "loading vault…" : "vault is empty"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : graph && graph.count > 0 ? (
            <div className="relative min-h-0 flex-1 bg-[var(--color-pane)]">
              <Suspense fallback={<GraphLoading />}>
                <Graph3D graph={graph} degree={degree} selected={selected} onSelect={(id) => setSelected(id || null)} />
              </Suspense>
              <div className="glass pointer-events-none absolute bottom-2 left-2 flex flex-col gap-0.5 rounded px-2 py-1.5 text-[10px]">
                {TYPE_ORDER.map((t) => (
                  <div key={t} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: typeColor(t), boxShadow: `0 0 6px ${typeColor(t)}` }} />
                    <span className="text-[var(--color-text-2)]">{t}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center text-[12px] text-[var(--color-muted)]/50">nothing to graph yet</div>
          )}
        </div>

        {/* right: editor or reader */}
        {(draft || selNode) && (
          <div className="flex w-[380px] shrink-0 min-h-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)]">
            {draft ? (
              <MemoryEditor
                draft={draft}
                busy={busy}
                onChange={setDraft}
                onSave={saveDraft}
                onCancel={() => setDraft(null)}
                onDelete={draft.oldName ? () => delNote(draft.oldName!) : undefined}
              />
            ) : selNode ? (
              <>
                <div className="flex shrink-0 items-start gap-2 border-b border-[var(--color-border)] px-3 py-2">
                  <FileText size={13} className="mt-0.5 shrink-0" style={{ color: typeColor(selNode.type) }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{selNode.title}</div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-faint)]">{selNode.id}</p>
                  </div>
                  <button onClick={startEdit} className="shrink-0 text-[var(--color-faint)] hover:text-[var(--color-text)]" title="edit">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => setSelected(null)} className="shrink-0 text-[var(--color-faint)] hover:text-[var(--color-text)]" title="close">
                    <X size={13} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12px] leading-relaxed text-[var(--color-text-2)]">
                  {contentErr ? (
                    <p className="text-[var(--color-danger)]">{contentErr}</p>
                  ) : (
                    <Markdown text={content} nodesById={nodesById} onLink={(id) => setSelected(id)} onOpenUrl={onOpenUrl} />
                  )}
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** Sortable table header cell. */
function Th({
  label,
  active,
  dir,
  onClick,
  className = "",
}: {
  label: string;
  active: boolean;
  dir: 1 | -1;
  onClick: () => void;
  className?: string;
}) {
  return (
    <th className={`px-3 py-1.5 text-left font-medium ${className}`}>
      <button onClick={onClick} className="inline-flex items-center gap-1 hover:text-[var(--color-text)]">
        {label}
        {active && <span className="text-[9px]">{dir === 1 ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}

/** Inline create/edit form writing straight to the vault. */
function MemoryEditor({
  draft,
  busy,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: {
  draft: Draft;
  busy: boolean;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <span className="text-[12px] font-medium">{draft.oldName ? "edit memory" : "new memory"}</span>
        <button onClick={onCancel} className="text-[var(--color-faint)] hover:text-[var(--color-text)]">
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-[12px]">
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-faint)]">name (slug)</span>
          <input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="feedback-wa-must-go-through-push"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-pane)] px-2 py-1 font-mono text-[11px] focus:border-[var(--color-accent)]/60 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-faint)]">type</span>
          <select
            value={draft.type}
            onChange={(e) => set({ type: e.target.value })}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-pane)] px-2 py-1 text-[11px] focus:border-[var(--color-accent)]/60 focus:outline-none"
          >
            {TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-faint)]">description</span>
          <input
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="one-line summary used for recall"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-pane)] px-2 py-1 text-[11px] focus:border-[var(--color-accent)]/60 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-faint)]">body (markdown)</span>
          <textarea
            value={draft.body}
            onChange={(e) => set({ body: e.target.value })}
            rows={12}
            placeholder="the fact. link related notes with [[their-name]]."
            className="w-full resize-none rounded border border-[var(--color-border)] bg-[var(--color-pane)] px-2 py-1 font-mono text-[11px] leading-relaxed focus:border-[var(--color-accent)]/60 focus:outline-none"
          />
        </label>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-border)] px-3 py-2">
        <button
          onClick={onSave}
          disabled={busy}
          className="flex items-center gap-1 rounded bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
        >
          <Save size={12} /> save
        </button>
        {onDelete && (
          <button
            onClick={onDelete}
            disabled={busy}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2.5 py-1 text-[11px] text-[var(--color-danger)] hover:border-[var(--color-danger)]/50 disabled:opacity-50"
          >
            <Trash2 size={12} /> delete
          </button>
        )}
      </div>
    </>
  );
}

function GraphLoading() {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[var(--color-pane)]">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-faint)]">
        loading graph
      </span>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Lightweight markdown: headings, bold, list items, code, [[wikilink]] chips.
// ════════════════════════════════════════════════════════════════════════
export function Markdown({
  text,
  nodesById,
  onLink,
  onOpenUrl,
}: {
  text: string;
  nodesById: Map<string, MemoryNode>;
  onLink: (id: string) => void;
  /** Open an http(s) link from rendered markdown in an in-app browser pane. */
  onOpenUrl?: (url: string) => void;
}) {
  const body = useMemo(() => stripFrontmatter(text), [text]);
  if (!body.trim()) {
    return <p className="text-[var(--color-muted)]/60">empty note</p>;
  }
  const lines = body.split("\n");

  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        const trimmed = line.trimEnd();
        if (!trimmed.trim()) return <div key={i} className="h-1.5" />;

        const hm = trimmed.match(/^(#{1,4})\s+(.*)$/);
        if (hm) {
          const level = hm[1].length;
          const cls =
            level === 1
              ? "text-[14px] font-semibold text-[var(--color-text)]"
              : level === 2
                ? "text-[13px] font-semibold text-[var(--color-text)]"
                : "text-[12px] font-medium text-[var(--color-text-2)]";
          return (
            <div key={i} className={`mt-2 ${cls}`}>
              {renderInline(hm[2], nodesById, onLink, onOpenUrl)}
            </div>
          );
        }

        const lm = trimmed.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (lm) {
          return (
            <div key={i} className="flex gap-1.5 pl-1.5" style={{ marginLeft: lm[1].length * 4 }}>
              <span className="text-[var(--color-faint)]">•</span>
              <span className="flex-1">{renderInline(lm[3], nodesById, onLink, onOpenUrl)}</span>
            </div>
          );
        }

        return <p key={i}>{renderInline(trimmed, nodesById, onLink, onOpenUrl)}</p>;
      })}
    </div>
  );
}

/** Removes a leading `---\n…\n---` frontmatter fence for display. */
function stripFrontmatter(text: string): string {
  const t = text.replace(/^﻿/, "");
  if (t.startsWith("---")) {
    const end = t.indexOf("\n---", 3);
    if (end !== -1) {
      return t.slice(end + 4).replace(/^\n+/, "");
    }
  }
  return t;
}

/** Renders inline markup: **bold**, `code`, [[wikilink]] chips, and [text](url) links. */
function renderInline(
  text: string,
  nodesById: Map<string, MemoryNode>,
  onLink: (id: string) => void,
  onOpenUrl?: (url: string) => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\[\[[^\]]+\]\])|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("[[")) {
      const raw = token.slice(2, -2);
      const target = raw.split("|")[0].split("#")[0].trim();
      const label = raw.includes("|") ? raw.split("|")[1].trim() : target;
      const known = nodesById.has(target);
      out.push(
        <button
          key={key++}
          disabled={!known}
          onClick={() => known && onLink(target)}
          title={target}
          className={`mx-0.5 inline-block rounded px-1 py-px font-mono text-[10px] ${
            known
              ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25"
              : "bg-[var(--color-panel-2)] text-[var(--color-faint)]"
          }`}
        >
          {label}
        </button>,
      );
    } else if (token.startsWith("[")) {
      const close = token.indexOf("]");
      const label = token.slice(1, close);
      const url = token.slice(close + 2, -1);
      const http = /^https?:\/\//i.test(url);
      out.push(
        <a
          key={key++}
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            if (http && onOpenUrl) {
              e.preventDefault();
              onOpenUrl(url);
            }
          }}
          className="text-[var(--color-accent)] underline decoration-[var(--color-accent)]/40 underline-offset-2 hover:decoration-[var(--color-accent)]"
        >
          {label}
        </a>,
      );
    } else if (token.startsWith("**")) {
      out.push(
        <strong key={key++} className="font-semibold text-[var(--color-text)]">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      out.push(
        <code
          key={key++}
          className="rounded bg-[var(--color-panel-2)] px-1 font-mono text-[11px] text-[var(--color-text-2)]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
