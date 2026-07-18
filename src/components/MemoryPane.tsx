import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  Brain,
  CircleDot,
  Filter,
  GitBranch,
  Link2,
  Maximize2,
  Minimize2,
  Network,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";

import {
  memoryDeletePath,
  memoryFile,
  memoryGraph,
  memorySave,
  memorySaveRaw,
  memorySearch,
  type MemoryGraph,
  type MemoryHit,
  type MemoryNode,
} from "../lib/memory";
import { reportDiag } from "../lib/diag";
import { useVisible } from "../lib/useVisible";
import { useSharedInterval } from "../lib/ticker";

type GraphFilter = "all" | "project" | "user" | "feedback" | "reference" | "orphaned";
type ViewMode = "web" | "editor";

const GRAPH_FILTERS: Array<{ id: GraphFilter; label: string }> = [
  { id: "all", label: "all" },
  { id: "project", label: "projects" },
  { id: "user", label: "people" },
  { id: "feedback", label: "feedback" },
  { id: "reference", label: "refs" },
  { id: "orphaned", label: "orphaned" },
];

const CLUSTER_CENTERS: Record<string, { x: number; y: number }> = {
  project: { x: 38, y: 38 },
  user: { x: 28, y: 66 },
  feedback: { x: 66, y: 38 },
  reference: { x: 66, y: 68 },
};

function relTime(unixSec?: number): string {
  if (!unixSec) return "";
  const diff = Date.now() - unixSec * 1000;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  }).toLowerCase();
}

function slugStamp(): string {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
  ].join("_");
  return `memory_${stamp}`;
}

