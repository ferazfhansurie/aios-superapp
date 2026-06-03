import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  Camera,
  ExternalLink,
  Loader2,
  MonitorUp,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";

import { fileSrc } from "../lib/fs";
import { captureMacApp, focusMacApp, listMacApps, type MacAppInfo } from "../lib/macApps";

export function AppAttachPane({
  name,
  bundleId,
}: {
  name: string;
  bundleId?: string | null;
}) {
  const [apps, setApps] = useState<MacAppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusing, setFocusing] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [capturePath, setCapturePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setApps(await listMacApps());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const app = useMemo(
    () =>
      apps.find((item) =>
        bundleId
          ? item.bundle_id === bundleId
          : item.name.toLowerCase() === name.toLowerCase(),
      ) ?? {
        name,
        bundle_id: bundleId ?? null,
        windows: [],
        window_error: null,
      },
    [apps, bundleId, name],
  );

  const focus = useCallback(async () => {
    setError(null);
    setFocusing(true);
    try {
      await focusMacApp(app);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFocusing(false);
    }
  }, [app]);

  const capture = useCallback(async () => {
    setError(null);
    setCapturing(true);
    try {
      const path = await captureMacApp(app);
      setCapturePath(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCapturing(false);
    }
  }, [app]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <MonitorUp size={14} className="shrink-0 text-[var(--color-accent)]" />
          <span className="truncate text-[13px] font-medium">{app.name}</span>
          <span className="truncate font-mono text-[10px] text-[var(--color-muted)]">
            {app.bundle_id ?? "external app"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title="refresh app state"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            onClick={() => void focus()}
            disabled={focusing}
            className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 text-[11px] text-[var(--color-text-2)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)] disabled:opacity-60"
            title="focus native app"
          >
            {focusing ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
            focus
          </button>
          <button
            type="button"
            onClick={() => void capture()}
            disabled={capturing}
            className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2 text-[11px] font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            title="capture preview"
          >
            {capturing ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
            capture
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto]">
        <div className="grid min-h-0 place-items-center bg-[var(--color-panel)] p-4">
          {capturePath ? (
            <div className="flex h-full min-h-0 w-full flex-col gap-2">
              <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--color-border)] bg-black">
                <img
                  src={fileSrc(capturePath)}
                  alt={`${app.name} capture preview`}
                  className="h-full w-full object-contain"
                  draggable={false}
                />
              </div>
              <div className="truncate font-mono text-[10px] text-[var(--color-faint)]">{capturePath}</div>
            </div>
          ) : (
            <div className="flex max-w-md flex-col items-center gap-3 text-center">
              <div className="grid h-14 w-14 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-accent)]">
                <AppWindow size={26} />
              </div>
              <div>
                <div className="text-[13px] font-medium">attached external app</div>
                <div className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
                  this pane is the control target for the native app. use capture for an in-pane preview; live mirroring builds on the same screen-recording bridge. direct native window embedding is not reliable on macos.
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] p-3">
          {error && (
            <div className="mb-3 rounded-md border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-3 py-2 text-[11.5px] text-[var(--color-danger)]">
              {error}
            </div>
          )}
          <div className="mb-2 flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
            <ShieldAlert size={12} />
            windows from accessibility
          </div>
          {app.windows.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {app.windows.map((windowTitle) => (
                <span
                  key={windowTitle}
                  className="max-w-full truncate rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-[11px] text-[var(--color-text-2)]"
                >
                  {windowTitle || "untitled"}
                </span>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-[11.5px] text-[var(--color-muted)]">
              {app.window_error
                ? "window titles need accessibility permission"
                : "no windows reported yet"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
