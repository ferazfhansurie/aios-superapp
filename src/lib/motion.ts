/**
 * MOTION — typed wrappers over the Rust `motion_*` Tauri commands, which proxy
 * the MotionBoards REST API (the `flashstudio` Next.js app at
 * https://motionboards.vercel.app). The Rust side (src-tauri/src/motion.rs)
 * holds the Bearer key + base URL and shells out to `curl`, so the webview never
 * touches CORS or the key — these wrappers just invoke + type the result.
 *
 * Contract (verified live against the deployed app + the canonical MCP client
 * at ~/Repo/firaz/claude-motion):
 *   - models:   GET  /api/models       → catalog used to drive the model picker
 *   - credits:  GET  /api/auth/me      → credit balance (SEN) + account
 *   - generate: POST /api/generate     → sync { outputUrl } OR async { requestId, modelId }
 *   - status:   GET  /api/generate/status → poll an async job to completion
 *
 * Config is server-side env: AIOS_MOTION_KEY (or MOTIONBOARDS_API_KEY) for the
 * `mb_…` Bearer, and AIOS_MOTION_API to override the base URL. When the key is
 * absent every call returns `{ configured: false }` so the pane can show a
 * clear setup state rather than failing.
 */
import { invoke } from "@tauri-apps/api/core";

// ── model catalog ────────────────────────────────────────────────────────

/** Generation family. Image-ish kinds render <img>; everything else <video>. */
export type ModelType =
  | "t2i"
  | "i2i"
  | "t2v"
  | "i2v"
  | "s2e"
  | "v2v"
  | "upscale"
  | "lipsync"
  | "audio"
  | "a2a"
  | "sfx"
  | string;

/** One input slot a model declares (text prompt, image ref, etc.). */
export interface ModelInput {
  name: string;
  type: "text" | "image" | "video" | "audio" | string;
  required: boolean;
  description: string;
}

/** A model entry as returned by GET /api/models. */
export interface MotionModel {
  id: string;
  name: string;
  type: ModelType;
  provider: string;
  /** Estimated cost in SEN (RM × 100). 0 / undefined = free or unpriced. */
  creditCost?: number;
  inputs: ModelInput[];
}

/** Envelope from `motion_models` — `models` is always an array (possibly empty). */
export interface MotionModelsResult {
  ok: boolean;
  /** False when no API key is set — pane shows the configure state. */
  configured: boolean;
  baseUrl: string;
  models: MotionModel[];
  status?: number;
  error?: string;
}

// ── credits / account ──────────────────────────────────────────────────────

/** Envelope from `motion_credits`. `credits` is null when unknown. */
export interface MotionCreditsResult {
  ok: boolean;
  configured: boolean;
  baseUrl: string;
  /** Balance in SEN (RM × 100), or null if it couldn't be read. */
  credits: number | null;
  /** Same balance formatted as RM (2dp), or null. */
  creditsRm: string | null;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  subscriptionActive?: boolean;
  status?: number;
  error?: string;
}

// ── generate / status ──────────────────────────────────────────────────────

/** Whether a model produces still images or time-based media. */
export type GenKind = "image" | "video";

/**
 * Result of POST /api/generate, augmented by the Rust layer with `_kind`.
 * SYNC models populate `outputUrl` + `status:"completed"`. ASYNC models
 * populate `requestId` + `modelId` + `status:"processing"` and one
 * `<provider>Video:true` flag (geminiVideo / replicateVideo / byteplusVideo /
 * openaiVideo / comfyVideo) — the pane doesn't need to read those; the status
 * route auto-detects the provider from `modelId`.
 */
export interface MotionGenerateResult {
  generationId?: string;
  status?: "completed" | "processing" | "failed" | string;
  // sync
  outputUrl?: string;
  cost?: string;
  // async
  requestId?: string;
  modelId?: string;
  // echo of the kind passed in
  _kind?: GenKind;
  // provider flags (present on async; not needed by callers)
  geminiVideo?: boolean;
  replicateVideo?: boolean;
  byteplusVideo?: boolean;
  openaiVideo?: boolean;
  comfyVideo?: boolean;
  error?: string;
}