function shortLabel(text: string, max = 20): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function nodeTitle(node: MemoryNode | null, hit: MemoryHit | null, draft: string): string {
  if (node?.title) return node.title;
  if (hit?.title) return hit.title;
  const named = draft.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  if (named) return named.replace(/^["']|["']$/g, "");
  return "memory";
}

function contextText(node: MemoryNode | null, hit: MemoryHit | null, body: string): string {
  const title = node?.title ?? hit?.title ?? "memory";
  const type = node?.type ?? hit?.type ?? "reference";
  const vault = node?.vault ?? hit?.vault ?? "memory";
  const path = node?.path ?? hit?.path ?? "";
  const reasons = hit?.reasons.length ? `\nreasons: ${hit.reasons.join("; ")}` : "";
  return `memory: ${title} [${type}] from ${vault}${reasons}\npath: ${path}\n\n${body.trim()}`;
}

function clusterColor(cluster: string): string {
  switch (cluster) {
    case "project":
      return "var(--color-accent)";
    case "user":
      return "var(--color-success)";
    case "feedback":
      return "var(--color-warning)";
    case "reference":
      return "var(--color-text-2)";
    default:
      return "var(--color-muted)";
  }
}

function nodeMatches(node: MemoryNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [node.id, node.title, node.description, node.type, node.vault ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

function filterNode(node: MemoryNode, filter: GraphFilter, query: string): boolean {
  if (!nodeMatches(node, query)) return false;
  if (filter === "all") return true;
  if (filter === "orphaned") return node.orphan;
  return node.cluster === filter || node.type === filter;
}

function nodeDegree(node: Pick<MemoryNode, "degree" | "links" | "backlinks"> | null | undefined): number {
  if (!node) return 0;
  return Math.max(node.degree ?? 0, node.links?.length ?? 0, node.backlinks?.length ?? 0);
}

function edgeStyle(
  source: { x: number; y: number },
  target: { x: number; y: number },
  strong: boolean,
): CSSProperties {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  return {
    left: `${source.x}%`,
    top: `${source.y}%`,
    width: `${Math.hypot(dx, dy)}%`,
    transform: `rotate(${Math.atan2(dy, dx)}rad)`,
    background: strong ? "var(--color-accent)" : "color-mix(in srgb, var(--color-text) 32%, transparent)",
    height: strong ? 2 : 1.25,
    opacity: strong ? 0.92 : 0.64,
  };
}

function MemoryGraphView({
  graph,
  graphFilter,
  graphOnly,
  query,
  selectedPath,
  onSelect,
  onFilterChange,
  onGraphOnlyChange,
}: {
  graph: MemoryGraph | null;
  graphFilter: GraphFilter;
  graphOnly: boolean;
  query: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onFilterChange: (filter: GraphFilter) => void;
  onGraphOnlyChange: (graphOnly: boolean) => void;
}) {
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number; camX: number; camY: number } | null>(null);
  const layout = useMemo(() => {
    const nodes = graph?.nodes ?? [];
    const edges = graph?.edges ?? [];
    const selected = nodes.find((node) => node.path === selectedPath) ?? null;
    const visibleIds = new Set<string>();

    for (const node of nodes) {
      if (filterNode(node, graphFilter, query)) visibleIds.add(node.id);
    }
    if (selected) {
      visibleIds.add(selected.id);
      selected.links.forEach((id) => visibleIds.add(id));
      selected.backlinks.forEach((id) => visibleIds.add(id));
      selected.suggested_links.forEach((id) => visibleIds.add(id));
    }

    const visible = nodes.filter((node) => visibleIds.has(node.id)).slice(0, graphOnly ? 260 : 160);
    const byCluster = new Map<string, MemoryNode[]>();
    visible.forEach((node) => {
      const cluster = node.cluster || "reference";
      byCluster.set(cluster, [...(byCluster.get(cluster) ?? []), node]);
    });

    const positioned = new Map<string, MemoryNode & { x: number; y: number; selected: boolean }>();
    for (const [cluster, clusterNodes] of byCluster.entries()) {
      const center = CLUSTER_CENTERS[cluster] ?? { x: 50, y: 52 };
      clusterNodes
        .sort((a, b) => nodeDegree(b) - nodeDegree(a) || a.title.localeCompare(b.title))
        .forEach((node, i) => {
          const ring = 5 + Math.min(24, Math.floor(i / 8) * 7 + (node.orphan ? 8 : 0));
          const angle = i * 2.399963229728653 + (cluster.length * 0.31);
          positioned.set(node.id, {
            ...node,
            x: Math.max(5, Math.min(95, center.x + Math.cos(angle) * ring)),
            y: Math.max(8, Math.min(92, center.y + Math.sin(angle) * ring)),
            selected: node.path === selectedPath,
          });
        });
    }

    const visibleEdges = edges
      .filter((edge) => positioned.has(edge.source) && positioned.has(edge.target))
      .map((edge) => ({
        ...edge,
        sourceNode: positioned.get(edge.source)!,
        targetNode: positioned.get(edge.target)!,
      }));

    const suggestedEdges = selected
      ? selected.suggested_links
          .filter((id) => positioned.has(selected.id) && positioned.has(id))
          .map((id) => ({
            source: selected.id,
            target: id,
            sourceNode: positioned.get(selected.id)!,
            targetNode: positioned.get(id)!,
          }))
      : [];

    return { nodes: [...positioned.values()], edges: visibleEdges, suggestedEdges };
  }, [graph, graphFilter, graphOnly, query, selectedPath]);

  const resetCamera = useCallback(() => {
    dragRef.current = null;
    setCamera({ x: 0, y: 0, scale: 1 });
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      camX: camera.x,
      camY: camera.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [camera.x, camera.y]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setCamera((current) => ({
      ...current,
      x: drag.camX + e.clientX - drag.x,
      y: drag.camY + e.clientY - drag.y,
    }));
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const onWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.08 : 0.08;
    setCamera((current) => ({
      ...current,
      scale: Math.min(2.6, Math.max(0.62, current.scale + delta)),
    }));
  }, []);

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[var(--color-faint)]">
        <Network size={30} className="opacity-45" />
        <span className="text-[12px]">no memory graph yet</span>
      </div>
    );
  }

  const visibleNodes = layout.nodes;
  const clusterSummaries = Object.entries(CLUSTER_CENTERS)
    .map(([cluster, center]) => ({
      cluster,
      center,
      count: visibleNodes.filter((node) => (node.cluster || "reference") === cluster).length,
    }))
    .filter((item) => item.count > 0);
  const selectedNode = visibleNodes.find((node) => node.path === selectedPath) ?? visibleNodes[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-text)]">
            <Network size={14} className="text-[var(--color-accent)]" />
            <span>neural web</span>
          </div>
          <div className="truncate font-mono text-[10px] text-[var(--color-faint)]">
            {graph.count} notes / {graph.edges.length} links / {visibleNodes.filter((node) => node.orphan).length} orphaned
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {GRAPH_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => onFilterChange(filter.id)}
              className={`rounded-md border px-2 py-1 text-[10px] transition-colors ${
                graphFilter === filter.id
                  ? "border-[var(--color-accent)]/60 bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  : "border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
              }`}
            >
              {filter.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onGraphOnlyChange(!graphOnly)}
            className="ml-1 flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)]"
            title={graphOnly ? "exit graph-only view" : "show graph only"}
          >
            {graphOnly ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
            {graphOnly ? "exit" : "graph only"}
          </button>
          <button
            type="button"
            onClick={resetCamera}
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)]"
            title="reset graph pan and zoom"
          >
            reset
          </button>
          <span className="rounded-md border border-[var(--color-border)] px-2 py-1 font-mono text-[10px] text-[var(--color-faint)]">
            {Math.round(camera.scale * 100)}%
          </span>
        </div>
      </div>
      <div
        className="memory-graph-pan-surface relative min-h-0 flex-1 cursor-grab overflow-hidden bg-[radial-gradient(circle_at_center,color-mix(in_srgb,var(--color-accent)_10%,transparent),transparent_46%)] active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <div
          className="memory-graph-camera absolute inset-0"
          style={{
            transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
            transformOrigin: "center center",
          }}
        >
          <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
            <defs>
              <pattern id="memory-neural-grid" width="5" height="5" patternUnits="userSpaceOnUse">
                <path d="M 5 0 L 0 0 0 5" fill="none" stroke="var(--color-border)" strokeWidth="0.16" opacity="0.55" />
              </pattern>
            </defs>
            <rect width="100" height="100" fill="url(#memory-neural-grid)" opacity="0.72" />
            {clusterSummaries.map(({ cluster, center, count }) => (
              <g key={cluster} className="memory-graph-cluster">
                <circle
                  cx={center.x}
                  cy={center.y}
                  r={count > 18 ? 19 : 14}
                  fill={clusterColor(cluster)}
                  opacity="0.055"
                  stroke={clusterColor(cluster)}
                  strokeWidth="0.32"
                  strokeDasharray="1.1 1.5"
                />
                <text x={center.x} y={center.y - 11} textAnchor="middle" fontSize="2.1" fill={clusterColor(cluster)} opacity="0.72">
                  {cluster}
                </text>
              </g>
            ))}
          </svg>
          <div className="pointer-events-none absolute inset-0 z-10">
            {layout.edges.map((edge) => {
              const hot = edge.sourceNode.selected || edge.targetNode.selected;
              return (
                <div
                  key={`html-edge-${edge.source}-${edge.target}`}
                  className="memory-graph-html-edge absolute origin-left rounded-full"
                  style={edgeStyle(edge.sourceNode, edge.targetNode, hot)}
                />
              );
            })}
            {layout.suggestedEdges.map((edge) => (
              <div
                key={`html-suggested-edge-${edge.source}-${edge.target}`}
                className="memory-graph-html-edge memory-graph-html-edge--suggested absolute origin-left rounded-full"
                style={{
                  ...edgeStyle(edge.sourceNode, edge.targetNode, true),
                  background: "var(--color-warning)",
                  opacity: 0.78,
                }}
              />
            ))}
          </div>
          <div className="absolute inset-0 z-20">
            {visibleNodes.map((node) => {
              const degree = nodeDegree(node);
              const active = node.path === selectedPath;
              const size = active ? 18 : Math.max(8, Math.min(14, 8 + degree * 1.1));
              const showLabel = active || degree >= 2;
              return (
                <button
                  key={`html-${node.id}`}
                  type="button"
                  onClick={() => onSelect(node.path)}
                  title={node.title || node.id}
                  className="memory-graph-node memory-graph-html-node absolute -translate-x-1/2 -translate-y-1/2 rounded-full border transition-transform hover:scale-125 focus:outline-none"
                  style={{
                    left: `${node.x}%`,
                    top: `${node.y}%`,
                    width: size,
                    height: size,
                    background: node.orphan ? "var(--color-muted)" : clusterColor(node.cluster),
                    borderColor: active ? "var(--color-text)" : "rgba(255,255,255,0.58)",
                    boxShadow: active
                      ? "0 0 0 7px color-mix(in srgb, var(--color-accent) 22%, transparent), 0 0 24px color-mix(in srgb, var(--color-accent) 42%, transparent)"
                      : "0 0 14px rgba(0,0,0,0.42)",
                    opacity: node.orphan ? 0.82 : 1,
                  }}
                >
                  {showLabel && (
                    <span
                      className="pointer-events-none absolute left-1/2 top-full mt-1 max-w-28 -translate-x-1/2 truncate rounded border border-[var(--color-border)] bg-[var(--color-bg)]/88 px-1.5 py-0.5 text-[9px] text-[var(--color-text)] shadow-[0_8px_22px_rgba(0,0,0,0.38)]"
                      style={{ minWidth: active ? 72 : 42 }}
                    >
                      {shortLabel(node.title || node.id, active ? 24 : 13)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/95 px-2.5 py-2 shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-faint)]">visible</div>
          <div className="mt-0.5 text-[18px] font-medium leading-none text-[var(--color-text)]">{visibleNodes.length}</div>
        </div>
        {selectedNode && (
          <div className="absolute bottom-3 left-3 right-3 z-20 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/95 px-2.5 py-2 shadow-[0_14px_36px_rgba(0,0,0,0.32)]">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: clusterColor(selectedNode.cluster) }}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11.5px] font-medium text-[var(--color-text)]">{selectedNode.title || selectedNode.id}</div>
              <div className="truncate font-mono text-[9.5px] text-[var(--color-faint)]">
                {selectedNode.cluster} / {nodeDegree(selectedNode)} links / {selectedNode.orphan ? "orphaned" : "connected"}
              </div>
            </div>
            <div className="hidden max-w-[46%] shrink-0 gap-1 lg:flex">
              {[...visibleNodes]
                .sort((a, b) => nodeDegree(b) - nodeDegree(a) || a.title.localeCompare(b.title))
                .slice(0, 5)
                .map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => onSelect(node.path)}
                    className="max-w-28 truncate rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-[10px] text-[var(--color-muted)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)]"
                  >
                    {shortLabel(node.title || node.id, 15)}
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LinkedNodeButton({
  id,
  node,
  onSelect,
  action,
}: {
  id: string;
  node?: MemoryNode;
  onSelect: (path: string) => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-1">
      <button
        type="button"
        disabled={!node}
        onClick={() => node && onSelect(node.path)}
        className="min-w-0 flex-1 truncate text-left text-[10.5px] text-[var(--color-text-2)] enabled:hover:text-[var(--color-accent)] disabled:text-[var(--color-faint)]"
      >
        {node?.title ?? id}
      </button>
      {action}
    </div>
  );
}

function MemoryInspector({
  node,
  hit,
  draft,
  dirty,
  status,
  onDraft,
  onSave,
  onDelete,
  onSend,
  onSelectNode,
  onInsertLink,
  nodeById,
}: {
  node: MemoryNode | null;
  hit: MemoryHit | null;
  draft: string;
  dirty: boolean;
  status: "idle" | "saving" | "saved" | "error";
  onDraft: (value: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onSend?: () => void;
  onSelectNode: (path: string) => void;
  onInsertLink: (id: string) => void;
  nodeById: Map<string, MemoryNode>;
}) {
  if (!node && !hit) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 border-l border-[var(--color-border)] text-[var(--color-faint)]">
        <Brain size={28} className="opacity-45" />
        <span className="text-[12px]">no memory selected</span>
      </div>
    );
  }

  const title = nodeTitle(node, hit, draft);
  const links = node?.links ?? [];
  const backlinks = node?.backlinks ?? [];
  const suggested_links = node?.suggested_links ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-2">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-[var(--color-text)]">{title}</div>
            <div className="truncate font-mono text-[10px] text-[var(--color-faint)]">{node?.path ?? hit?.path}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onSend && (
              <button
                type="button"
                onClick={onSend}
                title="send memory to active chat"
                className="grid h-7 w-7 place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)]"
              >
                <Send size={13} />
              </button>
            )}
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty && status !== "error"}
              title="save memory"
              className="grid h-7 w-7 place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)] disabled:cursor-default disabled:opacity-40"
            >
              <Save size={13} />
            </button>
            <button
              type="button"
              onClick={onDelete}
              title="delete memory"
              className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-danger)]"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-muted)]">
          <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[var(--color-text-2)]">
            {node?.cluster ?? hit?.type ?? "reference"}
          </span>
          <span>{node?.vault ?? hit?.vault ?? "memory"}</span>
          <span>{relTime(node?.mtime ?? hit?.mtime)}</span>
          <span>{nodeDegree(node ?? { degree: 0, links, backlinks })} links</span>
          {node?.orphan && <span className="text-[var(--color-warning)]">orphaned</span>}
          <span className="text-[var(--color-faint)]">
            {status === "saving" ? "saving..." : status === "saved" ? "saved" : status === "error" ? "error" : dirty ? "edited" : ""}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-3 gap-px border-b border-[var(--color-border)] bg-[var(--color-border)] text-center">
          <div className="bg-[var(--color-panel)] px-2 py-2">
            <div className="font-mono text-[13px] text-[var(--color-text)]">{links.length}</div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--color-faint)]">out</div>
          </div>
          <div className="bg-[var(--color-panel)] px-2 py-2">
            <div className="font-mono text-[13px] text-[var(--color-text)]">{backlinks.length}</div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--color-faint)]">back</div>
          </div>
          <div className="bg-[var(--color-panel)] px-2 py-2">
            <div className="font-mono text-[13px] text-[var(--color-text)]">{suggested_links.length}</div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--color-faint)]">suggest</div>
          </div>
        </div>

        <section className="border-b border-[var(--color-border)] p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[var(--color-faint)]">
            <Link2 size={11} />
            linked to
          </div>
          <div className="flex flex-col gap-1.5">
            {links.length === 0 ? (
              <span className="text-[11px] text-[var(--color-faint)]">none</span>
            ) : (
              links.map((id) => (
                <LinkedNodeButton key={id} id={id} node={nodeById.get(id)} onSelect={onSelectNode} />
              ))
            )}
          </div>
        </section>

        <section className="border-b border-[var(--color-border)] p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[var(--color-faint)]">
            <CircleDot size={11} />
            backlinks
          </div>
          <div className="flex flex-col gap-1.5">
            {backlinks.length === 0 ? (
              <span className="text-[11px] text-[var(--color-faint)]">none</span>
            ) : (
              backlinks.map((id) => (
                <LinkedNodeButton key={id} id={id} node={nodeById.get(id)} onSelect={onSelectNode} />
              ))
            )}
          </div>
        </section>

        <section className="border-b border-[var(--color-border)] p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[var(--color-faint)]">
            <Sparkles size={11} />
            suggested links
          </div>
          <div className="flex flex-col gap-1.5">
            {suggested_links.length === 0 ? (
              <span className="text-[11px] text-[var(--color-faint)]">none</span>
            ) : (
              suggested_links.map((id) => (
                <LinkedNodeButton
                  key={id}
                  id={id}
                  node={nodeById.get(id)}
                  onSelect={onSelectNode}
                  action={
                    <button
                      type="button"
                      title="insert wikilink"
                      onClick={() => onInsertLink(id)}
                      className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[9px] text-[var(--color-warning)] hover:border-[var(--color-warning)]/60"
                    >
                      link
                    </button>
                  }
                />
              ))
            )}
          </div>
        </section>

        {hit && hit.reasons.length > 0 && (
          <section className="border-b border-[var(--color-border)] p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[var(--color-faint)]">
              <Filter size={11} />
              match reasons
            </div>
            <div className="flex flex-wrap gap-1">
              {hit.reasons.slice(0, 6).map((reason) => (
                <span key={reason} className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted)]">
                  {reason}
                </span>
              ))}
            </div>
          </section>
        )}

        <textarea
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          spellCheck={false}
          className="min-h-[320px] w-full resize-y bg-transparent px-4 py-3 font-mono text-[12.5px] leading-relaxed text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
          placeholder="select or create a memory"
        />
      </div>
    </div>
  );
}

