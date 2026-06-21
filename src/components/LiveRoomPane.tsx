import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Circle,
  Clapperboard,
  Loader2,
  Mic,
  MonitorUp,
  MousePointer2,
  Pause,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
  Square,
  Video,
  Wand2,
} from "lucide-react";

import {
  appcastClose,
  appcastHide,
  appcastListWindows,
  appcastSetBounds,
  appcastShow,
  appcastStart,
  type WindowInfo,
} from "../lib/appcast";
import type { Rect } from "../lib/browser";
import {
  LIVE_ROOM_MODES,
  describeLiveRoomControls,
  liveRoomPermissionSummary,
  liveRoomStatusLabel,
  restoreLiveRoomMode,
  type LiveRoomMode,
  type LiveRoomPermissions,
  type LiveRoomStatus,
} from "../lib/liveRoom";
import { reportDiag } from "../lib/diag";

interface AppGroup {
  app: string;
  windows: WindowInfo[];
}

function isScreenPermissionError(msg: string | null): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return m.includes("screen") || m.includes("permission") || m.includes("not authorized") || m.includes("tcc");
}

type RailSection = readonly [title: string, items: string[]];

function modeRail(mode: LiveRoomMode, picked: WindowInfo | null): RailSection[] {
  if (mode === "content") {
    return [
      ["scenes", ["window", "camera", "window + camera"]],
      ["sources", [picked ? `${picked.app_name} · ${picked.window_title || "untitled"}` : "no window selected", "mic", "camera preview"]],
      ["takes", ["take 1", "markers", "snapshots"]],
      ["clips", ["disabled until recording lands"]],
    ];
  }
  if (mode === "mirror") {
    return [
      ["selected window", [picked ? `${picked.app_name} · ${picked.window_title || "untitled"}` : "no window selected"]],
      ["permission", ["screen recording", "control disabled"]],
      ["fit", ["fit stage", "show cursor"]],
      ["send frame", ["disabled until snapshots land"]],
    ];
  }
  return [
    ["agenda", ["client context", "talking points"]],
    ["notes", ["live notes ready"]],
    ["markers", ["decisions", "follow-up", "clip this"]],
    ["post-call", ["summarize disabled", "follow-up disabled", "tasks disabled"]],
  ];
}

function SourceLabel({ picked }: { picked: WindowInfo | null }) {
  if (!picked) return <span className="live-room-muted">no source</span>;
  return (
    <span className="truncate">
      {picked.app_name}
      {picked.window_title ? ` · ${picked.window_title}` : ""}
    </span>
  );
}

