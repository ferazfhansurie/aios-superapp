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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
import { FileText, Network, RefreshCw, Search, X } from "lucide-react";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

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

// resolved hex (three.js can't read CSS vars).
const TYPE_HEX: Record<string, string> = {
  user: "#f26522",
  feedback: "#facc15",
  project: "#60a5fa",
  reference: "#4ade80",
};
const typeHex = (t: string) => TYPE_HEX[t] ?? "#7a7a82";

const TYPE_ORDER = ["user", "feedback", "project", "reference"];

// shape fed to 3d-force-graph.
interface GNode {
  id: string;
  title: string;
  type: string;
  description: string;
  path: string;
  degree: number;
  // mutated by the sim — present after first tick.
  x?: number;
  y?: number;
  z?: number;
}
interface GLink {
  source: string;
  target: string;
}

export function MemoryPane() {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [contentErr, setContentErr] = useState<string | null>(null);

  // ── data load + poll (preserve selection if node survives) ───────────────
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const g = await memoryGraph();
      setGraph(g);
      setError(null);
      setSelected((prev) =>
        prev && g.nodes.some((n) => n.id === prev) ? prev : prev && !quiet ? null : prev,
      );
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
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-bg)] text-[13px] text-[var(--color-text)]">
      {/* toolbar */}
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

      {error && <p className="px-3 py-2 text-[12px] text-[var(--color-danger)]">{error}</p>}
      {loading && !graph && (
        <p className="px-3 py-2 text-[12px] text-[var(--color-muted)]/70">loading vault…</p>
      )}
      {!loading && graph && graph.count === 0 && (
        <p className="px-3 py-2 text-[12px] text-[var(--color-muted)]/70">vault is empty</p>
      )}

      {/* body: list | graph | reader */}
      <div className="flex min-h-0 flex-1">
        {/* (a) left list */}
        <div className="flex w-[260px] shrink-0 min-h-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
          <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-2">
            <Search size={12} className="text-[var(--color-faint)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search…"
              className="w-full bg-transparent text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="text-[var(--color-faint)] hover:text-[var(--color-text)]"
                title="clear"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {grouped.map(([type, list]) => (
              <div key={type} className="mb-1">
                <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium uppercase tracking-wide">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: typeColor(type), boxShadow: `0 0 6px ${typeColor(type)}` }}
                  />
                  <span style={{ color: typeColor(type) }}>{type}</span>
                  <span className="text-[var(--color-faint)]">{list.length}</span>
                </div>
                {list.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => setSelected(n.id)}
                    title={n.description || n.id}
                    className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] transition-colors hover:bg-[var(--color-panel-2)] ${
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

        {/* (b) center 3D graph — dominant space */}
        <div className="relative min-h-0 min-w-0 flex-1 bg-[var(--color-pane)]">
          {graph && graph.count > 0 ? (
            <Graph3D
              graph={graph}
              degree={degree}
              selected={selected}
              onSelect={(id) => setSelected(id || null)}
            />
          ) : (
            !loading && (
              <div className="flex h-full items-center justify-center text-[12px] text-[var(--color-muted)]/50">
                nothing to graph yet
              </div>
            )
          )}
          {/* legend */}
          <div className="glass pointer-events-none absolute bottom-2 left-2 flex flex-col gap-0.5 rounded px-2 py-1.5 text-[10px]">
            {TYPE_ORDER.map((t) => (
              <div key={t} className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: typeColor(t), boxShadow: `0 0 6px ${typeColor(t)}` }}
                />
                <span className="text-[var(--color-text-2)]">{t}</span>
              </div>
            ))}
          </div>
        </div>

        {/* (c) right reader */}
        <div className="flex w-[340px] shrink-0 min-h-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)]">
          {selNode ? (
            <>
              <div className="flex shrink-0 items-start gap-2 border-b border-[var(--color-border)] px-3 py-2">
                <FileText
                  size={13}
                  className="mt-0.5 shrink-0"
                  style={{ color: typeColor(selNode.type) }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{selNode.title}</div>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-faint)]">
                    {selNode.id}
                  </p>
                </div>
                <button
                  onClick={() => setSelected(null)}
                  className="shrink-0 text-[var(--color-faint)] hover:text-[var(--color-text)]"
                  title="close"
                >
                  <X size={13} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12px] leading-relaxed text-[var(--color-text-2)]">
                {contentErr ? (
                  <p className="text-[var(--color-danger)]">{contentErr}</p>
                ) : (
                  <Markdown text={content} nodesById={nodesById} onLink={(id) => setSelected(id)} />
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-[var(--color-muted)]/60">
              select a note to read it
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 3D force-directed graph via `3d-force-graph` (three.js). Instantiated
// imperatively into a ref'd div, fed graph data, and disposed on unmount.
// Flashy bits: emissive glowing spheres + UnrealBloom, animated directional
// particles flowing along links, gentle idle auto-rotation, and a fly-to on
// select.
// ════════════════════════════════════════════════════════════════════════
function Graph3D({
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
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraph3DInstance | null>(null);
  const nodeObjRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const selRef = useRef<string | null>(selected);
  const onSelectRef = useRef(onSelect);
  const idleRef = useRef<{ last: number; angle: number; raf: number }>({
    last: Date.now(),
    angle: 0,
    raf: 0,
  });

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // build graph payload from the live vault graph.
  const data = useMemo(() => {
    const nodes: GNode[] = graph.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      type: n.type,
      description: n.description,
      path: n.path,
      degree: degree.get(n.id) ?? 0,
    }));
    const ids = new Set(nodes.map((n) => n.id));
    const links: GLink[] = graph.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));
    return { nodes, links };
  }, [graph, degree]);

  const radiusOf = (d: number) => 3 + Math.min(7, d * 1.1);

  // ── instantiate once ─────────────────────────────────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const fg: ForceGraph3DInstance = new ForceGraph3D(wrap, {
      controlType: "orbit",
      rendererConfig: { antialias: true, alpha: true },
    });
    fgRef.current = fg;

    fg.backgroundColor("rgba(0,0,0,0)")
      .showNavInfo(false)
      .nodeLabel((n) => `<div style="font:12px ui-sans-serif,system-ui;color:#f3f3f5;
        background:rgba(10,16,24,0.9);border:1px solid rgba(255,255,255,0.12);
        padding:3px 7px;border-radius:5px;white-space:nowrap">${escapeHtml((n as GNode).title)}</div>`)
      .nodeRelSize(1)
      .nodeThreeObject((n) => buildNodeObject(n as GNode, nodeObjRef.current, radiusOf))
      .linkColor(() => "rgba(180,190,210,0.22)")
      .linkWidth(0.6)
      .linkOpacity(0.5)
      .linkDirectionalParticles(2)
      .linkDirectionalParticleWidth(1.6)
      .linkDirectionalParticleSpeed(0.006)
      .linkDirectionalParticleColor(() => "#f26522")
      .d3VelocityDecay(0.28)
      .onNodeClick((n) => {
        const gn = n as GNode;
        onSelectRef.current(gn.id);
        flyTo(fg, gn);
      })
      .onBackgroundClick(() => onSelectRef.current(""));

    // spread the layout a touch so it isn't cramped.
    const charge = fg.d3Force("charge") as { strength?: (n: number) => unknown } | undefined;
    charge?.strength?.(-120);
    const linkF = fg.d3Force("link") as { distance?: (n: number) => unknown } | undefined;
    linkF?.distance?.(48);

    // lighting — warm key + cool fill so the spheres read 3D.
    fg.scene().add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.PointLight(0xffd9b3, 1.2, 0, 0);
    key.position.set(200, 200, 200);
    fg.scene().add(key);
    const fill = new THREE.PointLight(0x6ea8ff, 0.7, 0, 0);
    fill.position.set(-200, -120, -160);
    fg.scene().add(fill);

    // bloom — the flashy glow.
    try {
      const composer = fg.postProcessingComposer();
      const size = fg.renderer().getSize(new THREE.Vector2());
      const bloom = new UnrealBloomPass(size, 1.1, 0.65, 0.18);
      composer.addPass(bloom);
    } catch {
      // postprocessing not available — emissive materials still glow softly.
    }

    // size to container.
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      fg.width(Math.max(1, r.width)).height(Math.max(1, r.height));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    // gentle idle auto-rotation — pauses while the user interacts.
    const idle = idleRef.current;
    const DIST = 320;
    idle.angle = Math.PI * 0.25;
    const markActive = () => {
      idle.last = Date.now();
    };
    wrap.addEventListener("pointerdown", markActive);
    wrap.addEventListener("wheel", markActive, { passive: true });
    const spin = () => {
      idle.raf = requestAnimationFrame(spin);
      if (Date.now() - idle.last < 2500) return; // recently interacted → leave camera be
      idle.angle += 0.0016;
      const cam = fg.camera() as THREE.PerspectiveCamera;
      const y = cam.position.y;
      fg.cameraPosition({
        x: DIST * Math.sin(idle.angle),
        y,
        z: DIST * Math.cos(idle.angle),
      });
    };
    // start spinning only after the initial layout settles a bit.
    const startSpin = setTimeout(() => {
      idle.last = Date.now() - 3000;
      idle.raf = requestAnimationFrame(spin);
    }, 1800);

    // initial framing.
    fg.cameraPosition({ x: 0, y: 0, z: DIST });

    return () => {
      clearTimeout(startSpin);
      if (idle.raf) cancelAnimationFrame(idle.raf);
      ro.disconnect();
      wrap.removeEventListener("pointerdown", markActive);
      wrap.removeEventListener("wheel", markActive);
      try {
        fg._destructor();
      } catch {
        /* noop */
      }
      nodeObjRef.current.clear();
      fgRef.current = null;
    };
    // instantiate once; data + selection handled by dedicated effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── feed / refresh data ──────────────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    nodeObjRef.current.clear();
    fg.graphData(data);
  }, [data]);

  // ── reflect selection: highlight + fly-to ────────────────────────────────
  useEffect(() => {
    selRef.current = selected;
    const fg = fgRef.current;
    if (!fg) return;
    // restyle every node so the selected one pops and others dim.
    nodeObjRef.current.forEach((mesh, id) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const isSel = id === selected;
      const anySel = !!selected;
      mat.emissiveIntensity = isSel ? 2.4 : anySel ? 0.5 : 1.0;
      mat.opacity = anySel && !isSel ? 0.45 : 1;
      mesh.scale.setScalar(isSel ? 1.55 : 1);
    });
    if (selected) {
      const node = (fg.graphData().nodes as GNode[]).find((n) => n.id === selected);
      if (node) flyTo(fg, node);
    }
  }, [selected]);

  return <div ref={wrapRef} className="absolute inset-0 h-full w-full" />;
}

/** Build (or reuse) a glowing emissive sphere for a node. */
function buildNodeObject(
  n: GNode,
  store: Map<string, THREE.Mesh>,
  radiusOf: (d: number) => number,
): THREE.Object3D {
  const r = radiusOf(n.degree);
  const color = new THREE.Color(typeHex(n.type));
  const geo = new THREE.SphereGeometry(r, 20, 20);
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 1.0,
    roughness: 0.35,
    metalness: 0.1,
    transparent: true,
    opacity: 1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  store.set(n.id, mesh);
  return mesh;
}

/** Fly the orbit camera toward a node, keeping a comfortable standoff. */
function flyTo(fg: ForceGraph3DInstance, n: GNode) {
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  const z = n.z ?? 0;
  const dist = 90;
  const len = Math.hypot(x, y, z) || 1;
  const ratio = 1 + dist / len;
  fg.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, 900);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

// ════════════════════════════════════════════════════════════════════════
// Lightweight markdown: headings, bold, list items, code, [[wikilink]] chips.
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
              {renderInline(hm[2], nodesById, onLink)}
            </div>
          );
        }

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
