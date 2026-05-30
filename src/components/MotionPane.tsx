/** STUDIO — the MotionBoards canvas, in AIOS.
 *
 * Not a private gallery: a live pan/zoom view of the SAME server-side board the
 * `motion` MCP and the MotionBoards web app read/write (`mb_boards` via
 * GET/POST /api/boards). So it's interchangeable with the MCP — assets Claude
 * generates with `add_to_board:true` show up here on the next poll, and
 * generations fired from this composer are written back to the same board so
 * they show for the MCP / web too.
 *
 *   - canvas: drag empty space to pan, scroll to pan, ⌘/ctrl-scroll (or pinch)
 *     to zoom. Items are absolutely placed in board space at their x/y/w/h.
 *   - items: image / video / generation (with live status) / text, rendered from
 *     the board. Click media to enlarge.
 *   - composer (bottom): prompt + model + image/video → generate. The result
 *     drops onto the canvas at the viewport centre and persists to the board.
 *   - sync: polls /api/boards every ~10s + manual refresh to catch MCP assets.
 *
 * Design per DESIGN.md — brand --color-* tokens, restrained accent, lucide.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AlertCircle,
  Copy,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Plus,
  RefreshCw,
  Sparkles,
  Video as VideoIcon,
  Wand2,
  X,
} from "lucide-react";

import {
  formatCost,
  kindForModel,
  looksLikeVideo,
  motionBoardSave,
  motionBoards,
  motionCredits,
  motionGenerate,
  motionModels,
  motionStatus,
  type BoardItem,
  type GenerationOptions,
  type GenKind,
  type MotionCreditsResult,
  type MotionModel,
  type MotionSavedState,
} from "../lib/motion";

/** A board item plus the transient poll handles a live UI generation carries. */
interface LiveItem extends BoardItem {
  kind?: GenKind;
  requestId?: string;
  generationId?: string;
  durationSec?: number;
  resolution?: string;
  error?: string;
  _local?: boolean; // not yet confirmed on the server board
}

const activePollers = new Set<string>();
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 3;

