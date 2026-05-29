/** A single file rendered in its own pane — images & PDFs via the asset
 *  protocol, text/code/markdown inline. Spawned from the Files pane's
 *  "open in pane" action so any file can live as a standalone pane. */
import { useEffect, useState } from "react";

import { openPath } from "@tauri-apps/plugin-opener";
import { ExternalLink, FileText } from "lucide-react";

import { fileSrc, readFilePreview, type FilePreview } from "../lib/fs";

export function FileViewerPane({ path }: { path: string }) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    readFilePreview(path)
      .then((p) => alive && setPreview(p))
      .catch(() => alive && setPreview(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <span className="truncate font-mono text-[11px] text-[var(--color-text-2)]">
          {preview?.name ?? path.split("/").pop()}
        </span>
        <button
          onClick={() => openPath(path).catch(() => {})}
          className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="Open externally"
        >
          <ExternalLink size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="grid h-full place-items-center text-[12px] text-[var(--color-faint)]">loading…</div>
        ) : preview?.kind === "image" ? (
          <div className="grid h-full place-items-center p-3">
            <img src={fileSrc(path)} alt={preview.name} className="max-h-full max-w-full object-contain" />
          </div>
        ) : preview?.kind === "pdf" ? (
          <iframe src={fileSrc(path)} title={preview.name} className="h-full w-full border-0" />
        ) : preview?.kind === "text" ? (
          <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-2)]">
            {preview.text}
            {preview.truncated && <span className="text-[var(--color-faint)]">{"\n\n… (truncated)"}</span>}
          </pre>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--color-muted)]">
            <FileText size={28} />
            <span className="text-[12px]">binary file{preview ? ` · ${(preview.size / 1024).toFixed(0)} KB` : ""}</span>
            <button
              onClick={() => openPath(path).catch(() => {})}
              className="rounded-md border border-[var(--color-border)] px-3 py-1 text-[11px] hover:border-[var(--color-accent)]/50"
            >
              open externally
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