/** Result of GET /api/generate/status. */
export interface MotionStatusResult {
  status: "completed" | "processing" | "failed" | string;
  outputUrl?: string;
  /** Provider progress hint, e.g. "Generating video... 40%". */
  log?: string;
  /** Actual charged cost, e.g. "RM3.36" — present on async completion. */
  cost?: string;
  error?: string;
  /** Soft transport hint when a poll round-trip failed (job still running). */
  _pollError?: string;
}

/** Free-form model options forwarded as `generationOptions`. */
export type GenerationOptions = Record<string, string | number | boolean>;

// ── invocations ────────────────────────────────────────────────────────────

/** Fetch the live model catalog. Never throws — returns the envelope. */
export async function motionModels(): Promise<MotionModelsResult> {
  return invoke<MotionModelsResult>("motion_models");
}

/** Best-effort credits + account read. Never throws — `credits` may be null. */
export async function motionCredits(): Promise<MotionCreditsResult> {
  return invoke<MotionCreditsResult>("motion_credits");
}

/**
 * Kick off a generation. Resolves to the API payload (sync result or async job
 * handles). REJECTS with the API's own error message on failure (no key,
 * network down, insufficient credits, content-policy block, …) so callers can
 * surface an exact message.
 */
export async function motionGenerate(args: {
  model: string;
  prompt?: string;
  kind?: GenKind;
  opts?: GenerationOptions;
}): Promise<MotionGenerateResult> {
  return invoke<MotionGenerateResult>("motion_generate", {
    model: args.model,
    prompt: args.prompt,
    kind: args.kind,
    opts: args.opts ?? null,
  });
}

/**
 * Poll an async job. Pass the handles from an async `motionGenerate` result.
 * Never throws — a flaky poll comes back as `{ status:"processing", _pollError }`
 * so the caller keeps polling.
 */
export async function motionStatus(args: {
  requestId: string;
  modelId: string;
  generationId: string;
  durationSec?: number;
  resolution?: string;
}): Promise<MotionStatusResult> {
  return invoke<MotionStatusResult>("motion_status", {
    requestId: args.requestId,
    modelId: args.modelId,
    generationId: args.generationId,
    durationSec: args.durationSec,
    resolution: args.resolution,
  });
}

// ── helpers ────────────────────────────────────────────────────────────────

/** RM string for a SEN cost, e.g. 336 → "RM3.36". `null`/0 → "free". */
export function formatCost(sen?: number | null): string {
  if (sen == null || sen <= 0) return "free";
  return `RM${(sen / 100).toFixed(2)}`;
}

/**
 * Best-effort image-vs-video classification for a model, used to pick the
 * image/video toggle default and the result player. Mirrors the MCP's
 * `inferOutputType` heuristic plus the model `type` field.
 */
export function kindForModel(m: Pick<MotionModel, "type" | "id">): GenKind {
  const t = (m.type || "").toLowerCase();
  if (t === "t2i" || t === "i2i" || t === "upscale") return "image";
  if (
    t === "t2v" ||
    t === "i2v" ||
    t === "s2e" ||
    t === "v2v" ||
    t === "lipsync"
  ) {
    return "video";
  }
  // audio/sfx/a2a have no visual; treat as video so the <video> tag can still
  // play audio-only outputs with controls. Then fall back to id sniffing.
  const id = (m.id || "").toLowerCase();
  if (/(veo|seedance|kling|wan-|lipsync|sora|video|t2v|i2v|s2e)/.test(id)) return "video";
  if (/(banana|flux|gpt-image|t2i|i2i|image)/.test(id)) return "image";
  return "image";
}

/** True when a URL most likely points at a video (by extension). */
export function looksLikeVideo(url: string): boolean {
  return /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(url);
}
