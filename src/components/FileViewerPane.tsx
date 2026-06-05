/** A single file rendered in its own pane — images & PDFs via the asset
 *  protocol, text/code/markdown inline. Spawned from the Files pane's
 *  "open in pane" action so any file can live as a standalone pane. */
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { openPath } from "@tauri-apps/plugin-opener";
import { ExternalLink, FileText } from "lucide-react";

import { fileSrc, readFilePreview, type FilePreview } from "../lib/fs";
import { openFileInPane, openUrlInPane, registerPaneDropSink } from "../lib/paneBus";
import { isHttpPaneTarget, isPaneFileTarget, resolvePaneFileTarget, targetLabel } from "../lib/paneRouting";
import { OfficePreview } from "./OfficePreview";
import { PaneDropZone } from "./PaneDropZone";
import { reportDiag } from "../lib/diag";

export function FileViewerPane({ path, paneKey }: { path: string; paneKey?: string }) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loading, setLoading] = useState(true);

  // Drop a file → open it (deterministic, via paneForFile). Same rationale as
  // EditorPane: open rather than hot-swap the prop.
  const onDropFile = useCallback((raw: string) => {
    const s = raw.trim();
    if (!s || /^https?:\/\//i.test(s)) return;
    openFileInPane(s, s.split("/").pop() ?? s);
  }, []);
  useEffect(() => {
    if (!paneKey) return;
    return registerPaneDropSink(paneKey, (paths) => {
      const first = paths.find((p) => p && p.trim() && !/^https?:\/\//i.test(p));
      if (!first) return false;
      onDropFile(first);
      return true;
    });
  }, [paneKey, onDropFile]);

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
    <PaneDropZone onPath={onDropFile} label="drop file to open">
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <span className="truncate font-mono text-[11px] text-[var(--color-text-2)]">
          {preview?.name ?? path.split("/").pop()}
        </span>
        <button
          onClick={() => openPath(path).catch((e) => reportDiag("fileviewer.open", e, { action: "openPath" }))}
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
        ) : preview?.kind === "office" ? (
          <OfficePreview path={path} name={preview.name} />
        ) : preview?.kind === "video" ? (
          <video
            src={fileSrc(path)}
            controls
            className="h-full w-full bg-black"
            controlsList="nodownload"
          />
        ) : preview?.kind === "text" ? (
          isMarkdown(path) ? (
            <MarkdownDoc text={preview.text ?? ""} path={path} truncated={preview.truncated} />
          ) : (
            <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-2)]">
              {preview.text}
              {preview.truncated && <span className="text-[var(--color-faint)]">{"\n\n… (truncated)"}</span>}
            </pre>
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--color-muted)]">
            <FileText size={28} />
            <span className="text-[12px]">binary file{preview ? ` · ${(preview.size / 1024).toFixed(0)} KB` : ""}</span>
            <button
              onClick={() => openPath(path).catch((e) => reportDiag("fileviewer.open", e, { action: "openPath" }))}
              className="rounded-md border border-[var(--color-border)] px-3 py-1 text-[11px] hover:border-[var(--color-accent)]/50"
            >
              open externally
            </button>
          </div>
        )}
      </div>
    </div>
    </PaneDropZone>
  );
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

function MarkdownDoc({ text, path, truncated }: { text: string; path: string; truncated: boolean }) {
  return (
    <div className="mx-auto max-w-3xl px-5 py-4 font-sans text-[13px] leading-relaxed text-[var(--color-text-2)]">
      {text.split("\n").map((line, i) => {
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          return (
            <div
              key={i}
              className={`mt-3 mb-1 font-semibold text-[var(--color-text)] ${
                level === 1 ? "text-[20px]" : level === 2 ? "text-[17px]" : "text-[14px]"
              }`}
            >
              <InlineDoc text={heading[2]} basePath={path} />
            </div>
          );
        }
        const bullet = line.match(/^\s*[-*]\s+(.*)$/);
        if (bullet) {
          return (
            <div key={i} className="flex gap-2 pl-2">
              <span className="select-none text-[var(--color-accent)]">•</span>
              <span className="min-w-0 flex-1">
                <InlineDoc text={bullet[1]} basePath={path} />
              </span>
            </div>
          );
        }
        if (!line.trim()) return <div key={i} className="h-2" />;
        return (
          <p key={i} className="whitespace-pre-wrap break-words">
            <InlineDoc text={line} basePath={path} />
          </p>
        );
      })}
      {truncated && <div className="mt-4 text-[12px] text-[var(--color-faint)]">… truncated</div>}
    </div>
  );
}

function InlineDoc({ text, basePath }: { text: string; basePath: string }) {
  const nodes: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`/g;
  let last = 0;
  let k = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(<span key={`s${k++}`}>{text.slice(last, match.index)}</span>);
    const label = match[1] ?? match[3] ?? "";
    const target = match[2] ?? match[3] ?? "";
    const clickable = isHttpPaneTarget(target) || isPaneFileTarget(target);
    if (clickable) {
      nodes.push(
        <button
          key={`l${k++}`}
          type="button"
          onClick={() => {
            if (isHttpPaneTarget(target)) {
              openUrlInPane(target, label || "browser");
              return;
            }
            const resolved = resolvePaneFileTarget(target, basePath);
            openFileInPane(resolved, targetLabel(resolved));
          }}
          className="font-mono text-[0.95em] text-[var(--color-accent)] underline decoration-[var(--color-accent)]/35 underline-offset-2 hover:decoration-[var(--color-accent)]"
        >
          {label}
        </button>,
      );
    } else if (match[3]) {
      nodes.push(
        <code key={`c${k++}`} className="rounded bg-[var(--color-panel)] px-1 py-0.5 font-mono text-[0.9em] text-[var(--color-text)]">
          {label}
        </code>,
      );
    } else {
      nodes.push(<span key={`p${k++}`}>{label}</span>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(<span key={`s${k++}`}>{text.slice(last)}</span>);
  return <>{nodes}</>;
}
