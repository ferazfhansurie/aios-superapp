/** Database pane — one home for every data source. The file-backed memory
 *  vault is the first "connection" (table + graph + CRUD via MemoryView); any
 *  number of external Postgres/Neon + MySQL connections can be added and browsed
 *  (schema → table → rows + ad-hoc SQL) right alongside it.
 *
 *  Layout: connections rail (left) | active source (right). */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Brain,
  Database,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Table2,
  Trash2,
  X,
} from "lucide-react";

import {
  dbAddConnection,
  dbDeleteRow,
  dbInsertRow,
  dbListConnections,
  dbListTables,
  dbQuery,
  dbRemoveConnection,
  dbTableColumns,
  dbTableRows,
  dbTestConnection,
  dbUpdateRow,
  type ColumnInfo,
  type ConnMeta,
  type DbKind,
  type QueryResult,
  type TableInfo,
} from "../lib/db";
import { MemoryView } from "./MemoryPane";

const MEMORY_ID = "__memory__";

export function DatabasePane() {
  const [conns, setConns] = useState<ConnMeta[]>([]);
  const [activeId, setActiveId] = useState<string>(MEMORY_ID);
  const [adding, setAdding] = useState(false);

  const loadConns = useCallback(async () => {
    try {
      setConns(await dbListConnections());
    } catch {
      /* backend may not expose it yet — keep memory vault working */
    }
  }, []);

  useEffect(() => {
    loadConns();
  }, [loadConns]);

  const active = conns.find((c) => c.id === activeId) ?? null;

  return (
    <div className="flex h-full min-h-0 w-full bg-[var(--color-bg)] text-[13px] text-[var(--color-text)]">
      {/* connections rail */}
      <div className="flex w-[200px] shrink-0 min-h-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 text-[var(--color-muted)]">
          <Database size={13} className="text-[var(--color-accent)]" />
          <span className="font-mono text-[11px] lowercase">databases</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {/* built-in memory vault */}
          <RailItem
            icon={<Brain size={13} />}
            label="memory vault"
            sub="local · markdown"
            active={activeId === MEMORY_ID}
            onClick={() => setActiveId(MEMORY_ID)}
          />

          <div className="mt-2 px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
            connections
          </div>
          {conns.map((c) => (
            <RailItem
              key={c.id}
              icon={<Database size={13} />}
              label={c.name}
              sub={`${c.kind} · ${c.target}`}
              active={activeId === c.id}
              onClick={() => setActiveId(c.id)}
              onRemove={async () => {
                if (!confirm(`remove connection “${c.name}”?`)) return;
                await dbRemoveConnection(c.id);
                if (activeId === c.id) setActiveId(MEMORY_ID);
                loadConns();
              }}
            />
          ))}
          {conns.length === 0 && (
            <p className="px-3 py-1 text-[11px] text-[var(--color-faint)]">no external dbs yet</p>
          )}
        </div>
        <button
          onClick={() => setAdding(true)}
          className="flex shrink-0 items-center gap-1.5 border-t border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        >
          <Plus size={13} /> add connection
        </button>
      </div>

      {/* active source */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {activeId === MEMORY_ID ? <MemoryView /> : active ? <SqlView conn={active} /> : null}
      </div>

      {adding && (
        <AddConnectionModal
          onClose={() => setAdding(false)}
          onAdded={(m) => {
            setAdding(false);
            loadConns();
            setActiveId(m.id);
          }}
        />
      )}
    </div>
  );
}

function RailItem({
  icon,
  label,
  sub,
  active,
  onClick,
  onRemove,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  active: boolean;
  onClick: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`group mx-1 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 ${
        active ? "bg-[var(--color-accent-soft)] text-[var(--color-text)]" : "hover:bg-[var(--color-panel-2)] text-[var(--color-text-2)]"
      }`}
    >
      <span className="shrink-0 text-[var(--color-accent)]">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px]">{label}</div>
        <div className="truncate text-[10px] text-[var(--color-faint)]">{sub}</div>
      </div>
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="shrink-0 text-[var(--color-faint)] opacity-0 transition-opacity hover:text-[var(--color-danger)] group-hover:opacity-100"
          title="remove"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}