export function MotionPane() {
  const [models, setModels] = useState<MotionModel[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [credits, setCredits] = useState<MotionCreditsResult | null>(null);

  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const [kind, setKind] = useState<GenKind>("image");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // shared board state (server) + transient local items (in-flight UI gens)
  const [board, setBoard] = useState<MotionSavedState | null>(null);
  const [boardName, setBoardName] = useState<string>("");
  const [locals, setLocals] = useState<LiveItem[]>([]);
  const [syncing, setSyncing] = useState(false);

  // viewport
  const [pan, setPan] = useState({ x: 80, y: 80 });
  const [zoom, setZoom] = useState(0.6);
  const viewportRef = useRef<HTMLDivElement>(null);
  // The board-space layer we pan/zoom. We mutate its transform DIRECTLY during a
  // drag (imperative) so a pan doesn't trigger a React re-render every frame —
  // the big canvas-lag win, alongside memoizing the items below.
  const layerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number; nx: number; ny: number } | null>(null);
  // Fit the viewport to the board's items once, on first load — without this the
  // default pan/zoom leaves items (which live at large board-space coords) off
  // screen, so the canvas looks empty / "stuck loading".
  const didFitRef = useRef(false);

  const [lightbox, setLightbox] = useState<LiveItem | null>(null);
  // Stable so memoized CanvasItems don't re-render when pan/zoom changes.
  const openLightbox = useCallback((it: LiveItem) => {
    if (it.outputUrl || it.src) setLightbox(it);
  }, []);

  // ── loaders ───────────────────────────────────────────────────────────────

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setLoadError(null);
    try {
      const res = await motionModels();
      setConfigured(res.configured);
      setBaseUrl(res.baseUrl);
      setModels(res.models || []);
      if (!res.ok && res.error) setLoadError(res.error);
      setModelId((cur) => {
        if (cur && res.models.some((m) => m.id === cur)) return cur;
        const first = res.models[0];
        if (first) {
          setKind(kindForModel(first));
          return first.id;
        }
        return "";
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingModels(false);
    }
  }, []);

  const loadCredits = useCallback(async () => {
    try {
      setCredits(await motionCredits());
    } catch {
      setCredits(null);
    }
  }, []);

  const loadBoard = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await motionBoards();
      if (res.configured === false) setConfigured(false);
      if (res.data) {
        setBoard(res.data);
        const active =
          res.data.boards?.find((b) => b.id === res.data!.activeBoardId) ?? res.data.boards?.[0];
        setBoardName(active?.name ?? "");
        // drop any local items that the server now knows about.
        const serverIds = new Set(active?.items?.map((i) => i.id) ?? []);
        setLocals((prev) => prev.filter((l) => !serverIds.has(l.id)));
      }
    } catch {
      /* keep last board */
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
    loadCredits();
    loadBoard();
  }, [loadModels, loadCredits, loadBoard]);

  // poll the shared board so MCP-generated assets appear without a manual refresh.
  useEffect(() => {
    const t = setInterval(loadBoard, 10_000);
    return () => clearInterval(t);
  }, [loadBoard]);

  const selectedModel = useMemo(() => models.find((m) => m.id === modelId) || null, [models, modelId]);
  const onPickModel = (id: string) => {
    setModelId(id);
    const m = models.find((x) => x.id === id);
    if (m) setKind(kindForModel(m));
  };

  // active board's items merged with not-yet-synced local items.
  const items: LiveItem[] = useMemo(() => {
    const active = board?.boards?.find((b) => b.id === board.activeBoardId) ?? board?.boards?.[0];
    const server = (active?.items ?? []) as LiveItem[];
    const serverIds = new Set(server.map((i) => i.id));
    return [...server, ...locals.filter((l) => !serverIds.has(l.id))];
  }, [board, locals]);

  // ── pan / zoom ──────────────────────────────────────────────────────────────

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-board-item]")) return; // let items handle clicks
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, nx: pan.x, ny: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    d.nx = d.px + (e.clientX - d.x);
    d.ny = d.py + (e.clientY - d.y);
    // Write the transform straight to the DOM — no setState, no re-render of the
    // (potentially dozens of) items while dragging. We commit to state on release.
    if (layerRef.current) {
      layerRef.current.style.transform = `translate(${d.nx}px, ${d.ny}px) scale(${zoom})`;
    }
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d) setPan({ x: d.nx, y: d.ny }); // single commit at end of drag
  };
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // pinch / ⌘-scroll → zoom toward the cursor.
      const rect = viewportRef.current?.getBoundingClientRect();
      const cx = e.clientX - (rect?.left ?? 0);
      const cy = e.clientY - (rect?.top ?? 0);
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * (1 - e.deltaY * 0.0015)));
      const k = next / zoom;
      setPan((p) => ({ x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }));
      setZoom(next);
    } else {
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  };
  /** Fit the viewport to the bounding box of all items (or reset when empty). */
  const fit = useCallback(() => {
    const active = board?.boards?.find((b) => b.id === board.activeBoardId) ?? board?.boards?.[0];
    const all = [...(active?.items ?? []), ...locals] as LiveItem[];
    const vp = viewportRef.current?.getBoundingClientRect();
    if (!all.length || !vp) {
      setPan({ x: 80, y: 80 });
      setZoom(0.6);
      return;
    }
    const minX = Math.min(...all.map((i) => i.x));
    const minY = Math.min(...all.map((i) => i.y));
    const maxX = Math.max(...all.map((i) => i.x + (i.width || 280)));
    const maxY = Math.max(...all.map((i) => i.y + (i.height || 280)));
    const pad = 60;
    const z = Math.min(
      ZOOM_MAX,
      Math.max(
        ZOOM_MIN,
        Math.min((vp.width - pad * 2) / Math.max(1, maxX - minX), (vp.height - pad * 2) / Math.max(1, maxY - minY)),
      ),
    );
    // centre the content in the viewport at the fitted zoom.
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setZoom(z);
    setPan({ x: vp.width / 2 - cx * z, y: vp.height / 2 - cy * z });
  }, [board, locals]);

  // Auto-fit once, as soon as the first board with items arrives.
  useEffect(() => {
    if (didFitRef.current) return;
    const active = board?.boards?.find((b) => b.id === board.activeBoardId) ?? board?.boards?.[0];
    if (active?.items?.length) {
      didFitRef.current = true;
      // next frame so the viewport has measured.
      requestAnimationFrame(() => fit());
    }
  }, [board, fit]);

  // ── generate ──────────────────────────────────────────────────────────────

  const patchLocal = useCallback((id: string, p: Partial<LiveItem>) => {
    setLocals((prev) => prev.map((it) => (it.id === id ? { ...it, ...p } : it)));
  }, []);

  /** Best-effort write-back: GET fresh board, append the item, POST it. */
  const persist = useCallback(async (item: BoardItem) => {
    try {
      const res = await motionBoards();
      const data = res.data;
      if (!data?.boards?.length) return;
      const activeId = data.activeBoardId || data.boards[0].id;
      const b = data.boards.find((x) => x.id === activeId) ?? data.boards[0];
      if (b.items.some((i) => i.id === item.id)) return;
      b.items = [...b.items, item];
      await motionBoardSave({ ...data, savedAt: Date.now() });
      loadBoard();
    } catch {
      /* item still shows locally; it just isn't shared this round */
    }
  }, [loadBoard]);

  const poll = useCallback(
    (item: LiveItem) => {
      if (!item.requestId || !item.generationId || activePollers.has(item.id)) return;
      activePollers.add(item.id);
      const tick = async () => {
        try {
          const res = await motionStatus({
            requestId: item.requestId!,
            modelId: item.model || "",
            generationId: item.generationId!,
            durationSec: item.durationSec,
            resolution: item.resolution,
          });
          if (res.status === "completed" && res.outputUrl) {
            patchLocal(item.id, { status: "completed", outputUrl: res.outputUrl, cost: res.cost, progressText: undefined });
            activePollers.delete(item.id);
            loadCredits();
            persist({ ...item, status: "completed", outputUrl: res.outputUrl, cost: res.cost, src: res.outputUrl });
            return;
          }
          if (res.status === "failed") {
            patchLocal(item.id, { status: "failed", error: res.error || "generation failed", progressText: undefined });
            activePollers.delete(item.id);
            return;
          }
          patchLocal(item.id, { progressText: res.log || res._pollError || "generating…" });
          setTimeout(tick, 8000);
        } catch {
          setTimeout(tick, 12000);
        }
      };
      tick();
    },
    [patchLocal, loadCredits, persist],
  );

  const canGenerate =
    configured &&
    !!selectedModel &&
    !submitting &&
    (prompt.trim().length > 0 || !selectedModel.inputs?.some((i) => i.type === "text" && i.required));

  const handleGenerate = async () => {
    if (!selectedModel || !canGenerate) return;
    setSubmitError(null);
    setSubmitting(true);

    // place at the centre of the current viewport, in board coordinates.
    const rect = viewportRef.current?.getBoundingClientRect();
    const w = kind === "video" ? 360 : 300;
    const h = kind === "video" ? 200 : 300;
    const cx = ((rect?.width ?? 800) / 2 - pan.x) / zoom - w / 2;
    const cy = ((rect?.height ?? 600) / 2 - pan.y) / zoom - h / 2;
    const id = `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const item: LiveItem = {
      id,
      type: "generation",
      x: cx + (Math.random() * 40 - 20),
      y: cy + (Math.random() * 40 - 20),
      width: w,
      height: h,
      prompt: prompt.trim(),
      model: selectedModel.id,
      modelName: selectedModel.name,
      outputType: kind,
      kind,
      status: "processing",
      progressText: "starting…",
      createdAt: new Date().toISOString(),
      _local: true,
    };
    setLocals((prev) => [item, ...prev]);

    try {
      const opts: GenerationOptions = {};
      const res = await motionGenerate({ model: selectedModel.id, prompt: prompt.trim() || undefined, kind, opts });
      if (res.outputUrl) {
        patchLocal(id, { status: "completed", outputUrl: res.outputUrl, src: res.outputUrl, cost: res.cost, progressText: undefined });
        loadCredits();
        persist({ ...item, status: "completed", outputUrl: res.outputUrl, src: res.outputUrl, cost: res.cost });
      } else if (res.requestId && res.modelId && res.generationId) {
        const handles = { requestId: res.requestId, generationId: res.generationId, model: res.modelId, progressText: "queued…" };
        patchLocal(id, handles);
        poll({ ...item, ...handles });
      } else {
        patchLocal(id, { status: "failed", error: res.error || "no output returned", progressText: undefined });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSubmitError(msg);
      patchLocal(id, { status: "failed", error: msg, progressText: undefined });
    } finally {
      setSubmitting(false);
    }
  };

  const onPromptKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleGenerate();
    }
  };

  const refreshAll = () => {
    loadModels();
    loadCredits();
    loadBoard();
  };
  const creditLabel = credits?.credits != null ? `RM${credits.creditsRm}` : null;

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      {/* header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Wand2 size={14} className="text-[var(--color-accent)]" />
          <span className="text-[13px] font-medium text-[var(--color-text)]">studio</span>
          {boardName && <span className="truncate text-[11px] text-[var(--color-muted)]">· {boardName}</span>}
          <span className="shrink-0 text-[11px] text-[var(--color-faint)]">· {items.length} items</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-[var(--color-faint)]">{Math.round(zoom * 100)}%</span>
          <button onClick={fit} className="rounded px-1.5 py-0.5 text-[10px] text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]" title="reset view">fit</button>
          {creditLabel && (
            <span className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-0.5 font-mono text-[11px] text-[var(--color-text-2)]" title={credits?.name ? `${credits.name} · ${credits.email}` : "credits"}>
              <Sparkles size={10} className="text-[var(--color-accent)]" />
              {creditLabel}
            </span>
          )}
          <button onClick={refreshAll} className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]" title="sync board + models">
            <RefreshCw size={12} className={syncing || loadingModels ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {!configured ? (
        <ConfigureState baseUrl={baseUrl} error={loadError} onRetry={refreshAll} />
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* canvas viewport */}
          <div
            ref={viewportRef}
            className="aios-canvas-grid h-full w-full cursor-grab active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onWheel={onWheel}
          >
            {/* board-space layer */}
            <div
              ref={layerRef}
              className="absolute left-0 top-0 origin-top-left"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            >
              {items.map((it) => (
                <CanvasItem key={it.id} item={it} onOpen={openLightbox} />
              ))}
            </div>

            {/* empty hint */}
            {items.length === 0 && !syncing && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <Sparkles size={26} className="mb-2 text-[var(--color-faint)]" />
                <p className="text-[14px] font-medium text-[var(--color-text-2)]">your canvas</p>
                <p className="mt-1 max-w-xs text-[12px] leading-relaxed text-[var(--color-muted)]">
                  generate below, or from Claude via the motion MCP — assets land on this same board.
                </p>
              </div>
            )}
          </div>

          {/* floating composer */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
            <div className="focus-accent surface-card pointer-events-auto flex w-full max-w-2xl flex-col gap-2 p-2.5 shadow-[var(--aios-shadow-pop)]">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onPromptKey}
                rows={1}
                placeholder={kind === "video" ? "describe the shot — motion, camera, mood…" : "describe the image — subject, style, lighting…"}
                className="max-h-32 min-h-[36px] w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
              />
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex overflow-hidden rounded-[var(--aios-radius-pill)] border border-[var(--color-border)]">
                  {(["image", "video"] as GenKind[]).map((k) => {
                    const active = kind === k;
                    const Icon = k === "image" ? ImageIcon : VideoIcon;
                    return (
                      <button key={k} onClick={() => setKind(k)} className={`flex items-center gap-1 px-2.5 py-1 text-[11.5px] transition-colors ${active ? "bg-[var(--color-accent-soft)] text-[var(--color-text)]" : "text-[var(--color-muted)] hover:text-[var(--color-text)]"}`}>
                        <Icon size={12} />
                        {k}
                      </button>
                    );
                  })}
                </div>
                <select
                  value={modelId}
                  onChange={(e) => onPickModel(e.target.value)}
                  className="min-w-0 flex-1 cursor-pointer rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] outline-none hover:border-[var(--color-border-strong)]"
                >
                  {(() => {
                    const matching = models.filter((m) => kindForModel(m) === kind);
                    return (matching.length ? matching : models).map((m) => (
                      <option key={m.id} value={m.id}>{m.name} · {formatCost(m.creditCost)}</option>
                    ));
                  })()}
                </select>
                <button
                  onClick={handleGenerate}
                  disabled={!canGenerate}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition-colors ${canGenerate ? "bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]" : "cursor-not-allowed bg-[var(--color-panel-2)] text-[var(--color-faint)]"}`}
                  title="Generate (⌘/Ctrl+Enter)"
                >
                  {submitting ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                  generate
                </button>
              </div>
              {(submitError || (loadError && !loadingModels)) && (
                <span className="text-[10.5px] text-[var(--color-danger)]">{submitError || loadError}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {(lightbox?.outputUrl || lightbox?.src) && (
        <Lightbox item={lightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

// ── one canvas item ───────────────────────────────────────────────────────────

const CanvasItem = memo(function CanvasItem({ item, onOpen }: { item: LiveItem; onOpen: (it: LiveItem) => void }) {
  const url = item.outputUrl || item.src || "";
  const isVideo = item.type === "video" || item.outputType === "video" || (item.kind === "video") || (url ? looksLikeVideo(url) : false);
  const processing = item.status === "processing";
  const failed = item.status === "failed";

  return (
    <div
      data-board-item
      className="group absolute overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] shadow-sm transition-shadow hover:border-[var(--color-border-strong)] hover:shadow-md"
      style={{ left: item.x, top: item.y, width: item.width || 280, height: item.height || 280 }}
    >
      {item.type === "text" ? (
        <div className="flex h-full w-full items-center justify-center p-3 text-center text-[var(--color-text)]" style={{ fontSize: 16 }}>
          {item.text}
        </div>
      ) : processing ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-3 text-center">
          <Loader2 size={20} className="animate-spin text-[var(--color-accent)]" />
          <span className="line-clamp-2 text-[11px] text-[var(--color-muted)]">{item.progressText || "generating…"}</span>
        </div>
      ) : failed ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-3 text-center">
          <AlertCircle size={18} className="text-[var(--color-danger)]" />
          <span className="line-clamp-3 text-[10px] text-[var(--color-danger)]">{item.error || "failed"}</span>
        </div>
      ) : url ? (
        isVideo ? (
          // preload="none" so a board of many videos doesn't buffer them all at
          // once (a major source of canvas lag in WebView2).
          <video src={url} controls playsInline preload="none" className="h-full w-full object-contain" />
        ) : (
          <img src={url} alt={item.prompt || ""} loading="lazy" decoding="async" className="h-full w-full cursor-zoom-in object-cover" onClick={() => onOpen(item)} />
        )
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[var(--color-faint)]"><ImageIcon size={20} /></div>
      )}

      {/* hover actions on finished media */}
      {url && !processing && !failed && (
        <div className="pointer-events-none absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <TileAction title="Enlarge" onClick={() => onOpen(item)} icon={<Maximize2 size={11} />} />
          <TileAction title="Open externally" href={url} icon={<ExternalLink size={11} />} />
        </div>
      )}

      {/* caption strip */}
      {(item.prompt || item.modelName) && !processing && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent px-2 pb-1.5 pt-5 opacity-0 transition-opacity group-hover:opacity-100">
          <p className="line-clamp-2 text-[10px] leading-snug text-white/90">{item.prompt}</p>
          {item.modelName && <p className="font-mono text-[9px] text-white/55">{item.modelName}{item.cost ? ` · ${item.cost}` : ""}</p>}
        </div>
      )}
    </div>
  );
});

function TileAction({ title, onClick, href, icon }: { title: string; onClick?: () => void; href?: string; icon: React.ReactNode }) {
  const cls = "pointer-events-auto flex h-5 w-5 items-center justify-center rounded bg-black/55 text-white backdrop-blur-sm hover:bg-black/75";
  if (href) {
    return <a className={cls} href={href} title={title} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{icon}</a>;
  }
  return <button className={cls} title={title} onClick={(e) => { e.stopPropagation(); onClick?.(); }}>{icon}</button>;
}

// ── configure state ───────────────────────────────────────────────────────────

function ConfigureState({ baseUrl, error, onRetry }: { baseUrl: string; error: string | null; onRetry: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="surface-card max-w-md p-5 text-center">
        <AlertCircle size={22} className="mx-auto mb-2 text-[var(--color-warning)]" />
        <p className="mb-1 text-[14px] font-medium text-[var(--color-text)]">configure MotionBoards API</p>
        <p className="mb-3 text-[12px] leading-relaxed text-[var(--color-muted)]">
          {error || "no API key found. create one at motionboards.vercel.app → Settings → API Keys."}
        </p>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-left font-mono text-[11px] text-[var(--color-text-2)]">
          <div>export AIOS_MOTION_KEY=mb_…</div>
          <div className="text-[var(--color-faint)]"># or MOTIONBOARDS_API_KEY (same as the MCP)</div>
          <div className="mt-1 text-[var(--color-faint)]"># optional: AIOS_MOTION_API={baseUrl || "https://motionboards.vercel.app"}</div>
        </div>
        <button onClick={onRetry} className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-2)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]">
          <RefreshCw size={12} /> retry
        </button>
      </div>
    </div>
  );
}

// ── enlarge overlay ────────────────────────────────────────────────────────────

function Lightbox({ item, onClose }: { item: LiveItem; onClose: () => void }) {
  const url = item.outputUrl || item.src || "";
  const isVideo = item.type === "video" || item.outputType === "video" || item.kind === "video" || looksLikeVideo(url);
  const copyUrl = () => navigator.clipboard?.writeText(url).catch(() => {});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-in absolute inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
        <span className="truncate pr-3 font-mono text-[11px] text-white/70">{item.modelName}{item.cost ? ` · ${item.cost}` : ""}</span>
        <div className="flex items-center gap-1.5">
          <a href={url} target="_blank" rel="noreferrer" title="Open externally" className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20"><ExternalLink size={14} /></a>
          <a href={url} download title="Download" className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20"><Download size={14} /></a>
          <button onClick={copyUrl} title="Copy URL" className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20"><Copy size={14} /></button>
          <button onClick={onClose} title="Close (Esc)" className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20"><X size={14} /></button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
        {isVideo ? (
          <video src={url} controls autoPlay playsInline className="max-h-full max-w-full rounded-lg" />
        ) : (
          <img src={url} alt={item.prompt || ""} className="max-h-full max-w-full rounded-lg object-contain" />
        )}
      </div>
      {item.prompt && (
        <div className="shrink-0 px-4 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
          <p className="mx-auto max-w-2xl text-[12px] leading-relaxed text-white/70">{item.prompt}</p>
        </div>
      )}
    </div>
  );
}
