/** Wraps a pane's content and accepts cross-pane drops of an `x-aios-path`
 *  payload (e.g. a folder dragged from the Files pane). The drop overlay only
 *  appears WHILE a path-drag is in flight app-wide (via the `onAiosDrag`
 *  signal), so it floats ABOVE intercepting children like xterm's canvas and
 *  reliably captures the drop — fixing the case where a terminal swallowed it.
 *
 *  Usage: <PaneDropZone onPath={(p) => insert(p)}>…pane content…</PaneDropZone> */
import { useEffect, useState } from "react";
import { AIOS_PATH_MIME, onAiosDrag } from "../lib/paneBus";

/** Pull a filesystem path out of a drop — works for in-app pane drags (our
 *  custom mime), Finder/Explorer drags (`text/uri-list` file:// URIs), and
 *  plain text. Returns null if nothing path-like is present. */
function extractPath(dt: DataTransfer): string | null {
  const aios = dt.getData(AIOS_PATH_MIME);
  if (aios) return aios;
  const uriList = dt.getData("text/uri-list");
  if (uriList) {
    const first = uriList
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith("#"));
    if (first?.startsWith("file://")) {
      try {
        return decodeURIComponent(new URL(first).pathname);
      } catch {
        /* fall through */
      }
    }
    if (first) return first;
  }
  const txt = dt.getData("text/plain");
  return txt || null;
}

export function PaneDropZone({
  onPath,
  label = "drop to insert path",
  children,
}: {
  onPath: (path: string) => void;
  label?: string;
  children: React.ReactNode;
}) {
  // a path-drag is happening somewhere in the app (arms the overlay)
  const [armed, setArmed] = useState(false);
  // the cursor is currently over THIS pane's overlay
  const [over, setOver] = useState(false);

  useEffect(() => onAiosDrag(setArmed), []);

  return (
    <div className="relative h-full min-h-0 w-full">
      {children}
      {armed && (
        <div
          className={`absolute inset-0 z-30 grid place-items-center border-2 border-dashed transition-colors ${
            over
              ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15"
              : "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            if (!over) setOver(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const path = extractPath(e.dataTransfer);
            if (path) onPath(path);
          }}
        >
          <span
            className={`rounded-md px-3 py-1.5 text-[12px] transition-opacity ${
              over ? "bg-[var(--color-panel)]/95 text-[var(--color-text)]" : "bg-[var(--color-panel)]/80 text-[var(--color-muted)]"
            }`}
          >
            {label}
          </span>
        </div>
      )}
    </div>
  );
}