export function MemoryPane({ onSend }: { onSend?: (text: string) => void }) {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("web");
  const [graphFilter, setGraphFilter] = useState<GraphFilter>("all");
  const [graphOnly, setGraphOnly] = useState(false);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const selectedRef = useRef<string | null>(null);
  const draftRef = useRef("");
  selectedRef.current = selectedPath;
  draftRef.current = draft;

  // Gate the background reload to when the pane is on screen. The poll does disk
  // I/O (memoryGraph + memorySearch) + string matching on the main thread; with
  // the pane hidden (display:none, still mounted) it was running forever.
  const { ref: rootRef, visible } = useVisible<HTMLDivElement>();

  const nodeById = useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.id, node])),
    [graph],
  );
  const selectedNode = useMemo(
    () => (graph?.nodes ?? []).find((node) => node.path === selectedPath) ?? null,
    [graph, selectedPath],
  );
  const selectedHit = useMemo(
    () => hits.find((hit) => hit.path === selectedPath) ?? null,
    [hits, selectedPath],
  );

  const load = useCallback(async (nextQuery = query) => {
    setLoading(true);
    try {
      const [g, list] = await Promise.all([
        memoryGraph(),
        memorySearch(nextQuery.trim(), null, nextQuery.trim() ? 80 : 140),
      ]);
      setGraph(g);
      setHits(list);
      setSelectedPath((current) => {
        if (current && g.nodes.some((node) => node.path === current)) return current;
        const strongest = [...g.nodes].sort((a, b) => nodeDegree(b) - nodeDegree(a))[0];
        return list[0]?.path ?? strongest?.path ?? null;
      });
    } catch (e) {
      reportDiag("memory.load", e, { action: "load" });
      setGraph(null);
      setHits([]);
    } finally {
      setLoading(false);
    }
  }, [query]);

  // Initial load once on mount.
  useEffect(() => {
    load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background refresh: only while visible, on the shared 30s interval. Hidden
  // pane = zero disk I/O (it doesn't subscribe). (Live edits/search still
  // refresh via the query-debounce + save() effects below regardless.)
  useSharedInterval(30_000, () => load(query), visible);

  useEffect(() => {
    const t = window.setTimeout(() => load(query), 220);
    return () => window.clearTimeout(t);
  }, [query, load]);

  useEffect(() => {
    if (!selectedPath) {
      setDraft("");
      setDirty(false);
      return;
    }
    let cancelled = false;
    memoryFile(selectedPath)
      .then((text) => {
        if (cancelled) return;
        setDraft(text);
        setDirty(false);
        setStatus("idle");
      })
      .catch((e) => {
        if (cancelled) return;
        reportDiag("memory.file", e, { action: "read" });
        setDraft("");
        setDirty(false);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  const save = useCallback(async () => {
    const path = selectedRef.current;
    if (!path) return;
    setStatus("saving");
    try {
      await memorySaveRaw(path, draftRef.current);
      setDirty(false);
      setStatus("saved");
      await load(query);
    } catch (e) {
      reportDiag("memory.save", e, { action: "raw" });
      setStatus("error");
    }
  }, [load, query]);

  const create = useCallback(async () => {
    const name = slugStamp();
    try {
      const path = await memorySave(
        name,
        "reference",
        "new memory",
        "capture the durable fact, decision, workflow, or project context here.",
      );
      await load(query);
      setSelectedPath(path);
      setViewMode("editor");
    } catch (e) {
      reportDiag("memory.create", e, { action: "save" });
      setStatus("error");
    }
  }, [load, query]);

  const remove = useCallback(async () => {
    const path = selectedRef.current;
    if (!path) return;
    try {
      await memoryDeletePath(path);
      setSelectedPath(null);
      setDraft("");
      setDirty(false);
      await load(query);
    } catch (e) {
      reportDiag("memory.delete", e, { action: "deletePath" });
      setStatus("error");
    }
  }, [load, query]);

  const send = useCallback(() => {
    if (!onSend) return;
    const body = draftRef.current.trim();
    if (!body) return;
    onSend(contextText(selectedNode, selectedHit, body));
  }, [onSend, selectedHit, selectedNode]);

  const insertLink = useCallback((id: string) => {
    const next = `${draftRef.current.trimEnd()}\n\nrelated: [[${id}]]\n`;
    setDraft(next);
    setDirty(true);
    setStatus("idle");
    setViewMode("editor");
  }, []);

  const visibleHits = useMemo(() => {
    if (!query.trim()) return hits.slice(0, 24);
    return hits;
  }, [hits, query]);

  const vaults = graph?.vaults ?? [];
  const edgeCount = graph?.edges.length ?? 0;
  const orphanCount = graph?.nodes.filter((node) => node.orphan).length ?? 0;

  if (graphOnly) {
    return (
      <div className="grid h-full min-h-0 grid-cols-1 bg-[var(--color-pane)] text-[var(--color-text)]">
        <MemoryGraphView
          graph={graph}
          graphFilter={graphFilter}
          graphOnly={graphOnly}
          query={query}
          selectedPath={selectedPath}
          onSelect={(path) => setSelectedPath(path)}
          onFilterChange={setGraphFilter}
          onGraphOnlyChange={setGraphOnly}
        />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="grid h-full min-h-0 grid-cols-[280px_minmax(360px,1fr)_380px] bg-[var(--color-pane)] text-[var(--color-text)]">
      <div className="flex min-w-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] p-2">
          <div className="relative min-w-0 flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-faint)]"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search memory"
              spellCheck={false}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-7 pr-2 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/70"
            />
          </div>
          <button
            type="button"
            onClick={create}
            title="new memory"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)]"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            onClick={() => load(query)}
            title="refresh memory"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)]"
          >
            <RefreshCw size={13} />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-px border-b border-[var(--color-border)] bg-[var(--color-border)] text-center">
          <div className="bg-[var(--color-panel)] px-2 py-2">
            <div className="font-mono text-[13px] text-[var(--color-text)]">{graph?.count ?? hits.length}</div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--color-faint)]">notes</div>
          </div>
          <div className="bg-[var(--color-panel)] px-2 py-2">
            <div className="font-mono text-[13px] text-[var(--color-text)]">{edgeCount}</div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--color-faint)]">links</div>
          </div>
          <div className="bg-[var(--color-panel)] px-2 py-2">
            <div className="font-mono text-[13px] text-[var(--color-text)]">{orphanCount}</div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--color-faint)]">orphans</div>
          </div>
        </div>

        <div className="flex gap-1 border-b border-[var(--color-border)] p-2">
          <button
            type="button"
            onClick={() => setViewMode("web")}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-[11px] ${
              viewMode === "web"
                ? "border-[var(--color-accent)]/60 bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                : "border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]/50"
            }`}
          >
            <Network size={12} />
            web
          </button>
          <button
            type="button"
            onClick={() => setViewMode("editor")}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-[11px] ${
              viewMode === "editor"
                ? "border-[var(--color-accent)]/60 bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                : "border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]/50"
            }`}
          >
            <Brain size={12} />
            editor
          </button>
        </div>

        <div className="max-h-24 shrink-0 overflow-y-auto border-b border-[var(--color-border)] px-2 py-1.5">
          {vaults.length === 0 ? (
            <div className="px-1 py-1 text-[10.5px] text-[var(--color-faint)]">no vaults found</div>
          ) : (
            vaults.map((vault) => (
              <div key={vault.path} className="flex min-w-0 items-center gap-1.5 py-0.5 text-[10.5px]">
                <GitBranch size={10} className={vault.primary ? "text-[var(--color-accent)]" : "text-[var(--color-faint)]"} />
                <span className="shrink-0 text-[var(--color-text-2)]">{vault.label}</span>
                <span className="min-w-0 truncate text-[var(--color-faint)]">{vault.path}</span>
              </div>
            ))
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && visibleHits.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-[var(--color-faint)]">loading memory</div>
          ) : visibleHits.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-[var(--color-faint)]">no memory matches</div>
          ) : (
            visibleHits.map((hit) => {
              const active = hit.path === selectedPath;
              const node = nodeById.get(hit.id);
              return (
                <button
                  key={hit.path}
                  type="button"
                  onClick={() => setSelectedPath(hit.path)}
                  className={`flex w-full min-w-0 flex-col gap-1 border-b border-[var(--color-border)]/50 px-3 py-2 text-left transition-colors ${
                    active ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel-2)]/55"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: clusterColor(node?.cluster ?? hit.type) }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--color-text)]">
                      {hit.title}
                    </span>
                    <span className="shrink-0 rounded border border-[var(--color-border)] px-1 py-0.5 font-mono text-[9px] text-[var(--color-faint)]">
                      {nodeDegree(node)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-[10.5px] leading-snug text-[var(--color-muted)]">
                    {hit.description || hit.preview || hit.path}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 font-mono text-[9.5px] text-[var(--color-faint)]">
                    <span className="shrink-0">{node?.cluster ?? hit.type}</span>
                    <span className="shrink-0">/</span>
                    <span className="min-w-0 truncate">{hit.vault ?? "memory"}</span>
                    <span className="shrink-0">{relTime(hit.mtime)}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-col">
        {viewMode === "web" ? (
          <MemoryGraphView
            graph={graph}
            graphFilter={graphFilter}
            graphOnly={graphOnly}
            query={query}
            selectedPath={selectedPath}
            onSelect={(path) => setSelectedPath(path)}
            onFilterChange={setGraphFilter}
            onGraphOnlyChange={setGraphOnly}
          />
        ) : (
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
              setStatus("idle");
            }}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[12.5px] leading-relaxed text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
            placeholder="select or create a memory"
          />
        )}
      </div>

      <MemoryInspector
        node={selectedNode}
        hit={selectedHit}
        draft={draft}
        dirty={dirty}
        status={status}
        onDraft={(value) => {
          setDraft(value);
          setDirty(true);
          setStatus("idle");
        }}
        onSave={save}
        onDelete={remove}
        onSend={onSend ? send : undefined}
        onSelectNode={(path) => setSelectedPath(path)}
        onInsertLink={insertLink}
        nodeById={nodeById}
      />
    </div>
  );
}
