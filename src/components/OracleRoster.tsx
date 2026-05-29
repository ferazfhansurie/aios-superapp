/**
 * The oracle roster — the fleet of bridge-managed oracle sessions, plus an
 * all-tmux attach surface. Master oracle is pinned top, crowned, undeletable.
 * Full CRUD: create / rename / delete (delete is two-click-to-confirm).
 * Self-polls so spawns/kills elsewhere reflect automatically.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Check,
  ChevronRight,
  Crown,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

import {
  createOracle,
  deleteOracle,
  listOracles,
  listTmuxSessions,
  renameOracle,
  type OracleInfo,
  type TmuxSession,
} from "../lib/pty";

interface Props {
  onAttachOracle: (identity: string) => void;
  onAttachTmux: (socket: string, session: string) => void;
}

const HIDDEN_KEY = "aios.hiddenOracles";
const loadHidden = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]"));
  } catch {
    return new Set();
  }
};

export function OracleRoster({ onAttachOracle, onAttachTmux }: Props) {
  const [oracles, setOracles] = useState<OracleInfo[]>([]);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);

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
    try {
      const [o, s] = await Promise.all([listOracles(), listTmuxSessions()]);
      setOracles(o);
      setSessions(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Non-oracle sessions only (oracles already live in the roster above).
  const otherSessions = sessions.filter((s) => !s.is_oracle);
  // Master is never hideable; everything else honors the hidden set.
  const visibleOracles = oracles.filter((o) => o.is_master || !hidden.has(o.identity));
  const hiddenOracles = oracles.filter((o) => !o.is_master && hidden.has(o.identity));

  return (
    <div className="flex flex-col gap-3">
      {/* ---- oracles ---- */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
            oracles
          </span>
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
        </div>

        {creating && (
          <CreateOracleForm
            onCancel={() => setCreating(false)}
            onCreate={async (name, launch) => {
              try {
                await createOracle(name, launch ? "claude" : undefined);
                setCreating(false);
                await refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          />
        )}

        {error && <p className="text-[11px] leading-snug text-[var(--color-danger)]">{error}</p>}

        <div className="flex flex-col gap-1">
          {visibleOracles.map((o) => (
            <OracleRow
              key={o.session}
              oracle={o}
              onAttach={() =>
                o.is_master ? onAttachTmux(o.socket, o.session) : onAttachOracle(o.identity)
              }
              onHide={() => toggleHidden(o.identity, true)}
              onRename={async (to) => {
                try {
                  await renameOracle(o.identity, to);
                  await refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
              onDelete={async () => {
                try {
                  await deleteOracle(o.identity);
                  await refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            />
          ))}
        </div>

        {hiddenOracles.length > 0 && (
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
      </div>

      {/* ---- all tmux sessions ---- */}
      {otherSessions.length > 0 && (
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
                <button
                  key={`${s.socket}/${s.name}`}
                  onClick={() => onAttachTmux(s.socket, s.name)}
                  className="group flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/30 px-2 py-1.5 text-left transition-colors hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-panel-2)]"
                  title={`attach ${s.socket}:${s.name}`}
                >
                  <Terminal size={12} className="shrink-0 text-[var(--color-faint)]" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[11px] text-[var(--color-text-2)]">
                      {s.name}
                    </span>
                    <span className="truncate text-[9px] text-[var(--color-faint)]">
                      {s.socket} · {s.windows}w
                    </span>
                  </div>
                  {s.attached && (
                    <span className="status-dot status-dot--active shrink-0" title="attached" />
                  )}
                </button>
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
  onDelete: () => void;
  onHide: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [draft, setDraft] = useState(oracle.identity);

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
        <button type="submit" className="text-[var(--color-success)]" title="save">
          <Check size={13} />
        </button>
      </form>
    );
  }

  return (
    <div
      className={`group flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors ${
        oracle.is_master
          ? "border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]"
          : "border-[var(--color-border)] bg-[var(--color-panel-2)]/40 hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-panel-2)]"
      }`}
    >
      <button onClick={onAttach} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        {oracle.is_master ? (
          <Crown size={13} className="shrink-0 text-[var(--color-accent)]" />
        ) : (
          <span
            className={`status-dot shrink-0 ${
              oracle.attached
                ? "status-dot--active"
                : oracle.running
                  ? "status-dot--idle"
                  : "status-dot--cold"
            }`}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 truncate text-[13px] text-[var(--color-text)]">
            {oracle.display_name}
            {oracle.is_master && (
              <span className="rounded bg-[var(--color-accent)]/20 px-1 py-px text-[8px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
                master
              </span>
            )}
          </span>
          <span className="truncate text-[10px] text-[var(--color-muted)]">
            {oracle.running ? oracle.session : "not running · click to start"}
          </span>
        </div>
      </button>

      {/* row actions */}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {!oracle.is_master && (
          <>
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
            {confirmDel ? (
              <button
                onClick={onDelete}
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
          </>
        )}
      </div>
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