export function LiveRoomPane({
  paneKey,
  active = true,
  hidden = false,
  initialMode,
  sessionId,
  initialWindowId,
  onModeChange,
  onSessionChange,
  onWindowChange,
}: {
  paneKey: string;
  active?: boolean;
  hidden?: boolean;
  initialMode?: LiveRoomMode;
  sessionId?: string;
  initialWindowId?: number;
  onModeChange?: (mode: LiveRoomMode) => void;
  onSessionChange?: (sessionId: string) => void;
  onWindowChange?: (windowId: number) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const startedRef = useRef(false);

  const [mode, setMode] = useState<LiveRoomMode>(() => restoreLiveRoomMode(initialMode));
  const [status, setStatus] = useState<LiveRoomStatus>("idle");
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [picked, setPicked] = useState<number | null>(initialWindowId ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickedWin = windows.find((w) => w.window_id === picked) ?? null;
  const permissionBlocked = isScreenPermissionError(error);
  const permissions: LiveRoomPermissions = {
    screen: pickedWin ? "granted" : permissionBlocked ? "blocked" : "unknown",
    mic: "unknown",
    camera: "unknown",
  };
  const permissionSummary = liveRoomPermissionSummary(permissions);
  const controls = describeLiveRoomControls({ status, permissions });

  const rect = useCallback((): Rect | null => {
    const el = slotRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, []);

  const refreshWindows = useCallback(() => {
    setLoadingList(true);
    setError(null);
    setStatus((s) => (s === "idle" || s === "permission-blocked" ? "loading" : s));
    appcastListWindows()
      .then((rows) => {
        setWindows(rows);
        if (rows.length === 0) {
          setStatus("idle");
          setError("no app windows found");
        } else if (!picked) {
          setStatus("idle");
        }
      })
      .catch((e) => {
        const msg = typeof e === "string" ? e : String(e);
        setError(msg);
        setStatus(permissionBlocked ? "permission-blocked" : "failed");
        reportDiag("live-room.list", e, { action: "listWindows" });
      })
      .finally(() => setLoadingList(false));
  }, [permissionBlocked, picked]);

  const pickWindow = useCallback(
    (w: WindowInfo) => {
      setPickerOpen(false);
      setQuery("");
      if (startedRef.current) {
        appcastClose(paneKey).catch((e) => reportDiag("live-room.close", e, { action: "switch" }));
        startedRef.current = false;
      }
      setPicked(w.window_id);
      onWindowChange?.(w.window_id);
      setError(null);
      setStatus("preview");
    },
    [onWindowChange, paneKey],
  );

  const groups: AppGroup[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? windows.filter((w) => w.app_name.toLowerCase().includes(q) || w.window_title.toLowerCase().includes(q))
      : windows;
    const byApp = new Map<string, WindowInfo[]>();
    for (const w of filtered) {
      const key = w.app_name || "unknown";
      byApp.set(key, [...(byApp.get(key) ?? []), w]);
    }
    return Array.from(byApp.entries())
      .map(([app, rows]) => ({ app, windows: rows }))
      .sort((a, b) => a.app.localeCompare(b.app));
  }, [query, windows]);

  const setModeSafe = useCallback(
    (next: LiveRoomMode) => {
      const def = LIVE_ROOM_MODES.find((m) => m.id === next);
      if (!def?.enabled) return;
      setMode(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

  useEffect(() => {
    refreshWindows();
  }, [refreshWindows]);

  useEffect(() => {
    if (!sessionId) onSessionChange?.(`lr-${Date.now().toString(36)}`);
  }, [onSessionChange, sessionId]);

  useEffect(() => {
    if (!active || hidden || pickerOpen) {
      if (startedRef.current) appcastHide(paneKey).catch((e) => reportDiag("live-room.hide", e, { action: "hide" }));
      return;
    }
    if (picked == null) return;

    let raf = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let lastBounds: Rect | null = null;
    const sameRect = (a: Rect | null, b: Rect | null) =>
      !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
    const sync = (force = false) => {
      const r = rect();
      if (!r) return;
      if (!startedRef.current) {
        startedRef.current = true;
        lastBounds = r;
        appcastStart(paneKey, picked, r)
          .then(() => {
            setError(null);
            setStatus((s) => (s === "loading" || s === "idle" ? "preview" : s));
          })
          .catch((e) => {
            startedRef.current = false;
            const msg = typeof e === "string" ? e : String(e);
            setError(msg);
            setStatus(isScreenPermissionError(msg) ? "permission-blocked" : "failed");
          });
      } else if (force || !sameRect(r, lastBounds)) {
        lastBounds = r;
        appcastShow(paneKey).catch(() => {});
        appcastSetBounds(paneKey, r).catch((e) => reportDiag("live-room.bounds", e, { action: "setBounds" }));
      }
    };
    const syncSettled = () => {
      sync(true);
      for (const delay of [40, 120, 260, 520, 900]) timers.push(setTimeout(() => sync(true), delay));
    };
    raf = requestAnimationFrame(() => requestAnimationFrame(() => sync(true)));
    const ro = new ResizeObserver(() => sync());
    if (slotRef.current) ro.observe(slotRef.current);
    window.addEventListener("resize", syncSettled);
    document.addEventListener("fullscreenchange", syncSettled);
    const poll = setInterval(() => sync(), 1000);
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      ro.disconnect();
      window.removeEventListener("resize", syncSettled);
      document.removeEventListener("fullscreenchange", syncSettled);
      clearInterval(poll);
    };
  }, [active, hidden, paneKey, picked, pickerOpen, rect]);

  useEffect(() => {
    return () => {
      startedRef.current = false;
      appcastHide(paneKey).catch((e) => reportDiag("live-room.hide", e, { action: "cleanup" }));
      appcastClose(paneKey).catch((e) => reportDiag("live-room.close", e, { action: "cleanup" }));
    };
  }, [paneKey]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    const focus = setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      clearTimeout(focus);
    };
  }, [pickerOpen]);

  const rail = modeRail(mode, pickedWin);

  return (
    <div className="live-room">
      <div className="live-room__topbar">
        <div className="live-room__title">
          <Clapperboard size={16} />
          <span>live room</span>
        </div>
        <div className="live-room__source">
          <SourceLabel picked={pickedWin} />
        </div>
        <div className={`live-room__status live-room__status--${status}`}>
          <span />
          {liveRoomStatusLabel(status)}
        </div>
      </div>

      <div className="live-room__modes" role="tablist" aria-label="live room modes">
        {LIVE_ROOM_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            disabled={!m.enabled}
            title={m.disabledReason ?? m.label}
            className={mode === m.id ? "is-active" : ""}
            onClick={() => setModeSafe(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="live-room__body">
        <div className="live-room__main">
          <div className="live-room__stage-wrap">
            <div ref={slotRef} className="live-room__stage">
              {!pickedWin && !error && (
                <div className="live-room__empty">
                  <MonitorUp size={34} />
                  <h3>choose a window to start</h3>
                  <p>share one app or screen surface into the room. camera, mic, record and snapshots are staged here.</p>
                </div>
              )}
              {loadingList && (
                <div className="live-room__empty">
                  <Loader2 size={28} className="animate-spin" />
                  <h3>scanning windows</h3>
                  <p>looking for open app windows you can share.</p>
                </div>
              )}
              {error && (
                <div className="live-room__empty live-room__empty--error">
                  <ShieldAlert size={30} />
                  <h3>{permissionBlocked ? "screen permission needed" : "source unavailable"}</h3>
                  <p>{permissionBlocked ? "allow screen recording for aios, then retry source scan." : error}</p>
                </div>
              )}
            </div>
          </div>

          <div className="live-room__dock">
            <button type="button" title="mic status" disabled={permissions.mic !== "granted"}>
              <Mic size={16} />
              <span>mic</span>
            </button>
            <button type="button" title="camera preview" disabled={permissions.camera !== "granted"}>
              <Camera size={16} />
              <span>camera</span>
            </button>
            <div ref={pickerRef} className="live-room__picker">
              <button
                type="button"
                title="share window"
                onClick={() => {
                  setPickerOpen((o) => !o);
                  if (!pickerOpen) refreshWindows();
                }}
              >
                <MonitorUp size={16} />
                <span>share window</span>
              </button>
              {pickerOpen && (
                <div className="live-room__picker-menu">
                  <div className="live-room__picker-search">
                    <Search size={13} />
                    <input
                      ref={searchRef}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="filter windows"
                    />
                    <button type="button" title="refresh windows" onClick={refreshWindows}>
                      {loadingList ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                    </button>
                  </div>
                  <div className="live-room__picker-list">
                    {groups.length === 0 ? (
                      <div className="live-room__picker-empty">{loadingList ? "scanning..." : "no windows found"}</div>
                    ) : (
                      groups.map((g) => (
                        <div key={g.app}>
                          <div className="live-room__picker-group">{g.app}</div>
                          {g.windows.map((w) => (
                            <button key={w.window_id} type="button" onMouseDown={(e) => (e.preventDefault(), pickWindow(w))}>
                              <span>{w.window_title || "untitled window"}</span>
                              <small>#{w.window_id}</small>
                            </button>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
            <button type="button" title="record" disabled={!controls.canStartRecording} onClick={() => setStatus("recording")}>
              <Circle size={16} />
              <span>record</span>
            </button>
            <button type="button" title="pause recording" disabled={status !== "recording"} onClick={() => setStatus("paused")}>
              <Pause size={16} />
              <span>pause</span>
            </button>
            <button type="button" title="stop capture" disabled={!controls.canStopRecording} onClick={() => setStatus("saved")}>
              <Square size={16} />
              <span>stop</span>
            </button>
          </div>
        </div>

        <aside className="live-room__rail">
          <div className="live-room__rail-card live-room__rail-card--health">
            <div className="live-room__rail-title">
              <Radio size={14} />
              health
            </div>
            <div className="live-room__health-row"><span>screen</span><b>{permissions.screen}</b></div>
            <div className="live-room__health-row"><span>mic</span><b>{permissions.mic}</b></div>
            <div className="live-room__health-row"><span>camera</span><b>{permissions.camera}</b></div>
            {!permissionSummary.canRecord && <p>record unlocks after screen and mic are ready.</p>}
          </div>
          {rail.map(([title, items]) => (
            <div key={title} className="live-room__rail-card">
              <div className="live-room__rail-title">
                {title === "sources" || title === "selected window" ? <MousePointer2 size={14} /> : <Wand2 size={14} />}
                {title}
              </div>
              <ul>
                {items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
          <div className="live-room__rail-card">
            <div className="live-room__rail-title">
              <Video size={14} />
              session
            </div>
            <p>{sessionId ?? "new session"}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
