/** Local-first diagnostics — the TS side of TELEMETRY-PLAN.md Phase 0+1.
 *
 *  This is the single sink every formerly-silent `.catch(() => {})` now reports
 *  through, plus the React error boundary, the global window error handlers, and
 *  optional light usage events. It builds a `DiagEvent` and hands it to the Rust
 *  command `diag_report`, which persists it to an append-only, size-capped JSONL
 *  under the Tauri app-data dir. ZERO network — nothing leaves the machine.
 *
 *  Hard rule: the reporter MUST NOT throw or reject. The whole point is to add
 *  observability WITHOUT introducing new failure modes — every public fn here is
 *  fire-and-forget and internally try/caught so a diag failure can never cascade
 *  into the very crash we're trying to capture. */
import { invoke, isTauriRuntime } from "./tauri";

export type DiagKind = "error" | "usage" | "perf";

/** The event contract — must agree byte-for-byte with `src-tauri/src/diag.rs`. */
export interface DiagEvent {
  ts: string; // ISO-8601 UTC
  kind: DiagKind;
  source: string; // "terminal.write" | "browser.nav" | "react.chat" | ...
  action?: string;
  message: string;
  stack?: string;
  frames?: string[];
  duration_ms?: number;
  app_version: string;
  os: string;
  anon_install_id: string;
  schema: 1;
}

/** Cached app version (resolved lazily from the Tauri app API; the Rust side
 *  backfills the authoritative value anyway, so this is just a best-effort). */
let cachedVersion = "";
let versionPromise: Promise<void> | null = null;

function loadVersion(): void {
  if (cachedVersion || versionPromise || !isTauriRuntime()) return;
  versionPromise = import("@tauri-apps/api/app")
    .then((m) => m.getVersion())
    .then((v) => {
      cachedVersion = v;
    })
    .catch(() => {
      // Rust backfills app_version, so a failure here is harmless.
    });
}

function osName(): string {
  if (typeof navigator === "undefined") return "";
  const p = navigator.platform?.toLowerCase() ?? "";
  const ua = navigator.userAgent?.toLowerCase() ?? "";
  if (p.includes("mac") || ua.includes("mac")) return "macos";
  if (p.includes("win") || ua.includes("win")) return "windows";
  if (p.includes("linux") || ua.includes("linux")) return "linux";
  return "";
}

/** Normalize anything thrown into a one-line message + (optional) stack. */
function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message || String(err), stack: err.stack };
  }
  if (typeof err === "string") return { message: err };
  if (err && typeof err === "object") {
    const anyErr = err as { message?: unknown; stack?: unknown };
    if (typeof anyErr.message === "string") {
      return {
        message: anyErr.message,
        stack: typeof anyErr.stack === "string" ? anyErr.stack : undefined,
      };
    }
    try {
      return { message: JSON.stringify(err) };
    } catch {
      return { message: String(err) };
    }
  }
  return { message: String(err) };
}

/** Session-local dedupe: many catches sit on `alive`-guarded polling loops that
 *  would otherwise spam thousands of identical events when a backend is down.
 *  We report at most once per (source|action|message) signature per session. */
const seenSignatures = new Set<string>();

function signature(source: string, action: string | undefined, message: string): string {
  // Collapse digits/hex so "load failed (attempt 412)" dedupes with "(attempt 9)".
  const norm = message
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "H")
    .replace(/\d+/g, "N")
    .slice(0, 120);
  return `${source}|${action ?? ""}|${norm}`;
}

/** The core sink. Non-throwing. Builds a DiagEvent (kind:"error") and persists
 *  it via the Rust command. `source` is a short tag for where it happened
 *  (e.g. "terminal.write", "browser.nav", "chat.approval-reply"); `ctx` can
 *  carry an `action` verb and arbitrary extra fields (folded into the message
 *  tail so the schema stays flat).
 *
 *  This is the function the 91 former `.catch(() => {})` sites call:
 *    .catch((e) => reportDiag("terminal.write", e)) */
export function reportDiag(
  source: string,
  err: unknown,
  ctx?: Record<string, unknown>,
): void {
  try {
    if (!isTauriRuntime()) return;
    loadVersion();
    const { message, stack } = describe(err);
    const action =
      ctx && typeof ctx.action === "string" ? (ctx.action as string) : undefined;

    const sig = signature(source, action, message);
    if (seenSignatures.has(sig)) return;
    seenSignatures.add(sig);

    // Fold any extra ctx (minus `action`, which is a first-class field) into a
    // compact suffix so the flat schema captures it without a free-form blob.
    let extra = "";
    if (ctx) {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(ctx)) {
        if (k === "action") continue;
        rest[k] = v;
      }
      if (Object.keys(rest).length) {
        try {
          extra = ` | ctx=${JSON.stringify(rest).slice(0, 200)}`;
        } catch {
          /* ignore unserializable ctx */
        }
      }
    }

    const event: DiagEvent = {
      ts: new Date().toISOString(),
      kind: "error",
      source,
      action,
      message: (message + extra).slice(0, 500),
      stack: stack ? stack.slice(0, 4000) : undefined,
      app_version: cachedVersion,
      os: osName(),
      anon_install_id: "", // Rust backfills the authoritative value.
      schema: 1,
    };
    void invoke<void>("diag_report", { event }).catch(() => {
      // Reporter must never reject — a failed diag write is swallowed.
    });
  } catch {
    // Absolutely never let the reporter itself throw.
  }
}

/** Light usage event — kind:"usage". Fire-and-forget, seeds the "what I use"
 *  prioritization. Carries only the feature/action enums, never argument values
 *  or typed text. */
export function reportUsage(feature: string, action?: string): void {
  try {
    if (!isTauriRuntime()) return;
    loadVersion();
    const event: DiagEvent = {
      ts: new Date().toISOString(),
      kind: "usage",
      source: feature,
      action,
      message: action ? `${feature}:${action}` : feature,
      app_version: cachedVersion,
      os: osName(),
      anon_install_id: "",
      schema: 1,
    };
    void invoke<void>("diag_report", { event }).catch(() => {});
  } catch {
    /* never throw */
  }
}

/** Read back recent events for the Diagnostics tab (newest first). */
export function diagRecent(limit = 200): Promise<DiagEvent[]> {
  if (!isTauriRuntime()) return Promise.resolve([]);
  return invoke<DiagEvent[]>("diag_recent", { limit }).catch(() => []);
}

/** Clear the local diag store. */
export function diagClear(): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  return invoke<void>("diag_clear").catch(() => {});
}

export interface DiagInfo {
  install_id: string;
  app_version: string;
  os: string;
}

/** Install id + app version + os for the Diagnostics tab header. */
export function diagInfo(): Promise<DiagInfo> {
  const fallback: DiagInfo = { install_id: "", app_version: "", os: osName() };
  if (!isTauriRuntime()) return Promise.resolve(fallback);
  return invoke<DiagInfo>("diag_info").catch(() => fallback);
}

/** Install the global JS error handlers. Call once from `main.tsx`. */
export function installGlobalDiagHandlers(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e) => {
    reportDiag("window.error", e.error ?? e.message, {
      action: "onerror",
      filename: (e as ErrorEvent).filename,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    reportDiag("window.unhandledrejection", (e as PromiseRejectionEvent).reason, {
      action: "unhandledrejection",
    });
  });
}
