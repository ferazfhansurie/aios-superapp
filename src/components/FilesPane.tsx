/** Files pane — a lightweight file browser. Navigate dirs, open files in the
 *  default app. Backed by the Rust `read_dir` command. */
import { useCallback, useEffect, useState } from "react";

import { openPath } from "@tauri-apps/plugin-opener";
import { ChevronRight, File, Folder, Home } from "lucide-react";

import { homeDir, readDir, type DirEntry } from "../lib/fs";

export function FilesPane() {
  const [cwd, setCwd] = useState<string>("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    setError(null);
    try {
      const resolved = path || (await homeDir());
      const list = await readDir(resolved);
      setCwd(resolved);
      setEntries(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

  return (
    <div className="flex h-full min-h-0 flex-col text-[13px]">
      {/* breadcrumb */}
      <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--color-border)] px-2 text-[var(--color-muted)]">
        <button onClick={() => load("")} className="rounded p-1 hover:text-[var(--color-text)]" title="Home">
          <Home size={13} />
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
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

      {error && <p className="px-3 py-2 text-[12px] text-[var(--color-danger)]">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {cwd !== "/" && (
          <button
            onClick={goUp}
            className="flex w-full items-center gap-2 px-3 py-1 text-left text-[var(--color-muted)] hover:bg-[var(--color-panel-2)]"
          >
            <Folder size={14} className="text-[var(--color-accent)]/70" /> ..
          </button>
        )}
        {entries.map((e) => (
          <button
            key={e.path}
            onClick={() => (e.is_dir ? load(e.path) : openPath(e.path).catch(() => {}))}
            className="flex w-full items-center gap-2 truncate px-3 py-1 text-left transition-colors hover:bg-[var(--color-panel-2)]"
          >
            {e.is_dir ? (
              <Folder size={14} className="shrink-0 text-[var(--color-accent)]/80" />
            ) : (
              <File size={14} className="shrink-0 text-[var(--color-muted)]" />
            )}
            <span className="truncate text-[var(--color-text-2)]">{e.name}</span>
          </button>
        ))}
        {entries.length === 0 && !error && (
          <p className="px-3 py-2 text-[12px] text-[var(--color-muted)]/60">empty</p>
        )}
      </div>
    </div>
  );
}
