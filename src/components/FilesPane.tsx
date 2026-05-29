/** Files pane — a lightweight file browser. Navigate dirs, open files in the
 *  default app, and DRAG any file/folder onto a terminal or oracle pane to drop
 *  its path into that session (dataTransfer carries the absolute path). Backed
 *  by the Rust `read_dir` command. */
import { useCallback, useEffect, useMemo, useState } from "react";

import { openPath } from "@tauri-apps/plugin-opener";
import { ChevronRight, File, Folder, Home, RefreshCw } from "lucide-react";

import { homeDir, readDir, type DirEntry } from "../lib/fs";

export function FilesPane() {
  const [cwd, setCwd] = useState<string>("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (path: string) => {
    setError(null);
    setLoading(true);
    try {
      const resolved = path || (await homeDir());
      const list = await readDir(resolved);
      setCwd(resolved);
      setEntries(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load("");
  }, [load]);

  const goUp = () => {
    const parent = cwd.replace(/\/[^/]+\/?$/, "") || "/";
    load(parent);
  };

  const crumbs = cwd.split("/").filter(Boolean);

  // Dirs first, then files, each alphabetical (case-insensitive).
  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      }),
    [entries],
  );
  const counts = useMemo(() => {
    const dirs = entries.filter((e) => e.is_dir).length;
    return { dirs, files: entries.length - dirs };
  }, [entries]);

  return (
    <div className="flex h-full min-h-0 flex-col text-[13px]">
      {/* breadcrumb */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-2 text-[var(--color-muted)]">
        <button onClick={() => load("")} className="rounded p-1 hover:text-[var(--color-text)]" title="Home">
          <Home size={13} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {crumbs.map((c, i) => (
            <span key={i} className="flex shrink-0 items-center gap-1">
              <ChevronRight size={11} className="opacity-40" />
              <button
                onClick={() => load("/" + crumbs.slice(0, i + 1).join("/"))}
                className="truncate hover:text-[var(--color-text)]"
              >
                {c}
              </button>
            </span>
          ))}
        </div>
        <button
          onClick={() => load(cwd)}
          className="rounded p-1 hover:text-[var(--color-text)]"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && <p className="px-3 py-2 text-[12px] text-[var(--color-danger)]">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {cwd !== "/" && (
          <button
            onClick={goUp}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-muted)] hover:bg-[var(--color-panel-2)]"
          >
            <Folder size={14} className="text-[var(--color-accent)]/70" /> ..
          </button>
        )}
        {sorted.map((e) => (
          <div
            key={e.path}
            draggable
            onDragStart={(ev) => {
              ev.dataTransfer.setData("text/plain", e.path);
              ev.dataTransfer.setData("application/x-aios-path", e.path);
              ev.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => (e.is_dir ? load(e.path) : openPath(e.path).catch(() => {}))}
            className="group flex w-full cursor-grab items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--color-panel-2)] active:cursor-grabbing"
            title={`${e.path}\n(drag onto a terminal to insert the path)`}
          >
            {e.is_dir ? (
              <Folder size={14} className="shrink-0 text-[var(--color-accent)]/80" />
            ) : (
              <File size={14} className="shrink-0 text-[var(--color-muted)]" />
            )}
            <span className="truncate text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
              {e.name}
            </span>
          </div>
        ))}
        {entries.length === 0 && !error && !loading && (
          <p className="px-3 py-2 text-[12px] text-[var(--color-muted)]/60">empty</p>
        )}
      </div>

      {/* footer count */}
      <div className="flex h-6 shrink-0 items-center justify-between border-t border-[var(--color-border)] px-3 text-[10px] text-[var(--color-faint)]">
        <span>
          {counts.dirs} folders · {counts.files} files
        </span>
        <span>drag → terminal</span>
      </div>
    </div>
  );
}
