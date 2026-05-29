/** Files pane — two-panel explorer: list/tree + filter on the left, live file
 *  preview on the right (images & PDFs via the asset protocol, text/code/md
 *  inline). Rows stay draggable → drop onto a terminal to insert the path. */
import { useCallback, useEffect, useMemo, useState } from "react";

import { openPath } from "@tauri-apps/plugin-opener";
import {
  ChevronRight,
  ExternalLink,
  File as FileIcon,
  FileText,
  Folder,
  Home,
  Maximize2,
  RefreshCw,
  Search,
} from "lucide-react";

import { fileSrc, homeDir, readDir, readFilePreview, type DirEntry, type FilePreview } from "../lib/fs";

export function FilesPane({ onOpenFile }: { onOpenFile?: (path: string, name: string) => void }) {
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

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

  const select = useCallback(async (path: string) => {
    setSelected(path);
    setPreviewLoading(true);
    setPreview(null);
    try {
      setPreview(await readFilePreview(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const goUp = () => load(cwd.replace(/\/[^/]+\/?$/, "") || "/");
  const crumbs = cwd.split("/").filter(Boolean);

  const sorted = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return [...entries]
      .filter((e) => !f || e.name.toLowerCase().includes(f))
      .sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
  }, [entries, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)] text-[13px]">
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
        <button onClick={() => load(cwd)} className="rounded p-1 hover:text-[var(--color-text)]" title="Refresh">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* left: filter + list */}
        <div className="flex w-[44%] min-w-[240px] flex-col border-r border-[var(--color-border)]">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-2.5 py-1.5">
            <Search size={12} className="text-[var(--color-faint)]" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter files…"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
            />
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
                onClick={() => (e.is_dir ? load(e.path) : select(e.path))}
                className={`group flex w-full cursor-grab items-center gap-2 px-3 py-1.5 text-left transition-colors active:cursor-grabbing ${
                  selected === e.path ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel-2)]"
                }`}
                title={`${e.path}\n(drag onto a terminal to insert the path)`}
              >
                {e.is_dir ? (
                  <Folder size={14} className="shrink-0 text-[var(--color-accent)]/80" />
                ) : (
                  <FileIcon size={14} className="shrink-0 text-[var(--color-muted)]" />
                )}
                <span className="truncate text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
                  {e.name}
                </span>
              </div>
            ))}
            {sorted.length === 0 && !loading && (
              <p className="px-3 py-2 text-[12px] text-[var(--color-muted)]/60">
                {filter ? "no matches" : "empty"}
              </p>
            )}
          </div>
        </div>

        {/* right: preview */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!selected ? (
            <div className="grid h-full place-items-center text-[12px] text-[var(--color-faint)]">
              select a file to preview
            </div>
          ) : (
            <>
              <div className="flex h-8 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
                <span className="truncate font-mono text-[11px] text-[var(--color-text-2)]">
                  {preview?.name ?? selected.split("/").pop()}
                </span>
                <div className="flex items-center gap-0.5">
                  {onOpenFile && (
                    <button
                      onClick={() => onOpenFile(selected, preview?.name ?? selected.split("/").pop() ?? "file")}
                      className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                      title="Open in its own pane"
                    >
                      <Maximize2 size={12} />
                    </button>
                  )}
                  <button
                    onClick={() => openPath(selected).catch(() => {})}
                    className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                    title="Open externally"
                  >
                    <ExternalLink size={12} />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {previewLoading ? (
                  <div className="grid h-full place-items-center text-[12px] text-[var(--color-faint)]">
                    loading…
                  </div>
                ) : preview?.kind === "image" ? (
                  <div className="grid h-full place-items-center p-3">
                    <img src={fileSrc(selected)} alt={preview.name} className="max-h-full max-w-full object-contain" />
                  </div>
                ) : preview?.kind === "pdf" ? (
                  <iframe src={fileSrc(selected)} title={preview.name} className="h-full w-full border-0" />
                ) : preview?.kind === "text" ? (
                  <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-2)]">
                    {preview.text}
                    {preview.truncated && (
                      <span className="text-[var(--color-faint)]">{"\n\n… (truncated)"}</span>
                    )}
                  </pre>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--color-muted)]">
                    <FileText size={28} />
                    <span className="text-[12px]">
                      binary file{preview ? ` · ${(preview.size / 1024).toFixed(0)} KB` : ""}
                    </span>
                    <button
                      onClick={() => openPath(selected).catch(() => {})}
                      className="rounded-md border border-[var(--color-border)] px-3 py-1 text-[11px] hover:border-[var(--color-accent)]/50"
                    >
                      open externally
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
