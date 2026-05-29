/** Memory pane — an obsidian-style explorer for Firaz's auto-memory vault.
 *  Left: searchable file list grouped by type. Center: a live force-directed
 *  graph on <canvas> (self-contained sim, no external lib). Right: the selected
 *  note rendered as lightweight markdown with clickable [[wikilink]] chips.
 *  Backed by the Rust `memory_graph` / `memory_file` commands. Polls every 30s
 *  so newly-written memories surface without a manual refresh. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FileText, Network, RefreshCw, Search, Tag } from "lucide-react";

import {
  memoryFile,
  memoryGraph,
  type MemoryGraph,
  type MemoryNode,
} from "../lib/memory";

// ── type → brand color map ───────────────────────────────────────────────
const TYPE_COLOR: Record<string, string> = {
  user: "var(--color-accent)",
  feedback: "var(--color-warning)",
  project: "var(--color-info)",
  reference: "var(--color-success)",
};
const typeColor = (t: string) => TYPE_COLOR[t] ?? "var(--color-muted)";

// resolved hex for canvas (canvas can't read CSS vars on a detached ctx).
const TYPE_HEX: Record<string, string> = {
  user: "#f26522",
  feedback: "#facc15",
  project: "#60a5fa",
  reference: "#4ade80",
};
const typeHex = (t: string) => TYPE_HEX[t] ?? "#7a7a82";

const TYPE_ORDER = ["user", "feedback", "project", "reference"];

// ── force-sim node (canvas-local physics state) ──────────────────────────
interface SimNode {
  id: string;
  type: string;
  title: string;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function MemoryPane() {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [contentErr, setContentErr] = useState<string | null>(null);

  // ── data load + poll ────────────────────────────────────────────────────
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

  // ── load selected file body ──────────────────────────────────────────────
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

  // node degree (in + out) for sizing.
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    graph?.nodes.forEach((n) => d.set(n.id, 0));
    graph?.edges.forEach((e) => {
      d.set(e.source, (d.get(e.source) ?? 0) + 1);
      d.set(e.target, (d.get(e.target) ?? 0) + 1);
    });
    return d;
  }, [graph]);

  // ── grouped + filtered file list ─────────────────────────────────────────
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups: Record<string, MemoryNode[]> = {};
    (graph?.nodes ?? [])
      .filter(
        (n) =>
          !q ||
          n.id.toLowerCase().includes(q) ||
          n.title.toLowerCase().includes(q) ||
          n.description.toLowerCase().includes(q),
      )
      .forEach((n) => {
        (groups[n.type] ??= []).push(n);
      });
    const order = [...TYPE_ORDER, ...Object.keys(groups).filter((k) => !TYPE_ORDER.includes(k))];
    return order.filter((t) => groups[t]?.length).map((t) => [t, groups[t]] as const);
  }, [graph, query]);

  const selNode = selected ? nodesById.get(selected) ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-col text-[13px] text-[var(--color-text)]">
      {/* header */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2.5 text-[var(--color-muted)]">
        <Network size={13} className="text-[var(--color-accent)]" />
        <span className="font-mono text-[11px] lowercase">memory vault</span>
        {graph && (
          <span className="text-[11px] text-[var(--color-faint)]">
            {graph.count} notes · {graph.edges.length} links
          </span>
        )}
        <button
          onClick={() => load()}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          refresh
        </button>
      </div>

      {error && (
        <p className="px-3 py-2 text-[12px] text-[var(--color-danger)]">{error}</p>
      )}
      {loading && !graph && (
        <p className="px-3 py-2 text-[12px] text-[var(--color-muted)]/70">loading vault…</p>
      )}
      {!loading && graph && graph.count === 0 && (
        <p className="px-3 py-2 text-[12px] text-[var(--color-muted)]/70">vault is empty</p>
      )}

      {/* body: list | graph | reader */}
      <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr_minmax(220px,300px)]">
        {/* (a) left list */}
        <div className="flex min-h-0 flex-col border-r border-[var(--color-border)]">
          <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-2">
            <Search size={12} className="text-[var(--color-faint)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search…"
              className="w-full bg-transparent text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {grouped.map(([type, list]) => (
              <div key={type} className="mb-1">
                <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
                  <Tag size={9} style={{ color: typeColor(type) }} />
                  <span style={{ color: typeColor(type) }}>{type}</span>
                  <span className="text-[var(--color-faint)]/60">{list.length}</span>
                </div>
                {list.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => setSelected(n.id)}
                    title={n.description || n.id}
                    className={`flex w-full items-center gap-1.5 truncate px-2 py-1 text-left text-[12px] transition-colors hover:bg-[var(--color-panel-2)] ${
                      selected === n.id
                        ? "bg-[var(--color-accent-soft)] text-[var(--color-text)]"
                        : "text-[var(--color-text-2)]"
                    }`}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: typeColor(n.type) }}
                    />
                    <span className="truncate">{n.title}</span>
                  </button>
                ))}
              </div>
            ))}
            {graph && grouped.length === 0 && (
              <p className="px-2 py-2 text-[11px] text-[var(--color-muted)]/60">no matches</p>
            )}
          </div>
        </div>

        {/* (b) center graph */}
        <div className="min-h-0 bg-[var(--color-pane)]">
          {graph && graph.count > 0 ? (
            <ForceGraph
              graph={graph}
              degree={degree}
              selected={selected}
              onSelect={setSelected}
            />
          ) : null}
        </div>

        {/* (c) right reader */}
        <div className="flex min-h-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)]">
          {selNode ? (
            <>
              <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <FileText size={12} style={{ color: typeColor(selNode.type) }} />
                  <span className="truncate text-[13px] font-medium">{selNode.title}</span>
                </div>
                <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-faint)]">
                  {selNode.id}
                </p>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12px] leading-relaxed text-[var(--color-text-2)]">
                {contentErr ? (
                  <p className="text-[var(--color-danger)]">{contentErr}</p>
                ) : (
                  <Markdown
                    text={content}
                    nodesById={nodesById}
                    onLink={(id) => setSelected(id)}
                  />
                )}
              </div>
            </>
          ) : (
            <p className="px-3 py-3 text-[12px] text-[var(--color-muted)]/60">
              select a note to read it
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Force-directed graph on <canvas>. Self-contained physics: repulsion between
// every node pair, spring along each edge, weak centering pull. Runs via
// requestAnimationFrame and parks itself once kinetic energy settles.
// ════════════════════════════════════════════════════════════════════════
function ForceGraph({
  graph,
  degree,
  selected,
  onSelect,
}: {
  graph: MemoryGraph;
  degree: Map<string, number>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // mutable sim state lives in refs so RAF doesn't churn React.
  const simRef = useRef<SimNode[]>([]);
  const viewRef = useRef({ scale: 1, ox: 0, oy: 0 });
  const hoverRef = useRef<string | null>(null);
  const selRef = useRef<string | null>(selected);
  const dragRef = useRef<{ id: string | null; panning: boolean; lx: number; ly: number }>({
    id: null,
    panning: false,
    lx: 0,
    ly: 0,
  });
  const rafRef = useRef<number>(0);
  const sizeRef = useRef({ w: 0, h: 0 });
  // exposed by the RAF effect so other effects can request a repaint frame.
  const kickRef = useRef<() => void>(() => {});

  // adjacency for neighborhood highlight.
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    graph.nodes.forEach((n) => m.set(n.id, new Set()));
    graph.edges.forEach((e) => {
      m.get(e.source)?.add(e.target);
      m.get(e.target)?.add(e.source);
    });
    return m;
  }, [graph]);

  useEffect(() => {
    selRef.current = selected;
  }, [selected]);

  // (re)seed sim whenever the node set changes.
  useEffect(() => {
    const w = sizeRef.current.w || 600;
    const h = sizeRef.current.h || 400;
    const prev = new Map(simRef.current.map((s) => [s.id, s]));
    simRef.current = graph.nodes.map((n, i) => {
      const old = prev.get(n.id);
      const angle = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2;
      const r = Math.min(w, h) * 0.3;
      return {
        id: n.id,
        type: n.type,
        title: n.title,
        degree: degree.get(n.id) ?? 0,
        x: old?.x ?? w / 2 + Math.cos(angle) * r + (Math.random() - 0.5) * 40,
        y: old?.y ?? h / 2 + Math.sin(angle) * r + (Math.random() - 0.5) * 40,
        vx: 0,
        vy: 0,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, degree]);

  // main RAF loop: integrate physics + draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const radiusOf = (d: number) => 4 + Math.min(10, d * 1.6);

    const step = () => {
      const nodes = simRef.current;
      const { w, h } = sizeRef.current;
      const cx = w / 2;
      const cy = h / 2;

      // physics
      const dragId = dragRef.current.id;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        // repulsion
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dist2 = dx * dx + dy * dy;
          if (dist2 < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            dist2 = 0.01;
          }
          const dist = Math.sqrt(dist2);
          const force = 1400 / dist2;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
        // centering
        a.vx += (cx - a.x) * 0.0025;
        a.vy += (cy - a.y) * 0.0025;
      }
      // springs
      for (const e of graph.edges) {
        const s = nodes.find((n) => n.id === e.source);
        const t = nodes.find((n) => n.id === e.target);
        if (!s || !t) continue;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const target = 70;
        const k = 0.02;
        const f = (dist - target) * k;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        s.vx += fx;
        s.vy += fy;
        t.vx -= fx;
        t.vy -= fy;
      }
      // integrate + damping
      let energy = 0;
      for (const n of nodes) {
        if (n.id === dragId) {
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx *= 0.85;
        n.vy *= 0.85;
        // clamp velocity so the sim never explodes
        n.vx = Math.max(-30, Math.min(30, n.vx));
        n.vy = Math.max(-30, Math.min(30, n.vy));
        n.x += n.vx;
        n.y += n.vy;
        energy += n.vx * n.vx + n.vy * n.vy;
      }

      draw(ctx);

      // park the sim once it settles (unless dragging).
      const settled = energy < 0.05 && !dragId;
      if (settled) {
        rafRef.current = 0;
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };

    const draw = (c: CanvasRenderingContext2D) => {
      const { w, h } = sizeRef.current;
      const { scale, ox, oy } = viewRef.current;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      c.save();
      c.translate(ox, oy);
      c.scale(scale, scale);

      const nodes = simRef.current;
      const hover = hoverRef.current;
      const sel = selRef.current;
      const focus = hover ?? sel;
      const neighbors = focus ? adj.get(focus) : null;
      const dim = !!focus;

      // edges
      for (const e of graph.edges) {
        const s = nodes.find((n) => n.id === e.source);
        const t = nodes.find((n) => n.id === e.target);
        if (!s || !t) continue;
        const active = focus && (e.source === focus || e.target === focus);
        c.beginPath();
        c.moveTo(s.x, s.y);
        c.lineTo(t.x, t.y);
        c.strokeStyle = active ? "#f26522" : dim ? "rgba(120,120,130,0.10)" : "rgba(120,120,130,0.22)";
        c.lineWidth = active ? 1.4 : 0.7;
        c.stroke();
      }

      // nodes
      for (const n of nodes) {
        const r = radiusOf(n.degree);
        const isFocus = n.id === focus;
        const isNeighbor = neighbors?.has(n.id);
        const faded = dim && !isFocus && !isNeighbor;
        c.beginPath();
        c.arc(n.x, n.y, r, 0, Math.PI * 2);
        c.fillStyle = typeHex(n.type);
        c.globalAlpha = faded ? 0.25 : 1;
        c.fill();
        if (n.id === sel) {
          c.lineWidth = 2;
          c.strokeStyle = "#ffffff";
          c.stroke();
        } else if (isFocus) {
          c.lineWidth = 1.5;
          c.strokeStyle = "rgba(255,255,255,0.7)";
          c.stroke();
        }
        // label — only for focus/neighbors or hub nodes, to keep it legible.
        if (!faded && (isFocus || isNeighbor || n.degree >= 3 || scale > 1.4)) {
          c.globalAlpha = faded ? 0.3 : isFocus || isNeighbor ? 1 : 0.6;
          c.fillStyle = "#c9c9d0";
          c.font = "10px ui-sans-serif, system-ui, sans-serif";
          c.fillText(n.title.length > 22 ? n.title.slice(0, 21) + "…" : n.title, n.x + r + 3, n.y + 3);
        }
        c.globalAlpha = 1;
      }
      c.restore();
    };

    // kick the loop
    const kick = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(step);
    };
    kickRef.current = kick;
    kick();

    // ── interaction ─────────────────────────────────────────────────────
    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const { scale, ox, oy } = viewRef.current;
      return {
        x: (clientX - rect.left - ox) / scale,
        y: (clientY - rect.top - oy) / scale,
      };
    };
    const hitTest = (clientX: number, clientY: number): SimNode | null => {
      const { x, y } = toWorld(clientX, clientY);
      let best: SimNode | null = null;
      let bestD = Infinity;
      for (const n of simRef.current) {
        const r = radiusOf(n.degree) + 4;
        const dx = n.x - x;
        const dy = n.y - y;
        const d = dx * dx + dy * dy;
        if (d <= r * r && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };

    const onDown = (ev: MouseEvent) => {
      const hit = hitTest(ev.clientX, ev.clientY);
      if (hit) {
        dragRef.current = { id: hit.id, panning: false, lx: ev.clientX, ly: ev.clientY };
      } else {
        dragRef.current = { id: null, panning: true, lx: ev.clientX, ly: ev.clientY };
      }
    };
    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (drag.id) {
        const { x, y } = toWorld(ev.clientX, ev.clientY);
        const n = simRef.current.find((s) => s.id === drag.id);
        if (n) {
          n.x = x;
          n.y = y;
          n.vx = 0;
          n.vy = 0;
        }
        kick();
        return;
      }
      if (drag.panning) {
        const dx = ev.clientX - drag.lx;
        const dy = ev.clientY - drag.ly;
        viewRef.current.ox += dx;
        viewRef.current.oy += dy;
        drag.lx = ev.clientX;
        drag.ly = ev.clientY;
        kick();
        return;
      }
      // hover
      const hit = hitTest(ev.clientX, ev.clientY);
      const id = hit?.id ?? null;
      if (id !== hoverRef.current) {
        hoverRef.current = id;
        canvas.style.cursor = id ? "pointer" : "grab";
        kick();
      }
    };
    const onUp = (ev: MouseEvent) => {
      const drag = dragRef.current;
      // treat as a click (select) when there was no meaningful drag.
      if (drag.id && Math.abs(ev.clientX - drag.lx) < 4 && Math.abs(ev.clientY - drag.ly) < 4) {
        onSelect(drag.id);
      }
      dragRef.current = { id: null, panning: false, lx: 0, ly: 0 };
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const v = viewRef.current;
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newScale = Math.max(0.3, Math.min(4, v.scale * factor));
      // zoom toward cursor
      v.ox = mx - (mx - v.ox) * (newScale / v.scale);
      v.oy = my - (my - v.oy) * (newScale / v.scale);
      v.scale = newScale;
      kick();
    };

    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.style.cursor = "grab";

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      ro.disconnect();
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, adj, onSelect]);

  // re-kick the loop when selection changes so the highlight repaints once
  // (the loop parks itself again immediately if the sim is already settled).
  useEffect(() => {
    kickRef.current();
  }, [selected]);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full" />
      {/* legend */}
      <div className="glass absolute bottom-2 left-2 flex flex-col gap-0.5 rounded px-2 py-1.5 text-[10px]">
        {TYPE_ORDER.map((t) => (
          <div key={t} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: typeColor(t) }} />
            <span className="text-[var(--color-text-2)]">{t}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Lightweight markdown: headings, bold, list items, and [[wikilink]] chips.
// Intentionally minimal — enough to read a memory note, not a full renderer.
// ════════════════════════════════════════════════════════════════════════
function Markdown({
  text,
  nodesById,
  onLink,
}: {
  text: string;
  nodesById: Map<string, MemoryNode>;
  onLink: (id: string) => void;
}) {
  // strip leading YAML frontmatter block from the rendered body.
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

        // headings
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
              {renderInline(hm[2], nodesById, onLink)}
            </div>
          );
        }

        // list items (-, *, or "1.")
        const lm = trimmed.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (lm) {
          return (
            <div key={i} className="flex gap-1.5 pl-1.5" style={{ marginLeft: lm[1].length * 4 }}>
              <span className="text-[var(--color-faint)]">•</span>
              <span className="flex-1">{renderInline(lm[3], nodesById, onLink)}</span>
            </div>
          );
        }

        return <p key={i}>{renderInline(trimmed, nodesById, onLink)}</p>;
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

/** Renders inline markup: **bold**, `code`, and [[wikilink]] chips. */
function renderInline(
  text: string,
  nodesById: Map<string, MemoryNode>,
  onLink: (id: string) => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // split on wikilinks, bold, and inline code in one pass via a combined regex.
  const re = /(\[\[[^\]]+\]\])|(\*\*[^*]+\*\*)|(`[^`]+`)/g;
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
