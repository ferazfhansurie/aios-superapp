/**
 * The oracle roster — the fleet of bridge-managed oracle sessions, plus an
 * all-tmux attach surface. Master oracle is pinned top, crowned, undeletable.
 * Full CRUD: create / rename / delete (delete is two-click-to-confirm).
 * Self-polls so spawns/kills elsewhere reflect automatically.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

import {
  createOracle,
  deleteOracle,
  killTmuxSession,
  listOracles,
  listTmuxSessions,
  renameOracle,
  type OracleInfo,
  type TmuxSession,
} from "../lib/pty";
import { isTauriRuntime } from "../lib/tauri";
import { SidebarUsage } from "./SidebarUsage";

interface Props {
  iconsOnly?: boolean;
  onAttachOracle: (identity: string) => void;
  onAttachTmux: (socket: string, session: string) => void;
  moneyAgentsSlot?: ReactNode;
  chatpaneAgentsOnly?: boolean;
}

/**
 * firaz's load-bearing primary oracle. NOT the master — but his WhatsApp routes
 * to `aios-firaz`, so deleting it silently breaks routing. Gets a distinct,
 * explicitly-warned confirm path that can't be fat-fingered. Keep in sync with
 * `AIOS_PRIMARY_ORACLE` / `primary_oracle_identity()` in oracles.rs.
 */
const PRIMARY_ORACLE_IDENTITY = "firaz";

const HIDDEN_KEY = "aios.hiddenOracles";
const loadHidden = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]"));
  } catch {
    return new Set();
  }
};

const COLLAPSE_KEY = "aios.agentsCollapsed";

