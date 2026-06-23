import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bug,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Smartphone,
  XCircle,
} from "lucide-react";

import { fileSrc } from "../lib/fs";
import { openEditorFileInPane, openViewerFileInPane } from "../lib/paneBus";
import {
  latestWrmsShot,
  runWrmsQa,
  type WrmsQaApp,
  type WrmsQaFlow,
  type WrmsQaRunResult,
  type WrmsQaShot,
} from "../lib/wrmsQa";

function basename(path?: string | null): string {
  return path?.split("/").filter(Boolean).pop() ?? "";
}

function resultClass(result?: string | null): string {
  if (result === "PASS") return "text-[var(--color-success)]";
  if (result === "FAIL" || result === "STOPPED") return "text-[var(--color-danger)]";
  return "text-[var(--color-muted)]";
}

function compactRunLog(run: WrmsQaRunResult | null): string {
  if (!run) return "";
  const lines = `${run.stdout}\n${run.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-10).join("\n");
}

export function WrmsDevicePane() {
  const [app, setApp] = useState<WrmsQaApp>("collector");
  const [shot, setShot] = useState<WrmsQaShot | null>(null);
  const [run, setRun] = useState<WrmsQaRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setShot(await latestWrmsShot(app));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [app]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runFlow = useCallback(async (flow: WrmsQaFlow) => {
    setRunning(true);
    setError(null);
    try {
      const next = await runWrmsQa({ appKind: app, flows: [flow] });
      setRun(next);
      setShot(next.latest);
      if (!next.ok) setError(next.stderr.trim() || `${app} ${flow} exited ${next.code ?? "nonzero"}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [app]);

  const image = shot?.path ? fileSrc(shot.path) : null;
  const result = shot?.result ?? (run ? (run.ok ? "PASS" : "FAIL") : null);
  const log = useMemo(() => compactRunLog(run), [run]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)] text-[13px] text-[var(--color-text)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Smartphone size={15} className="text-[var(--color-accent)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold">wrms {app}</div>
          <div className="truncate font-mono text-[10px] text-[var(--color-faint)]">
            {shot?.runId ?? "no run loaded"}
          </div>
        </div>
        <div className="flex shrink-0 overflow-hidden rounded-md border border-[var(--color-border)]">
          {(["collector", "vendor"] as const).map((nextApp) => (
            <button
              key={nextApp}
              type="button"
              onClick={() => {
                setApp(nextApp);
                setRun(null);
              }}
              className={`h-7 px-2 text-[10px] transition-colors ${
                app === nextApp
                  ? "bg-[var(--color-accent)] text-[var(--color-bg)]"
                  : "text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              }`}
              title={`show ${nextApp} runs`}
            >
              {nextApp}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || running}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] disabled:opacity-50"
          title="refresh latest screenshot"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
        <button
          type="button"
          onClick={() => void runFlow(app === "vendor" ? "smoke" : "login")}
          disabled={running}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2 text-[11px] font-medium text-[var(--color-bg)] transition-opacity disabled:opacity-50"
          title={app === "vendor" ? "run vendor smoke" : "run collector login"}
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {app === "vendor" ? "smoke" : "login"}
        </button>
        {app === "vendor" && (
          <button
            type="button"
            onClick={() => void runFlow("login")}
            disabled={running}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] disabled:opacity-50"
            title="run vendor login with VENDOR_USER/VENDOR_PASS"
          >
            <Bug size={13} />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="grid min-h-0 flex-1 place-items-center overflow-hidden bg-black/20 p-3">
          {image ? (
            <button
              type="button"
              onClick={() => shot?.path && openViewerFileInPane(shot.path, basename(shot.path))}
              className="grid h-full min-h-0 w-full place-items-center"
              title="open screenshot"
            >
              <img
                src={image}
                alt="latest wrms collector screenshot"
                className="max-h-full max-w-full rounded-md border border-[var(--color-border)] object-contain shadow-2xl"
              />
            </button>
          ) : (
            <div className="flex flex-col items-center gap-2 text-[var(--color-faint)]">
              <ImageIcon size={26} />
              <div className="text-[12px]">no {app} screenshots</div>
            </div>
          )}
        </div>

        <aside className="flex w-[260px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)]/35">
          <div className="border-b border-[var(--color-border)] p-3">
            <div className="mb-2 flex items-center gap-1.5">
              {result === "PASS" ? (
                <CheckCircle2 size={14} className="text-[var(--color-success)]" />
              ) : result ? (
                <XCircle size={14} className="text-[var(--color-danger)]" />
              ) : (
                <Smartphone size={14} className="text-[var(--color-muted)]" />
              )}
              <span className={`text-[12px] font-semibold ${resultClass(result)}`}>
                {result ?? "idle"}
              </span>
              {shot?.findings != null && (
                <span className="ml-auto font-mono text-[10px] text-[var(--color-faint)]">
                  {shot.findings} finding{shot.findings === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <div className="space-y-1 font-mono text-[10px] text-[var(--color-faint)]">
              {shot?.shotDir && <div className="truncate" title={shot.shotDir}>shots: {basename(shot.shotDir)}</div>}
              {shot?.reportMd && <div className="truncate" title={shot.reportMd}>report: {basename(shot.reportMd)}</div>}
              {shot?.path && <div className="truncate" title={shot.path}>image: {basename(shot.path)}</div>}
            </div>
          </div>

          <div className="flex gap-1.5 border-b border-[var(--color-border)] p-2">
            <button
              type="button"
              disabled={!shot?.reportMd}
              onClick={() => shot?.reportMd && openEditorFileInPane(shot.reportMd, basename(shot.reportMd))}
              className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] disabled:opacity-35"
              title="open markdown report"
            >
              <FileText size={13} />
            </button>
            <button
              type="button"
              disabled={!shot?.reportJson}
              onClick={() => shot?.reportJson && openEditorFileInPane(shot.reportJson, basename(shot.reportJson))}
              className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] disabled:opacity-35"
              title="open json report"
            >
              <FileText size={13} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {error && (
              <div className="mb-3 rounded-md border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/10 p-2 text-[11px] leading-4 text-[var(--color-danger)]">
                {error}
              </div>
            )}
            {log ? (
              <pre className="whitespace-pre-wrap rounded-md border border-[var(--color-border)] bg-black/20 p-2 font-mono text-[10px] leading-4 text-[var(--color-muted)]">
                {log}
              </pre>
            ) : (
              <div className="text-[11px] text-[var(--color-faint)]">latest {app} run metadata appears here</div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
