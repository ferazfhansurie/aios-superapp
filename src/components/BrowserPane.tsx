/** Browser pane — drives a NATIVE child webview (real WebKit, renders any site,
 *  no iframe blocking). Each pane owns its own webview keyed by `label`. The
 *  component is just the chrome (url bar + nav) plus a placeholder div whose
 *  on-screen rect the webview tracks. `active=false` (a modal is open, or the
 *  pane is hidden) shrinks the webview to 0 so HTML modals aren't occluded. */
import { useCallback, useEffect, useRef, useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Crosshair,
  ExternalLink,
  MessageSquarePlus,
  MoreVertical,
  Pin,
  Check,
  Plus,
  RotateCw,
  Smartphone,
  SquareDashedMousePointer,
  Trash2,
  Users,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import {
  browserBack,
  browserClearCookies,
  browserClose,
  browserCopySelection,
  browserCurrentUrl,
  browserDeviceMode,
  browserEnterAnnotate,
  browserExitAnnotate,
  browserForward,
  browserHide,
  browserNavigate,
  browserReload,
  browserScreenshot,
  browserSetBounds,
  browserShow,
  browserZoom,
  readClipboard,
  type BrowserAnnotation,
  type Rect,
} from "../lib/browser";
import { addLink } from "../lib/sidebar";
import { DEFAULT_PROFILE, addProfile, loadProfiles } from "../lib/profiles";
import { rememberUrl } from "../lib/browser-mem";

const ANNOT_SENTINEL = "AIOS_ANNOT:";
const ANNOT_POLL_MS = 700;

const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;

function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+/.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

const DEFAULT_URL = "https://google.com";

export function BrowserPane({
  label,
  active = true,
  initialUrl,
  initialProfile,
  memKey,
  onAnnotate,
  onProfileChange,
}: {
  label: string;
  active?: boolean;
  /** Optional starting url (e.g. a pinned-site sidebar item deep-links here). */
  initialUrl?: string;
  /** Stable id (pinned-site sidebar id) under which to remember this pane's last
   *  location, so reopening returns where it left off. Omit = no memory. */
  memKey?: string;
  /** Cookie-partition profile this pane opens in (lets a second/third Google
   *  account stay logged in alongside the first). Defaults to the shared store. */
  initialProfile?: string;
  /** Fired when an annotation or page-selection is captured (clipboard-bridge),
   *  with a formatted, chat-ready string. App wires this to the active chat. */
  onAnnotate?: (text: string) => void;
  /** Fired when the user switches this pane's profile, so App persists it on the
   *  pane model (the login sticks if the pane is reopened). */
  onProfileChange?: (profile: string) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const start = initialUrl ? normalizeUrl(initialUrl) : DEFAULT_URL;
  const [input, setInput] = useState(start);
  const [current, setCurrent] = useState(start);
  const [profile, setProfile] = useState(initialProfile || DEFAULT_PROFILE);
  const [profiles, setProfiles] = useState<string[]>(() => loadProfiles());
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [addingProfile, setAddingProfile] = useState(false);
  const [newProfile, setNewProfile] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [deviceMode, setDeviceMode] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Surfaces a browser_show failure instead of silently showing "loading…"
  // forever (the native child-webview can fail to attach on some platforms).
  const [showError, setShowError] = useState<string | null>(null);
  const shownRef = useRef(false);
  const inputFocusedRef = useRef(false);
  // last url we observed from the live webview — dedupes the poll so we only
  // persist + update the address bar on a real navigation.
  const lastUrlRef = useRef(start);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last clipboard payload we already consumed — so the poll only fires
  // `onAnnotate` once per fresh annotation, never re-emitting stale text.
  const lastAnnotRef = useRef<string | null>(null);
  // Latest `onAnnotate` without making it a poll-effect dependency.
  const onAnnotateRef = useRef(onAnnotate);
  onAnnotateRef.current = onAnnotate;

  const rect = useCallback((): Rect | null => {
    const el = slotRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, []);

  useEffect(() => {
    if (!active) {
      if (shownRef.current) browserHide(label).catch(() => {});
      return;
    }
    let raf = 0;
    const sync = () => {
      const r = rect();
      if (!r) return;
      if (!shownRef.current) {
        shownRef.current = true;
        browserShow(label, current, r, profile)
          .then(() => setShowError(null))
          .catch((e) => {
            shownRef.current = false; // allow a retry on the next sync tick
            setShowError(typeof e === "string" ? e : String(e));
          });
      } else {
        browserSetBounds(label, r).catch(() => {});
      }
    };
    raf = requestAnimationFrame(() => requestAnimationFrame(sync));
    const ro = new ResizeObserver(sync);
    if (slotRef.current) ro.observe(slotRef.current);
    window.addEventListener("resize", sync);
    const poll = setInterval(sync, 300);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", sync);
      clearInterval(poll);
    };
  }, [active, current, label, profile, rect]);

  // Poll the webview's REAL url (catches in-page navigation the address bar never
  // sees). On a real change: remember it (pinned sites resume here) and sync the
  // address bar — unless the user is mid-edit in it.
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (!shownRef.current) return;
      browserCurrentUrl(label)
        .then((u) => {
          if (!u || u === "about:blank" || u === lastUrlRef.current) return;
          lastUrlRef.current = u;
          rememberUrl(memKey, u);
          if (!inputFocusedRef.current) {
            setCurrent(u);
            setInput(u);
          }
        })
        .catch(() => {});
    };
    const poll = setInterval(tick, 1500);
    return () => clearInterval(poll);
  }, [active, label, memKey]);

  // Switch the pane to another cookie partition. The data store is fixed at
  // webview creation, so switching = destroy the current webview + let the show
  // effect recreate it in the new profile's jar (profile is in its deps).
  const switchProfile = useCallback(
    (next: string) => {
      setProfileMenuOpen(false);
      setAddingProfile(false);
      if (next === profile) return;
      browserClose(label).catch(() => {});
      shownRef.current = false;
      setProfile(next);
      onProfileChange?.(next);
    },
    [label, profile, onProfileChange],
  );

  const commitNewProfile = useCallback(() => {
    const name = addProfile(newProfile);
    setNewProfile("");
    if (!name) {
      setAddingProfile(false);
      return;
    }
    setProfiles(loadProfiles());
    switchProfile(name);
  }, [newProfile, switchProfile]);

  // Close the profile menu on outside click.
  useEffect(() => {
    if (!profileMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false);
        setAddingProfile(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [profileMenuOpen]);

  useEffect(() => {
    return () => {
      browserClose(label).catch(() => {});
      shownRef.current = false;
    };
  }, [label]);

  const go = useCallback(() => {
    const url = normalizeUrl(input);
    if (!url) return;
    setCurrent(url);
    setInput(url);
    if (shownRef.current) browserNavigate(label, url).catch(() => {});
  }, [input, label]);

  // Pin the current site to the sidebar (favicon resolved by the store from the
  // host). Label defaults to the hostname; the user can rename it in the rail.
  const pinSite = useCallback(() => {
    const url = current || normalizeUrl(input);
    if (!url) return;
    addLink(url);
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      /* keep raw */
    }
    setToast(`pinned ${host} to sidebar`);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, [current, input]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // Close the options menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const onScreenshot = useCallback(() => {
    const r = rect();
    if (!r) return;
    browserScreenshot(label, r)
      .then((path) => {
        const file = path.split("/").pop() ?? path;
        showToast(`saved ${file}`);
      })
      .catch((e) => showToast(typeof e === "string" ? e : "screenshot failed"));
  }, [label, rect, showToast]);

  const applyZoom = useCallback(
    (pct: number) => {
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pct));
      setZoom(clamped);
      browserZoom(label, clamped / 100).catch(() => {});
    },
    [label],
  );

  const toggleDeviceMode = useCallback(() => {
    const next = !deviceMode;
    setDeviceMode(next);
    browserDeviceMode(label, next).catch(() => {});
  }, [deviceMode, label]);

  const clearCookies = useCallback(() => {
    browserClearCookies(label).catch(() => {});
    setMenuOpen(false);
    showToast("cleared cookies + storage");
  }, [label, showToast]);

  // Turn a captured annotation/selection into one chat-ready line.
  const formatAnnotation = useCallback((a: BrowserAnnotation): string => {
    const note = a.note || "(no note)";
    if (a.tagName === "selection" || !a.selector) {
      return `selection: "${note}" (${a.url})`;
    }
    const text = a.text ? ` — element text: "${a.text}"` : "";
    return `annotation on ${a.selector}: "${note}"${text} (${a.url})`;
  }, []);

  // Read the clipboard, and if it carries a FRESH AIOS_ANNOT payload, emit it.
  // Returns true when an annotation was consumed (so the caller can exit mode).
  const consumeAnnotation = useCallback((): Promise<boolean> => {
    return readClipboard()
      .then((raw) => {
        if (!raw || !raw.startsWith(ANNOT_SENTINEL)) return false;
        if (raw === lastAnnotRef.current) return false; // already handled
        lastAnnotRef.current = raw;
        let parsed: BrowserAnnotation;
        try {
          parsed = JSON.parse(raw.slice(ANNOT_SENTINEL.length)) as BrowserAnnotation;
        } catch {
          return false;
        }
        onAnnotateRef.current?.(formatAnnotation(parsed));
        return true;
      })
      .catch(() => false);
  }, [formatAnnotation]);

  const exitAnnotate = useCallback(() => {
    setAnnotating(false);
    browserExitAnnotate(label).catch(() => {});
  }, [label]);

  const toggleAnnotate = useCallback(() => {
    if (annotating) {
      exitAnnotate();
      return;
    }
    // Snapshot current clipboard as already-seen so we don't grab a stale
    // AIOS_ANNOT left over from a previous session as if it were new.
    readClipboard()
      .then((raw) => {
        lastAnnotRef.current = raw && raw.startsWith(ANNOT_SENTINEL) ? raw : null;
      })
      .catch(() => {})
      .finally(() => {
        setAnnotating(true);
        browserEnterAnnotate(label)
          .then(() => showToast("annotate: click an element on the page"))
          .catch((e) => {
            setAnnotating(false);
            showToast(typeof e === "string" ? e : "annotate failed");
          });
      });
  }, [annotating, exitAnnotate, label, showToast]);

  // "Send selection to chat": copy the page's current text selection to the
  // clipboard (sentinel-tagged), then read it straight back and emit.
  const sendSelection = useCallback(() => {
    browserCopySelection(label)
      .then(() => new Promise((r) => setTimeout(r, 120))) // let clipboard settle
      .then(() => consumeAnnotation())
      .then((ok) => showToast(ok ? "selection sent to chat" : "no text selected"))
      .catch((e) => showToast(typeof e === "string" ? e : "selection failed"));
  }, [consumeAnnotation, label, showToast]);

  // While annotating, poll the clipboard for a submitted annotation, then exit.
  useEffect(() => {
    if (!annotating) return;
    let stop = false;
    const id = setInterval(() => {
      if (stop) return;
      consumeAnnotation().then((ok) => {
        if (ok && !stop) exitAnnotate();
      });
    }, ANNOT_POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [annotating, consumeAnnotation, exitAnnotate]);

  // Tear down annotate mode if the pane is hidden or unmounts.
  useEffect(() => {
    if (!active && annotating) exitAnnotate();
  }, [active, annotating, exitAnnotate]);
  useEffect(() => {
    return () => {
      browserExitAnnotate(label).catch(() => {});
    };
  }, [label]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-2">
        <NavBtn title="Back" onClick={() => browserBack(label).catch(() => {})}>
          <ArrowLeft size={14} />
        </NavBtn>
        <NavBtn title="Forward" onClick={() => browserForward(label).catch(() => {})}>
          <ArrowRight size={14} />
        </NavBtn>
        <NavBtn title="Reload" onClick={() => browserReload(label).catch(() => {})}>
          <RotateCw size={13} />
        </NavBtn>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
          className="flex min-w-0 flex-1 items-center"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => (inputFocusedRef.current = true)}
            onBlur={() => (inputFocusedRef.current = false)}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 font-mono text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/50"
            placeholder="search or enter url"
          />
        </form>
        <NavBtn title="Pin this site to the sidebar" onClick={pinSite}>
          <Pin size={13} />
        </NavBtn>
        <NavBtn title="Open in system browser" onClick={() => openUrl(current).catch(() => {})}>
          <ExternalLink size={13} />
        </NavBtn>
        <NavBtn title="Screenshot" onClick={onScreenshot}>
          <Camera size={13} />
        </NavBtn>
        <NavBtn title="Send selection to chat" onClick={sendSelection}>
          <MessageSquarePlus size={14} />
        </NavBtn>
        <button
          type="button"
          onClick={toggleAnnotate}
          title={annotating ? "Stop annotating" : "Annotate page → chat"}
          aria-pressed={annotating}
          className={
            annotating
              ? "rounded p-1.5 bg-[var(--color-accent)]/15 text-[var(--color-accent)] transition-colors"
              : "rounded p-1.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          }
        >
          {annotating ? (
            <Crosshair size={14} />
          ) : (
            <SquareDashedMousePointer size={14} />
          )}
        </button>
        <div ref={profileMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setProfileMenuOpen((o) => !o)}
            title="Account profile (separate logins)"
            className={
              profile === DEFAULT_PROFILE
                ? "flex items-center gap-1 rounded p-1.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                : "flex items-center gap-1 rounded px-1.5 py-1 bg-[var(--color-accent)]/15 text-[var(--color-accent)] transition-colors"
            }
          >
            <Users size={14} />
            {profile !== DEFAULT_PROFILE && (
              <span className="max-w-[72px] truncate text-[11px] font-medium">{profile}</span>
            )}
          </button>
          {profileMenuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] py-1 text-[12px] text-[var(--color-text)] shadow-lg">
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
                account profile
              </div>
              {profiles.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => switchProfile(p)}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-[var(--color-panel)]"
                >
                  <span className="truncate">{p === DEFAULT_PROFILE ? "default" : p}</span>
                  {p === profile && <Check size={13} className="text-[var(--color-accent)]" />}
                </button>
              ))}
              <div className="my-1 border-t border-[var(--color-border)]" />
              {addingProfile ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    commitNewProfile();
                  }}
                  className="px-2 py-1"
                >
                  <input
                    autoFocus
                    value={newProfile}
                    onChange={(e) => setNewProfile(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setAddingProfile(false);
                        setNewProfile("");
                      }
                    }}
                    placeholder="name e.g. work"
                    spellCheck={false}
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/50"
                  />
                </form>
              ) : (
                <MenuItem
                  icon={<Plus size={13} />}
                  label="New account…"
                  onClick={() => {
                    setAddingProfile(true);
                    setNewProfile("");
                  }}
                />
              )}
            </div>
          )}
        </div>
        <div ref={menuRef} className="relative">
          <NavBtn title="Options" onClick={() => setMenuOpen((o) => !o)}>
            <MoreVertical size={14} />
          </NavBtn>
          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] py-1 text-[12px] text-[var(--color-text)] shadow-lg">
              <MenuItem
                icon={<RotateCw size={13} />}
                label="Force reload"
                onClick={() => {
                  browserReload(label).catch(() => {});
                  setMenuOpen(false);
                }}
              />
              <MenuItem
                icon={<Smartphone size={13} />}
                label="Device toolbar"
                trailing={
                  <span
                    className={
                      deviceMode
                        ? "text-[10px] text-[var(--color-accent)]"
                        : "text-[10px] text-[var(--color-faint)]"
                    }
                  >
                    {deviceMode ? "on" : "off"}
                  </span>
                }
                onClick={toggleDeviceMode}
              />
              <div className="my-1 border-t border-[var(--color-border)]" />
              <div className="flex items-center justify-between px-3 py-1.5">
                <span className="text-[var(--color-muted)]">Zoom</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    title="Zoom out"
                    onClick={() => applyZoom(zoom - ZOOM_STEP)}
                    className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                  >
                    <ZoomOut size={13} />
                  </button>
                  <button
                    type="button"
                    title="Reset zoom"
                    onClick={() => applyZoom(100)}
                    className="min-w-[42px] rounded px-1 py-0.5 text-center text-[11px] tabular-nums text-[var(--color-text)] hover:bg-[var(--color-panel)]"
                  >
                    {zoom}%
                  </button>
                  <button
                    type="button"
                    title="Zoom in"
                    onClick={() => applyZoom(zoom + ZOOM_STEP)}
                    className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                  >
                    <ZoomIn size={13} />
                  </button>
                </div>
              </div>
              <div className="my-1 border-t border-[var(--color-border)]" />
              <MenuItem
                icon={<Trash2 size={13} />}
                label="Clear cookies"
                onClick={clearCookies}
              />
              <MenuItem
                icon={<Trash2 size={13} />}
                label="Clear cache"
                onClick={clearCookies}
              />
            </div>
          )}
        </div>
      </div>

      <div ref={slotRef} className="relative min-h-0 flex-1">
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-[11px] text-[var(--color-faint)]">
          {showError ? (
            <span className="max-w-md text-[var(--color-danger)]">
              native browser failed to load: {showError}
            </span>
          ) : (
            "loading native browser…"
          )}
        </div>
        {annotating && (
          <div className="pointer-events-none absolute left-1/2 top-2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-panel-2)] px-3 py-1 text-[11px] text-[var(--color-accent)] shadow-lg">
            <Crosshair size={12} />
            annotating… click an element, then describe it
          </div>
        )}
        {toast && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 z-50 -translate-x-1/2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-[11px] text-[var(--color-text)] shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  trailing,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[var(--color-text)] transition-colors hover:bg-[var(--color-panel)]"
    >
      <span className="text-[var(--color-muted)]">{icon}</span>
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  );
}

function NavBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded p-1.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
    >
      {children}
    </button>
  );
}