export function OracleRoster({
  iconsOnly = false,
  onAttachOracle,
  onAttachTmux,
  moneyAgentsSlot,
  chatpaneAgentsOnly = false,
}: Props) {
  const nativeReady = isTauriRuntime();
  const [oracles, setOracles] = useState<OracleInfo[]>([]);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [spawning, setSpawning] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const toggleHidden = useCallback((identity: string, hide: boolean) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (hide) next.add(identity);
      else next.delete(identity);
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    if (!nativeReady) {
      setOracles([]);
      setSessions([]);
      setLoading(false);
      return;
    }
    try {
      const [o, s] = await Promise.all([listOracles(), listTmuxSessions()]);
      setOracles(o);
      setSessions(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [nativeReady]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Non-oracle sessions only (oracles already live in the roster above).
  const otherSessions = sessions.filter((s) => !s.is_oracle);
  // Master is never hideable; everything else honors the hidden set.
  const visibleOracles = oracles.filter((o) => !hidden.has(o.identity));
  const hiddenOracles = oracles.filter((o) => hidden.has(o.identity));
  // Is the primary (firaz) oracle running? If not, offer a one-tap spawn —
  // create_oracle runs the bridge's oracle-spawn.sh to bring up the real
  // aios-firaz working session, then we attach to it.
  const primaryRunning = oracles.some((o) => o.identity === PRIMARY_ORACLE_IDENTITY);
  const spawnPrimary = async () => {
    setSpawning(true);
    setError(null);
    try {
      await createOracle(PRIMARY_ORACLE_IDENTITY);
      await refresh();
      onAttachOracle(PRIMARY_ORACLE_IDENTITY);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSpawning(false);
    }
  };

  if (iconsOnly) {
    if (chatpaneAgentsOnly) return <>{moneyAgentsSlot}</>;
    return (
      <div className="flex flex-col items-center gap-1 border-t border-[var(--color-border)] pt-2">
        <button
          onClick={toggleCollapsed}
          className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title={`agents (${oracles.length})`}
        >
          <Radio size={14} />
        </button>
        {!collapsed && nativeReady && !primaryRunning && (
          <button
            onClick={spawnPrimary}
            disabled={spawning}
            className="grid h-8 w-8 place-items-center rounded-md border border-dashed border-[var(--color-border)] text-[var(--color-accent)] transition-colors hover:border-[var(--color-accent)]/60 hover:bg-[var(--color-panel-2)] disabled:opacity-60"
            title="spawn my oracle"
          >
            {spawning ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}
          </button>
        )}
        {!collapsed &&
          visibleOracles.slice(0, 8).map((o) => (
            <button
              key={o.session}
              onClick={() => onAttachOracle(o.identity)}
              className="grid h-8 w-8 place-items-center rounded-md transition-colors hover:bg-[var(--color-panel-2)]"
              title={`attach ${o.display_name}`}
            >
              <span
                className={`status-dot ${
                  o.attached ? "status-dot--active" : o.running ? "status-dot--idle" : "status-dot--cold"
                }`}
              />
            </button>
          ))}
        {!collapsed &&
          otherSessions.slice(0, 4).map((s) => (
            <button
              key={`${s.socket}/${s.name}`}
              onClick={() => onAttachTmux(s.socket, s.name)}
              className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              title={`attach ${s.socket}:${s.name}`}
            >
              <Terminal size={13} />
            </button>
          ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ---- oracles ---- */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <button
            onClick={toggleCollapsed}
            className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)]"
            title={collapsed ? "show agents" : "hide agents"}
          >
            <ChevronRight size={11} className={`transition-transform ${collapsed ? "" : "rotate-90"}`} />
            agents
            {collapsed && oracles.length > 0 && (
              <span className="text-[var(--color-faint)]">({oracles.length})</span>
            )}
          </button>
          {!collapsed && nativeReady && !chatpaneAgentsOnly && (
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setCreating((v) => !v)}
                className="rounded p-1 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-accent)]"
                title="New oracle"
              >
                <Plus size={12} />
              </button>
              <button
                onClick={refresh}
                className="rounded p-1 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                title="Refresh"
              >
                <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              </button>
            </div>
          )}
        </div>

        {!collapsed && creating && (
          <CreateOracleForm
            onCancel={() => setCreating(false)}
            onCreate={async (name, launch) => {
              try {
                await createOracle(name, launch ? "claude --dangerously-skip-permissions" : undefined);
                setCreating(false);
                await refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          />
        )}

        {!collapsed && error && (
          <p className="text-[11px] leading-snug text-[var(--color-danger)]">{error}</p>
        )}

        {!collapsed && (
        <div className="flex flex-col gap-1">
          {nativeReady && !primaryRunning && !chatpaneAgentsOnly && (
            <button
              onClick={spawnPrimary}
              disabled={spawning}
              className="group flex items-center gap-2 rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-left transition-colors hover:border-[var(--color-accent)]/60 hover:bg-[var(--color-panel-2)] disabled:opacity-60"
              title="spawn your oracle (aios-firaz)"
            >
              {spawning ? (
                <RefreshCw size={13} className="shrink-0 animate-spin text-[var(--color-accent)]" />
              ) : (
                <Play size={13} className="shrink-0 text-[var(--color-accent)]" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-[var(--color-text)]">
                  {spawning ? "spawning firaz…" : "spawn my oracle"}
                </div>
                <div className="truncate text-[10px] text-[var(--color-faint)]">
                  {PRIMARY_ORACLE_IDENTITY} · offline
                </div>
              </div>
            </button>
          )}
          {!chatpaneAgentsOnly &&
            visibleOracles.map((o) => (
              <OracleRow
                key={o.session}
                oracle={o}
                onAttach={() => onAttachOracle(o.identity)}
                onHide={() => toggleHidden(o.identity, true)}
                onRename={async (to) => {
                  try {
                    await renameOracle(o.identity, to);
                    await refresh();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                }}
                onDelete={async (force) => {
                  try {
                    await deleteOracle(o.identity, force);
                    await refresh();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                }}
              />
            ))}
          {moneyAgentsSlot}
        </div>
        )}

        {!collapsed && hiddenOracles.length > 0 && !chatpaneAgentsOnly && (
          <div className="flex flex-col gap-1">
            <button
              onClick={() => setShowHidden((v) => !v)}
              className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-widest text-[var(--color-faint)] transition-colors hover:text-[var(--color-muted)]"
            >
              <ChevronRight size={11} className={`transition-transform ${showHidden ? "rotate-90" : ""}`} />
              hidden ({hiddenOracles.length})
            </button>
            {showHidden &&
              hiddenOracles.map((o) => (
                <div
                  key={o.session}
                  className="group flex items-center gap-2 rounded-md px-2 py-1.5 opacity-60 transition-opacity hover:opacity-100"
                >
                  <span className="status-dot status-dot--cold shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-muted)]">
                    {o.display_name}
                  </span>
                  <button
                    onClick={() => toggleHidden(o.identity, false)}
                    className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                    title="unhide"
                  >
                    <Eye size={12} />
                  </button>
                </div>
              ))}
          </div>
        )}

        {/* ---- live usage (5h / 7d rate windows) ---- */}
        {!collapsed && <SidebarUsage />}
      </div>

      {/* ---- all tmux sessions ---- */}
      {!collapsed && otherSessions.length > 0 && !chatpaneAgentsOnly && (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => setShowAll((v) => !v)}
            className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            <ChevronRight
              size={11}
              className={`transition-transform ${showAll ? "rotate-90" : ""}`}
            />
            all sessions ({otherSessions.length})
          </button>
          {showAll && (
            <div className="flex flex-col gap-1">
              {otherSessions.map((s) => (
                <TmuxRow
                  key={`${s.socket}/${s.name}`}
                  session={s}
                  onAttach={() => onAttachTmux(s.socket, s.name)}
                  onKill={async () => {
                    try {
                      await killTmuxSession(s.socket, s.name);
                      await refresh();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One oracle row — attach on click, rename inline, delete with confirm. */
function OracleRow({
  oracle,
  onAttach,
  onRename,
  onDelete,
  onHide,
}: {
  oracle: OracleInfo;
  onAttach: () => void;
  onRename: (to: string) => void;
  onDelete: (force: boolean) => void;
  onHide: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  // Distinct, harder-to-trigger confirm for the load-bearing primary oracle.
  const [confirmPrimary, setConfirmPrimary] = useState(false);
  const [draft, setDraft] = useState(oracle.identity);

  const isPrimary = oracle.identity === PRIMARY_ORACLE_IDENTITY;

  // Auto-clear the delete confirm if the user moves on.
  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(false), 2500);
    return () => clearTimeout(t);
  }, [confirmDel]);

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = draft.trim();
          if (v && v !== oracle.identity) onRename(v);
          setEditing(false);
        }}
        className="flex items-center gap-1 rounded-lg border border-[var(--color-accent)]/50 bg-[var(--color-panel-2)] px-2 py-1.5"
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setEditing(false)}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[var(--color-text)] outline-none"
        />
        <button
          type="submit"
          // Commit BEFORE the input's onBlur fires — otherwise clicking save
          // blurs the input, cancels edit-mode, and the rename never submits.
          onMouseDown={(e) => e.preventDefault()}
          className="text-[var(--color-success)]"
          title="save"
        >
          <Check size={13} />
        </button>
      </form>
    );
  }

  return (
    <div className="group flex flex-col gap-1 rounded-md px-2 py-1 transition-colors hover:bg-[var(--color-panel-2)]/60">
      <div className="flex items-center gap-2.5">
      <button onClick={onAttach} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        <span
          className={`status-dot shrink-0 ${
            oracle.attached
              ? "status-dot--active"
              : oracle.running
                ? "status-dot--idle"
                : "status-dot--cold"
          }`}
        />
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="truncate text-[12px] text-[var(--color-text)]">{oracle.display_name}</span>
          <span className="truncate text-[9px] text-[var(--color-faint)] opacity-0 transition-opacity group-hover:opacity-100">
            {oracle.running ? oracle.session : "not running"}
          </span>
        </div>
      </button>

      {/* row actions */}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={onHide}
          className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
          title="hide"
        >
          <EyeOff size={11} />
        </button>
        <button
          onClick={() => {
            setDraft(oracle.identity);
            setEditing(true);
          }}
          className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
          title="rename"
        >
          <Pencil size={11} />
        </button>
        {isPrimary ? (
          // Load-bearing oracle: no silent two-click. Toggles a distinct warned
          // panel below; the actual delete lives there as an explicit override.
          <button
            onClick={() => setConfirmPrimary((v) => !v)}
            className={`rounded p-1 hover:bg-[var(--color-danger)]/15 ${
              confirmPrimary
                ? "text-[var(--color-danger)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-danger)]"
            }`}
            title="delete (protected — breaks whatsapp routing)"
          >
            <Trash2 size={11} />
          </button>
        ) : confirmDel ? (
          <button
            onClick={() => onDelete(false)}
            className="rounded p-1 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/15"
            title="click again to confirm"
          >
            <Check size={12} />
          </button>
        ) : (
          <button
            onClick={() => setConfirmDel(true)}
            className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-danger)]"
            title="delete"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      </div>

      {isPrimary && confirmPrimary && (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2 py-1.5">
          <span className="text-[10px] leading-snug text-[var(--color-danger)]">
            deleting aios-firaz breaks your whatsapp routing
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                onDelete(true);
                setConfirmPrimary(false);
              }}
              className="rounded bg-[var(--color-danger)]/20 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger)]/30"
            >
              delete anyway
            </button>
            <button
              onClick={() => setConfirmPrimary(false)}
              className="rounded px-2 py-0.5 text-[10px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One all-tmux session row — attach on click, two-click-confirm kill. */
function TmuxRow({
  session,
  onAttach,
  onKill,
}: {
  session: TmuxSession;
  onAttach: () => void;
  onKill: () => void;
}) {
  const [confirmKill, setConfirmKill] = useState(false);

  // Auto-clear the kill confirm if the user moves on.
  useEffect(() => {
    if (!confirmKill) return;
    const t = setTimeout(() => setConfirmKill(false), 2500);
    return () => clearTimeout(t);
  }, [confirmKill]);

  return (
    <div className="group flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/30 px-2 py-1.5 transition-colors hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-panel-2)]">
      <button
        onClick={onAttach}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={`attach ${session.socket}:${session.name}`}
      >
        <Terminal size={12} className="shrink-0 text-[var(--color-faint)]" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-[11px] text-[var(--color-text-2)]">
            {session.name}
          </span>
          <span className="truncate text-[9px] text-[var(--color-faint)]">
            {session.socket} · {session.windows}w
          </span>
        </div>
        {session.attached && (
          <span className="status-dot status-dot--active shrink-0" title="attached" />
        )}
      </button>

      {confirmKill ? (
        <button
          onClick={onKill}
          className="shrink-0 rounded p-1 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/15"
          title="click again to confirm kill"
        >
          <Check size={12} />
        </button>
      ) : (
        <button
          onClick={() => setConfirmKill(true)}
          className="shrink-0 rounded p-1 text-[var(--color-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg)] hover:text-[var(--color-danger)] group-hover:opacity-100"
          title="kill session"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}

/** Inline "new oracle" form: name + optional launch-claude. */
function CreateOracleForm({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string, launchClaude: boolean) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [launch, setLaunch] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onCreate(name.trim(), launch);
      }}
      className="flex flex-col gap-2 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-panel-2)]/60 p-2"
    >
      <div className="flex items-center gap-1">
        <span className="font-mono text-[11px] text-[var(--color-faint)]">aios-</span>
        <input
          ref={ref}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
        />
        <button type="button" onClick={onCancel} className="text-[var(--color-muted)]" title="cancel">
          <X size={13} />
        </button>
      </div>
      <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-[var(--color-muted)]">
        <input
          type="checkbox"
          checked={launch}
          onChange={(e) => setLaunch(e.target.checked)}
          className="accent-[var(--color-accent)]"
        />
        launch claude on start
      </label>
      <button
        type="submit"
        disabled={!name.trim()}
        className="rounded-md bg-[var(--color-accent)] px-2 py-1 text-[11px] font-semibold text-[var(--color-bg)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
      >
        create
      </button>
    </form>
  );
}
