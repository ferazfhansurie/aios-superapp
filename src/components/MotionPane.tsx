/** MOTION — MotionBoards AI generation canvas. A simple, fast gen studio that
 *  hits the MotionBoards REST API through the Rust `motion_*` proxy: pick a
 *  model, write a prompt, toggle image/video, generate. Results land in a live
 *  gallery — sync models fill instantly, async models (Veo / Seedance / Kling)
 *  poll to completion with a spinner. Click a tile to enlarge, open externally,
 *  download, or copy its URL.
 *
 *  Design follows the AIOS system (DESIGN.md): brand --color-* tokens only,
 *  light+dark safe, restrained accent (accent only on the primary Generate
 *  button + active toggle + focus), lucide icons, font-sans, dense text. Mirrors
 *  the shape of PluginsPane / BridgesPane. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AlertCircle,
  Clapperboard,
  Copy,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Maximize2,
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
  motionCredits,
  motionGenerate,
  motionModels,
  motionStatus,
  type GenerationOptions,
  type GenKind,
  type MotionCreditsResult,
  type MotionModel,
} from "../lib/motion";

// One tile in the results gallery — a single generation's lifecycle.
interface GenItem {
  id: string;
  prompt: string;
  modelId: string;
  modelName: string;
  kind: GenKind;
  status: "processing" | "completed" | "failed";
  outputUrl?: string;
  progress?: string;
  cost?: string;
  error?: string;
  createdAt: number;
  // async poll handles (absent for sync results)
  requestId?: string;
  generationId?: string;
  durationSec?: number;
  resolution?: string;
}

// Module-scoped guard so a remount never double-polls the same job.
const activePollers = new Set<string>();

export function MotionPane() {
  const [models, setModels] = useState<MotionModel[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");

  const [credits, setCredits] = useState<MotionCreditsResult | null>(null);

  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState<string>("");
  const [kind, setKind] = useState<GenKind>("image");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [items, setItems] = useState<GenItem[]>([]);
  const [lightbox, setLightbox] = useState<GenItem | null>(null);

  const promptRef = useRef<HTMLTextAreaElement>(null);

  // ── data load ────────────────────────────────────────────────────────────

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setLoadError(null);
    try {
      const res = await motionModels();
      setConfigured(res.configured);
      setBaseUrl(res.baseUrl);
      setModels(res.models || []);
      if (!res.ok && res.error) setLoadError(res.error);
      // Default-select the first model + match the toggle to its kind.
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
      setModels([]);
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

  useEffect(() => {
    loadModels();
    loadCredits();
  }, [loadModels, loadCredits]);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === modelId) || null,
    [models, modelId],
  );

  // Keep the image/video toggle honest when the model changes.
  const onPickModel = (id: string) => {
    setModelId(id);
    const m = models.find((x) => x.id === id);
    if (m) setKind(kindForModel(m));
  };

  // Whether the chosen model actually needs reference files we don't collect
  // here (image/video/audio inputs) — used to warn that this canvas is
  // prompt-only for now. Text-only models generate cleanly.
  const needsRefs = useMemo(
    () =>
      !!selectedModel?.inputs?.some(
        (i) => i.required && i.type !== "text",
      ),
    [selectedModel],
  );

  // ── polling ────────────────────────────────────────────────────────────────

  const patch = useCallback((id: string, p: Partial<GenItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...p } : it)));
  }, []);

  const poll = useCallback(
    (item: GenItem) => {
      if (!item.requestId || !item.generationId) return;
      if (activePollers.has(item.id)) return;
      activePollers.add(item.id);

      const tick = async () => {
        try {
          const res = await motionStatus({
            requestId: item.requestId!,
            modelId: item.modelId,
            generationId: item.generationId!,
            durationSec: item.durationSec,
            resolution: item.resolution,
          });
          if (res.status === "completed" && res.outputUrl) {
            patch(item.id, {
              status: "completed",
              outputUrl: res.outputUrl,
              cost: res.cost,
              progress: undefined,
            });
            activePollers.delete(item.id);
            loadCredits();
            return;
          }
          if (res.status === "failed") {
            patch(item.id, {
              status: "failed",
              error: res.error || "Generation failed",
              progress: undefined,
            });
            activePollers.delete(item.id);
            return;
          }
          patch(item.id, { progress: res.log || res._pollError || "Generating…" });
          setTimeout(tick, 8000); // 8s cadence — matches the web client
        } catch {
          setTimeout(tick, 12000); // back off on transport error
        }
      };

      tick();
    },
    [patch, loadCredits],
  );

  // ── generate ────────────────────────────────────────────────────────────────

  const canGenerate =
    configured &&
    !!selectedModel &&
    !submitting &&
    (prompt.trim().length > 0 || !selectedModel.inputs?.some((i) => i.type === "text" && i.required));

  const handleGenerate = async () => {
    if (!selectedModel || !canGenerate) return;
    setSubmitError(null);
    setSubmitting(true);

    const id = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const opts: GenerationOptions = {}; // prompt-driven; provider picks sane defaults
    const item: GenItem = {
      id,
      prompt: prompt.trim(),
      modelId: selectedModel.id,
      modelName: selectedModel.name,
      kind,
      status: "processing",
      progress: "Starting…",
      createdAt: Date.now(),
    };
    setItems((prev) => [item, ...prev]);

    try {
      const res = await motionGenerate({
        model: selectedModel.id,
        prompt: prompt.trim() || undefined,
        kind,
        opts,
      });

      // Sync — output ready immediately.
      if (res.outputUrl) {
        patch(id, {
          status: "completed",
          outputUrl: res.outputUrl,
          cost: res.cost,
          progress: undefined,
        });
        loadCredits();
      } else if (res.requestId && res.modelId && res.generationId) {
        // Async — stash handles + start polling.
        const updated: Partial<GenItem> = {
          requestId: res.requestId,
          generationId: res.generationId,
          progress: "Queued…",
        };
        patch(id, updated);
        poll({ ...item, ...updated, modelId: res.modelId });
      } else {
        patch(id, {
          status: "failed",
          error: res.error || "No output returned",
          progress: undefined,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSubmitError(msg);
      patch(id, { status: "failed", error: msg, progress: undefined });
    } finally {
      setSubmitting(false);
    }
  };

  const onPromptKey = (e: React.KeyboardEvent) => {
    // Cmd/Ctrl+Enter to fire — matches the chat composer muscle memory.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleGenerate();
    }
  };

  const copyUrl = (url: string) => {
    navigator.clipboard?.writeText(url).catch(() => {});
  };

  // ── render ────────────────────────────────────────────────────────────────

  const creditLabel =
    credits?.credits != null ? `RM${credits.creditsRm}` : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      {/* header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <div className="flex items-center gap-2">
          <Wand2 size={14} className="text-[var(--color-accent)]" />
          <span className="text-[13px] font-medium text-[var(--color-text)]">motion · gen studio</span>
          <span className="text-[11px] text-[var(--color-muted)]">
            {models.length} models
          </span>
        </div>
        <div className="flex items-center gap-2">
          {creditLabel && (
            <span
              className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-0.5 font-mono text-[11px] text-[var(--color-text-2)]"
              title={credits?.name ? `${credits.name} · ${credits.email}` : "available credits"}
            >
              <Sparkles size={10} className="text-[var(--color-accent)]" />
              {creditLabel}
            </span>
          )}
          <button
            onClick={() => {
              loadModels();
              loadCredits();
            }}
            className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title="Refresh models + credits"
          >
            <RefreshCw size={12} className={loadingModels ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* needs-config state — no API key */}
      {!configured ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="surface-card max-w-md p-5 text-center">
            <AlertCircle size={22} className="mx-auto mb-2 text-[var(--color-warning)]" />
            <p className="mb-1 text-[14px] font-medium text-[var(--color-text)]">
              configure MotionBoards API
            </p>
            <p className="mb-3 text-[12px] leading-relaxed text-[var(--color-muted)]">
              {loadError ||
                "no API key found. create one at motionboards.vercel.app → Settings → API Keys."}
            </p>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-left font-mono text-[11px] text-[var(--color-text-2)]">
              <div>export AIOS_MOTION_KEY=mb_…</div>
              <div className="text-[var(--color-faint)]"># or MOTIONBOARDS_API_KEY</div>
              <div className="mt-1 text-[var(--color-faint)]">
                # optional: AIOS_MOTION_API={baseUrl || "https://motionboards.vercel.app"}
              </div>
            </div>
            <button
              onClick={() => {
                loadModels();
                loadCredits();
              }}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-2)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
            >
              <RefreshCw size={12} /> retry
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* composer */}
          <div className="shrink-0 border-b border-[var(--color-border)] p-3">
            <div className="focus-accent surface-card flex flex-col gap-2 p-2.5">
              <textarea
                ref={promptRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onPromptKey}
                rows={2}
                placeholder={
                  kind === "video"
                    ? "describe the shot — camera move, motion, mood, lighting…"
                    : "describe the image — subject, style, lighting, composition…"
                }
                className="max-h-40 min-h-[44px] w-full resize-none bg-transparent text-[14px] leading-relaxed text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
              />

              {/* controls row */}
              <div className="flex flex-wrap items-center gap-2">
                {/* image / video toggle */}
                <div className="inline-flex overflow-hidden rounded-[var(--aios-radius-pill)] border border-[var(--color-border)]">
                  {(["image", "video"] as GenKind[]).map((k) => {
                    const active = kind === k;
                    const Icon = k === "image" ? ImageIcon : VideoIcon;
                    return (
                      <button
                        key={k}
                        onClick={() => setKind(k)}
                        className={`flex items-center gap-1 px-2.5 py-1 text-[11.5px] transition-colors ${
                          active
                            ? "bg-[var(--color-accent-soft)] text-[var(--color-text)]"
                            : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                        }`}
                        title={`show ${k} models`}
                      >
                        <Icon size={12} />
                        {k}
                      </button>
                    );
                  })}
                </div>

                {/* model dropdown — filtered to the toggled kind, but degrades
                    to all models if a kind has none */}
                <div className="relative min-w-0 flex-1">
                  <select
                    value={modelId}
                    onChange={(e) => onPickModel(e.target.value)}
                    className="w-full min-w-0 cursor-pointer rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] outline-none hover:border-[var(--color-border-strong)] focus:border-[color-mix(in_srgb,var(--color-accent)_50%,transparent)]"
                  >
                    {(() => {
                      const matching = models.filter((m) => kindForModel(m) === kind);
                      const list = matching.length > 0 ? matching : models;
                      return list.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} · {formatCost(m.creditCost)}
                        </option>
                      ));
                    })()}
                  </select>
                </div>

                {/* generate */}
                <button
                  onClick={handleGenerate}
                  disabled={!canGenerate}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition-colors ${
                    canGenerate
                      ? "bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]"
                      : "cursor-not-allowed bg-[var(--color-panel-2)] text-[var(--color-faint)]"
                  }`}
                  title="Generate (⌘/Ctrl+Enter)"
                >
                  {submitting ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Wand2 size={13} />
                  )}
                  generate
                </button>
              </div>

              {/* model meta + warnings */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-[var(--color-faint)]">
                {selectedModel && (
                  <span className="font-mono">
                    {selectedModel.provider} · {selectedModel.type} · {formatCost(selectedModel.creditCost)}
                  </span>
                )}
                {needsRefs && (
                  <span className="text-[var(--color-warning)]">
                    · needs a reference file — open the canvas at {baseUrl.replace(/^https?:\/\//, "")} to attach
                  </span>
                )}
                {submitError && (
                  <span className="text-[var(--color-danger)]">· {submitError}</span>
                )}
              </div>
            </div>
          </div>

          {/* results gallery */}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {loadError && !loadingModels && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] text-[var(--color-danger)]">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <span>{loadError}</span>
              </div>
            )}

            {items.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <Clapperboard size={26} className="mb-2 text-[var(--color-faint)]" />
                <p className="text-[14px] font-medium text-[var(--color-text-2)]">
                  your gen studio
                </p>
                <p className="mt-1 max-w-xs text-[12px] leading-relaxed text-[var(--color-muted)]">
                  write a prompt, pick a model, hit generate. images land
                  instantly; video polls to completion.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
                {items.map((it) => (
                  <GenTile
                    key={it.id}
                    item={it}
                    onOpen={() => it.outputUrl && setLightbox(it)}
                    onCopy={() => it.outputUrl && copyUrl(it.outputUrl)}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* lightbox */}
      {lightbox?.outputUrl && (
        <Lightbox item={lightbox} onClose={() => setLightbox(null)} onCopy={() => copyUrl(lightbox.outputUrl!)} />
      )}
    </div>
  );
}

// ── one result tile ──────────────────────────────────────────────────────────

function GenTile({
  item,
  onOpen,
  onCopy,
}: {
  item: GenItem;
  onOpen: () => void;
  onCopy: () => void;
}) {
  const isVideo = item.kind === "video" || (item.outputUrl ? looksLikeVideo(item.outputUrl) : false);

  return (
    <div className="surface-card group relative flex flex-col">
      {/* media / status area — square-ish */}
      <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-[var(--color-panel)]">
        {item.status === "processing" && (
          <div className="flex flex-col items-center gap-1.5 px-2 text-center">
            <Loader2 size={18} className="animate-spin text-[var(--color-accent)]" />
            <span className="line-clamp-2 text-[10.5px] text-[var(--color-muted)]">
              {item.progress || "generating…"}
            </span>
          </div>
        )}

        {item.status === "failed" && (
          <div className="flex flex-col items-center gap-1 px-2 text-center">
            <AlertCircle size={16} className="text-[var(--color-danger)]" />
            <span className="line-clamp-3 text-[10px] text-[var(--color-danger)]">
              {item.error || "failed"}
            </span>
          </div>
        )}

        {item.status === "completed" && item.outputUrl && (
          <>
            {isVideo ? (
              <video
                src={item.outputUrl}
                controls
                playsInline
                className="h-full w-full object-contain"
              />
            ) : (
              <img
                src={item.outputUrl}
                alt={item.prompt}
                loading="lazy"
                className="h-full w-full cursor-zoom-in object-contain"
                onClick={onOpen}
              />
            )}

            {/* hover actions */}
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <TileAction title="Enlarge" onClick={onOpen} icon={<Maximize2 size={11} />} />
              <TileAction title="Open externally" href={item.outputUrl} icon={<ExternalLink size={11} />} />
              <TileAction title="Download" href={item.outputUrl} download icon={<Download size={11} />} />
              <TileAction title="Copy URL" onClick={onCopy} icon={<Copy size={11} />} />
            </div>
          </>
        )}
      </div>

      {/* caption */}
      <div className="flex flex-col gap-0.5 px-2 py-1.5">
        <span className="line-clamp-2 text-[11px] leading-snug text-[var(--color-text-2)]">
          {item.prompt || <span className="text-[var(--color-faint)]">no prompt</span>}
        </span>
        <span className="flex items-center justify-between font-mono text-[9.5px] text-[var(--color-faint)]">
          <span className="truncate">{item.modelName}</span>
          {item.cost && <span className="shrink-0 pl-1">{item.cost}</span>}
        </span>
      </div>
    </div>
  );
}

function TileAction({
  title,
  onClick,
  href,
  download,
  icon,
}: {
  title: string;
  onClick?: () => void;
  href?: string;
  download?: boolean;
  icon: React.ReactNode;
}) {
  const cls =
    "pointer-events-auto flex h-5 w-5 items-center justify-center rounded bg-black/55 text-white backdrop-blur-sm hover:bg-black/75";
  if (href) {
    return (
      <a
        className={cls}
        href={href}
        title={title}
        target="_blank"
        rel="noreferrer"
        download={download}
        onClick={(e) => e.stopPropagation()}
      >
        {icon}
      </a>
    );
  }
  return (
    <button
      className={cls}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      {icon}
    </button>
  );
}

// ── enlarge overlay ──────────────────────────────────────────────────────────

function Lightbox({
  item,
  onClose,
  onCopy,
}: {
  item: GenItem;
  onClose: () => void;
  onCopy: () => void;
}) {
  const url = item.outputUrl!;
  const isVideo = item.kind === "video" || looksLikeVideo(url);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-in absolute inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* toolbar */}
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
        <span className="truncate pr-3 font-mono text-[11px] text-white/70">
          {item.modelName}
          {item.cost ? ` · ${item.cost}` : ""}
        </span>
        <div className="flex items-center gap-1.5">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title="Open externally"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20"
          >
            <ExternalLink size={14} />
          </a>
          <a
            href={url}
            download
            title="Download"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20"
          >
            <Download size={14} />
          </a>
          <button
            onClick={onCopy}
            title="Copy URL"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20"
          >
            <Copy size={14} />
          </button>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* media */}
      <div className="flex min-h-0 flex-1 items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
        {isVideo ? (
          <video src={url} controls autoPlay playsInline className="max-h-full max-w-full rounded-lg" />
        ) : (
          <img src={url} alt={item.prompt} className="max-h-full max-w-full rounded-lg object-contain" />
        )}
      </div>

      {/* prompt */}
      {item.prompt && (
        <div className="shrink-0 px-4 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
          <p className="mx-auto max-w-2xl text-[12px] leading-relaxed text-white/70">{item.prompt}</p>
        </div>
      )}
    </div>
  );
}