// ════════════════════════════════════════════════════════════════════════
// SqlView — browse + edit one external connection: table list (left), a row
// grid (center), and a row editor (right) for create / update / delete. An
// ad-hoc SQL box sits on top. Row CRUD is postgres-only for now.
// ════════════════════════════════════════════════════════════════════════
interface RowDraft {
  /** null = inserting a new row; otherwise the primary key of the row edited. */
  pk: Record<string, unknown> | null;
  values: Record<string, string | null>;
}

function SqlView({ conn }: { conn: ConnMeta }) {
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [tablesErr, setTablesErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState<TableInfo | null>(null);
  const [cols, setCols] = useState<ColumnInfo[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [resultErr, setResultErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sql, setSql] = useState("");
  const [draft, setDraft] = useState<RowDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const canEdit = conn.kind === "postgres";
  const pkCols = useMemo(() => cols.filter((c) => c.is_pk).map((c) => c.name), [cols]);

  const loadTables = useCallback(async () => {
    setTablesErr(null);
    setTables(null);
    try {
      setTables(await dbListTables(conn.id));
    } catch (e) {
      setTablesErr(e instanceof Error ? e.message : String(e));
    }
  }, [conn.id]);

  useEffect(() => {
    setSel(null);
    setResult(null);
    setResultErr(null);
    setSql("");
    setDraft(null);
    setCols([]);
    loadTables();
  }, [conn.id, loadTables]);

  const refreshRows = useCallback(
    async (t: TableInfo) => {
      setLoading(true);
      setResultErr(null);
      try {
        setResult(await dbTableRows(conn.id, t.schema, t.name, 200, 0));
      } catch (e) {
        setResultErr(e instanceof Error ? e.message : String(e));
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [conn.id],
  );

  const openTable = async (t: TableInfo) => {
    setSel(t);
    setDraft(null);
    setSql(`SELECT * FROM ${t.schema}.${t.name} LIMIT 200`);
    setCols([]);
    if (canEdit) {
      dbTableColumns(conn.id, t.schema, t.name)
        .then(setCols)
        .catch(() => setCols([]));
    }
    refreshRows(t);
  };

  const runSql = async () => {
    if (!sql.trim()) return;
    setLoading(true);
    setResultErr(null);
    try {
      setResult(await dbQuery(conn.id, sql));
    } catch (e) {
      setResultErr(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const toStr = (v: unknown): string | null =>
    v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v);

  const startEdit = (row: Record<string, unknown>) => {
    if (!canEdit || pkCols.length === 0) return;
    const pk: Record<string, unknown> = {};
    pkCols.forEach((c) => (pk[c] = row[c]));
    const values: Record<string, string | null> = {};
    cols.forEach((c) => (values[c.name] = toStr(row[c.name])));
    setDraft({ pk, values });
  };

  const startInsert = () => {
    if (!canEdit || !sel) return;
    const values: Record<string, string | null> = {};
    cols.forEach((c) => (values[c.name] = null));
    setDraft({ pk: null, values });
  };

  const saveDraft = async () => {
    if (!draft || !sel) return;
    setBusy(true);
    setNotice(null);
    try {
      if (draft.pk) {
        // only send non-pk columns as changes.
        const changes: Record<string, unknown> = {};
        cols.forEach((c) => {
          if (!c.is_pk) changes[c.name] = draft.values[c.name];
        });
        const n = await dbUpdateRow(conn.id, sel.schema, sel.name, draft.pk, changes);
        setNotice(`${n} row(s) updated`);
      } else {
        // omit empty columns that carry a default — let the DB fill them.
        const values: Record<string, unknown> = {};
        cols.forEach((c) => {
          const v = draft.values[c.name];
          if (v === null && c.has_default) return;
          values[c.name] = v;
        });
        const n = await dbInsertRow(conn.id, sel.schema, sel.name, values);
        setNotice(`${n} row(s) inserted`);
      }
      setDraft(null);
      await refreshRows(sel);
    } catch (e) {
      setNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteRow = async (row: Record<string, unknown>) => {
    if (!canEdit || !sel || pkCols.length === 0) return;
    const pk: Record<string, unknown> = {};
    pkCols.forEach((c) => (pk[c] = row[c]));
    if (!confirm(`delete this row from ${sel.name}?\n${JSON.stringify(pk)}`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const n = await dbDeleteRow(conn.id, sel.schema, sel.name, pk);
      setNotice(`${n} row(s) deleted`);
      await refreshRows(sel);
    } catch (e) {
      setNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const shownTables = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (tables ?? []).filter((t) => !f || `${t.schema}.${t.name}`.toLowerCase().includes(f));
  }, [tables, filter]);

  const editable = canEdit && pkCols.length > 0;

  return (
    <div className="flex min-h-0 flex-1">
      {/* tables list */}
      <div className="flex w-[220px] shrink-0 min-h-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2.5 text-[var(--color-muted)]">
          <Plug size={12} className="text-[var(--color-success)]" />
          <span className="truncate font-mono text-[11px]">{conn.name}</span>
          <button onClick={loadTables} className="ml-auto text-[var(--color-faint)] hover:text-[var(--color-text)]" title="refresh">
            <RefreshCw size={11} />
          </button>
        </div>
        <div className="shrink-0 border-b border-[var(--color-border)] px-2 py-1">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter tables…"
            className="w-full bg-transparent text-[11px] text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {tablesErr && <p className="px-2.5 py-2 text-[11px] text-[var(--color-danger)]">{tablesErr}</p>}
          {!tables && !tablesErr && <p className="px-2.5 py-2 text-[11px] text-[var(--color-faint)]">connecting…</p>}
          {shownTables.map((t) => (
            <button
              key={`${t.schema}.${t.name}`}
              onClick={() => openTable(t)}
              className={`flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[12px] ${
                sel?.schema === t.schema && sel?.name === t.name
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-text)]"
                  : "text-[var(--color-text-2)] hover:bg-[var(--color-panel-2)]"
              }`}
              title={`${t.schema}.${t.name}`}
            >
              <Table2 size={12} className="shrink-0 text-[var(--color-faint)]" />
              <span className="truncate">{t.name}</span>
              {t.schema !== "public" && (
                <span className="ml-auto shrink-0 text-[9px] text-[var(--color-faint)]">{t.schema}</span>
              )}
            </button>
          ))}
          {tables && shownTables.length === 0 && (
            <p className="px-2.5 py-2 text-[11px] text-[var(--color-faint)]">{filter ? "no matches" : "no tables"}</p>
          )}
        </div>
      </div>

      {/* query + grid */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--color-border)] bg-[var(--color-pane)] p-2">
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") runSql();
            }}
            rows={2}
            spellCheck={false}
            placeholder="SELECT … — ⌘⏎ to run"
            className="min-h-0 flex-1 resize-y rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 font-mono text-[11px] leading-relaxed focus:border-[var(--color-accent)]/60 focus:outline-none"
          />
          <div className="flex shrink-0 flex-col gap-1">
            <button
              onClick={runSql}
              disabled={loading}
              className="flex items-center justify-center gap-1 rounded bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
              title="run (⌘⏎)"
            >
              <Play size={12} /> run
            </button>
            {sel && editable && (
              <button
                onClick={startInsert}
                className="flex items-center justify-center gap-1 rounded border border-[var(--color-border)] px-2.5 py-1 text-[11px] hover:border-[var(--color-accent)]/50"
                title="insert row"
              >
                <Plus size={12} /> row
              </button>
            )}
          </div>
        </div>
        {notice && (
          <div className={`shrink-0 px-3 py-1 text-[11px] ${notice.startsWith("✗") ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
            {notice}
          </div>
        )}
        {sel && canEdit && pkCols.length === 0 && cols.length > 0 && (
          <div className="shrink-0 px-3 py-1 text-[10px] text-[var(--color-faint)]">
            no primary key on this table — rows are read-only
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="grid h-full place-items-center text-[12px] text-[var(--color-faint)]">running…</div>
          ) : resultErr ? (
            <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] text-[var(--color-danger)]">{resultErr}</pre>
          ) : result ? (
            <ResultGrid
              result={result}
              editable={editable}
              onEdit={editable ? startEdit : undefined}
              onDelete={editable ? deleteRow : undefined}
            />
          ) : (
            <div className="grid h-full place-items-center text-[12px] text-[var(--color-faint)]">
              select a table or run a query
            </div>
          )}
        </div>
      </div>

      {/* row editor */}
      {draft && sel && (
        <RowEditor
          draft={draft}
          cols={cols}
          busy={busy}
          onChange={setDraft}
          onSave={saveDraft}
          onCancel={() => setDraft(null)}
        />
      )}
    </div>
  );
}

function ResultGrid({
  result,
  editable,
  onEdit,
  onDelete,
}: {
  result: QueryResult;
  editable: boolean;
  onEdit?: (row: Record<string, unknown>) => void;
  onDelete?: (row: Record<string, unknown>) => void;
}) {
  if (result.affected != null && result.columns.length === 0) {
    return <p className="p-3 text-[12px] text-[var(--color-text-2)]">{result.affected} row(s) affected</p>;
  }
  if (result.rows.length === 0) {
    return <p className="p-3 text-[12px] text-[var(--color-faint)]">0 rows</p>;
  }
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };
  return (
    <table className="border-collapse text-[11px]">
      <thead className="sticky top-0 z-10 bg-[var(--color-panel)] text-[var(--color-muted)]">
        <tr className="border-b border-[var(--color-border)]">
          {editable && <th className="w-14" />}
          {result.columns.map((c) => (
            <th key={c} className="whitespace-nowrap border-r border-[var(--color-border)]/40 px-3 py-1.5 text-left font-medium">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, i) => (
          <tr key={i} className="group border-b border-[var(--color-border)]/30 hover:bg-[var(--color-panel-2)]">
            {editable && (
              <td className="whitespace-nowrap px-1.5 py-1">
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button onClick={() => onEdit?.(row)} className="text-[var(--color-faint)] hover:text-[var(--color-accent)]" title="edit row">
                    <Pencil size={11} />
                  </button>
                  <button onClick={() => onDelete?.(row)} className="text-[var(--color-faint)] hover:text-[var(--color-danger)]" title="delete row">
                    <Trash2 size={11} />
                  </button>
                </div>
              </td>
            )}
            {result.columns.map((c) => {
              const v = row[c];
              const isNull = v === null || v === undefined;
              return (
                <td
                  key={c}
                  onDoubleClick={() => editable && onEdit?.(row)}
                  className={`max-w-[360px] truncate border-r border-[var(--color-border)]/20 px-3 py-1 font-mono ${
                    isNull ? "text-[var(--color-faint)] italic" : "text-[var(--color-text-2)]"
                  }`}
                  title={cell(v)}
                >
                  {isNull ? "null" : cell(v)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Right-side panel to insert or edit a single row, one field per column. */
function RowEditor({
  draft,
  cols,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: RowDraft;
  cols: ColumnInfo[];
  busy: boolean;
  onChange: (d: RowDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const setVal = (name: string, v: string | null) =>
    onChange({ ...draft, values: { ...draft.values, [name]: v } });
  const inserting = draft.pk === null;
  return (
    <div className="flex w-[360px] shrink-0 min-h-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <span className="text-[12px] font-medium">{inserting ? "insert row" : "edit row"}</span>
        <button onClick={onCancel} className="text-[var(--color-faint)] hover:text-[var(--color-text)]">
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3 text-[12px]">
        {cols.map((c) => {
          const locked = !inserting && c.is_pk; // pk is the WHERE key when editing
          const v = draft.values[c.name];
          return (
            <label key={c.name} className="block">
              <span className="mb-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
                {c.name}
                <span className="lowercase text-[var(--color-faint)]/70">{c.udt}</span>
                {c.is_pk && <span className="text-[var(--color-accent)]">pk</span>}
                {c.has_default && inserting && <span className="text-[var(--color-faint)]/60">default</span>}
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  value={v ?? ""}
                  disabled={locked}
                  onChange={(e) => setVal(c.name, e.target.value)}
                  placeholder={v === null ? "null" : ""}
                  className={`min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-pane)] px-2 py-1 font-mono text-[11px] focus:border-[var(--color-accent)]/60 focus:outline-none ${
                    locked ? "opacity-60" : ""
                  } ${v === null ? "placeholder:italic placeholder:text-[var(--color-faint)]" : ""}`}
                />
                {c.nullable && !locked && (
                  <button
                    onClick={() => setVal(c.name, v === null ? "" : null)}
                    className={`shrink-0 rounded px-1.5 py-1 text-[9px] ${
                      v === null ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : "text-[var(--color-faint)] hover:text-[var(--color-text)]"
                    }`}
                    title="toggle NULL"
                  >
                    null
                  </button>
                )}
              </div>
            </label>
          );
        })}
        {cols.length === 0 && <p className="text-[var(--color-faint)]">no column info</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-border)] px-3 py-2">
        <button
          onClick={onSave}
          disabled={busy}
          className="flex items-center gap-1 rounded bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
        >
          <Save size={12} /> {inserting ? "insert" : "save"}
        </button>
        <button onClick={onCancel} className="rounded border border-[var(--color-border)] px-2.5 py-1 text-[11px] hover:border-[var(--color-accent)]/50">
          cancel
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// AddConnectionModal — name + kind + URL, with a test-before-save probe.
// ════════════════════════════════════════════════════════════════════════
function AddConnectionModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (m: ConnMeta) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<DbKind>("postgres");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const placeholder =
    kind === "postgres"
      ? "postgresql://user:pass@host:5432/db?sslmode=require"
      : "mysql://user:pass@host:3306/db";

  const test = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setStatus("testing…");
    try {
      await dbTestConnection(kind, url.trim());
      setStatus("✓ connection ok");
    } catch (e) {
      setStatus(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!name.trim() || !url.trim()) {
      setStatus("name and url required");
      return;
    }
    setBusy(true);
    setStatus("connecting…");
    try {
      const m = await dbAddConnection(name.trim(), kind, url.trim());
      onAdded(m);
    } catch (e) {
      setStatus(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[440px] rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="flex items-center gap-2 text-[13px] font-medium">
            <Database size={14} className="text-[var(--color-accent)]" /> add connection
          </span>
          <button onClick={onClose} className="text-[var(--color-faint)] hover:text-[var(--color-text)]">
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3 text-[12px]">
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-faint)]">name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="neon prod"
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-pane)] px-2 py-1 text-[12px] focus:border-[var(--color-accent)]/60 focus:outline-none"
              />
            </label>
            <label className="w-[120px]">
              <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-faint)]">kind</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as DbKind)}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-pane)] px-2 py-1 text-[12px] focus:border-[var(--color-accent)]/60 focus:outline-none"
              >
                <option value="postgres">postgres / neon</option>
                <option value="mysql">mysql</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-faint)]">connection url</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={placeholder}
              spellCheck={false}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-pane)] px-2 py-1 font-mono text-[11px] focus:border-[var(--color-accent)]/60 focus:outline-none"
            />
          </label>
          {status && (
            <p
              className={`text-[11px] ${
                status.startsWith("✓") ? "text-[var(--color-success)]" : status.startsWith("✗") ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"
              }`}
            >
              {status}
            </p>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={test}
            disabled={busy}
            className="rounded border border-[var(--color-border)] px-3 py-1 text-[11px] hover:border-[var(--color-accent)]/50 disabled:opacity-50"
          >
            test
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="rounded bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-50"
          >
            save
          </button>
        </div>
        <p className="mt-3 text-[10px] leading-relaxed text-[var(--color-faint)]">
          credentials are stored locally at ~/.aios/state/db-connections.json (0600) and never leave this machine.
        </p>
      </div>
    </div>
  );
}
