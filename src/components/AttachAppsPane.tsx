import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  ExternalLink,
  Loader2,
  MonitorUp,
  PanelTopOpen,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";

import { focusMacApp, listMacApps, type MacAppInfo } from "../lib/macApps";
import { useVisible } from "../lib/useVisible";
import { useSharedInterval } from "../lib/ticker";

export function AttachAppsPane({
  onAttachApp,
}: {
  onAttachApp?: (app: MacAppInfo) => void;
}) {
  const [apps, setApps] = useState<MacAppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusing, setFocusing] = useState<string | null>(null);
  // Gate polling to when the pane is actually visible — hidden panes stay
  // mounted (display:none) in the cockpit, so this timer would otherwise keep
  // re-enumerating every running app forever in the background. (`paneVisible`
  // to avoid clashing with the `visible` filtered-apps memo below.)
  const { ref: rootRef, visible: paneVisible } = useVisible<HTMLDivElement>();

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
    // One load on mount / when becoming visible so the pane isn't blank. The
    // steady poll rides the shared 30s interval below (the native side also
    // caches for 5s, so a manual refresh stays snappy).
    void refresh();
  }, [refresh, paneVisible]);
  // Poll only while visible — hidden pane doesn't subscribe → zero I/O.
  useSharedInterval(30_000, refresh, paneVisible);

  const visible = useMemo(
    () => apps.filter((app) => app.bundle_id !== "com.adletic.aios"),
    [apps],
  );

  const focus = useCallback(async (app: MacAppInfo) => {
    setFocusing(app.bundle_id ?? app.name);
    try {
      await focusMacApp(app);
    } finally {
      setFocusing(null);
    }
  }, []);

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <MonitorUp size={14} className="shrink-0 text-[var(--color-accent)]" />
          <span className="truncate text-[13px] font-medium">apps</span>
          <span className="text-[11px] text-[var(--color-muted)]">{visible.length} running</span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="refresh running apps"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && (
          <div className="mb-3 rounded-md border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] p-3 text-[12px] text-[var(--color-danger)]">
            {error}
          </div>
        )}

        <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-3">
          <div className="mb-1 flex items-center gap-2 text-[12px] font-medium">
            <ShieldAlert size={13} className="text-[var(--color-muted)]" />
            attach model
          </div>
          <p className="text-[11.5px] leading-relaxed text-[var(--color-muted)]">
            attach opens a dedicated pane for the native app. macos does not reliably reparent arbitrary app windows into a webview, so mirror/control lives in that attached pane instead of pretending focus is attach.
          </p>
        </div>

        {loading && visible.length === 0 ? (
          <div className="grid h-28 place-items-center text-[var(--color-muted)]">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-4 text-center text-[12px] text-[var(--color-muted)]">
            no visible apps found
          </div>
        ) : (
          <div className="grid gap-2">
            {visible.map((app) => {
              const id = app.bundle_id ?? app.name;
              const busy = focusing === id;
              return (
                <div
                  key={id}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <AppWindow size={14} className="shrink-0 text-[var(--color-accent)]" />
                        <span className="truncate text-[12.5px] font-medium">{app.name}</span>
                      </div>
                      <div className="mt-1 truncate font-mono text-[10px] text-[var(--color-faint)]">
                        {app.bundle_id ?? "no bundle id"}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onAttachApp?.(app)}
                        className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2 text-[11px] font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] hover:text-[var(--color-accent-hover-fg)]"
                        title="attach as pane"
                      >
                        <PanelTopOpen size={12} />
                        attach
                      </button>
                      <button
                        type="button"
                        onClick={() => void focus(app)}
                        disabled={busy}
                        className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 text-[11px] text-[var(--color-text-2)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)] disabled:opacity-60"
                        title="focus app"
                      >
                        {busy ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
                        focus
                      </button>
                    </div>
                  </div>

                  {app.windows.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {app.windows.slice(0, 4).map((windowTitle) => (
                        <span
                          key={windowTitle}
                          className="max-w-full truncate rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-text-2)]"
                        >
                          {windowTitle || "untitled"}
                        </span>
                      ))}
                    </div>
                  ) : app.window_error ? (
                    <div className="mt-2 text-[10.5px] text-[var(--color-muted)]">
                      window titles need accessibility permission
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
