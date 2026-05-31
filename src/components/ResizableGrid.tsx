/** A uniform N×M pane grid with draggable gutters between tracks. Columns and
 *  rows are sized in `fr`; dragging a vertical gutter resizes the two adjacent
 *  columns (for every row), a horizontal gutter the two adjacent rows — the
 *  natural behavior for a shared-track CSS grid. Track sizes reset whenever the
 *  grid dimensions change (pane added/closed). */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { loadGridTracks, saveGridTracks } from "../lib/paneLayout";

/** Minimum share of total a single track may shrink to (8%). */
const MIN_FRAC = 0.08;

interface DragState {
  axis: "col" | "row";
  i: number;
  start: number;
  extent: number; // container px along the axis
  a0: number;
  b0: number;
  total: number;
}

export function ResizableGrid({
  cols,
  rows,
  gap = 8,
  storageKey,
  children,
}: {
  cols: number;
  rows: number;
  gap?: number;
  storageKey?: string;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [colFr, setColFr] = useState<number[]>(() => Array(cols).fill(1));
  const [rowFr, setRowFr] = useState<number[]>(() => Array(rows).fill(1));
  const drag = useRef<DragState | null>(null);

  // Reset tracks to equal shares whenever the grid shape changes.
  useEffect(() => {
    setColFr(storageKey ? (loadGridTracks(storageKey, cols, rows)?.cols ?? Array(cols).fill(1)) : Array(cols).fill(1));
  }, [cols, rows, storageKey]);
  useEffect(() => {
    setRowFr(storageKey ? (loadGridTracks(storageKey, cols, rows)?.rows ?? Array(rows).fill(1)) : Array(rows).fill(1));
  }, [cols, rows, storageKey]);

  useEffect(() => {
    if (!storageKey || colFr.length !== cols || rowFr.length !== rows) return;
    saveGridTracks(storageKey, colFr, rowFr);
  }, [storageKey, colFr, rowFr, cols, rows]);

  const totalCol = colFr.reduce((a, b) => a + b, 0);
  const totalRow = rowFr.reduce((a, b) => a + b, 0);

  const beginDrag = (axis: "col" | "row", i: number, e: React.PointerEvent) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const fr = axis === "col" ? colFr : rowFr;
    drag.current = {
      axis,
      i,
      start: axis === "col" ? e.clientX : e.clientY,
      extent: axis === "col" ? wrap.clientWidth : wrap.clientHeight,
      a0: fr[i],
      b0: fr[i + 1],
      total: axis === "col" ? totalCol : totalRow,
    };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const pos = d.axis === "col" ? e.clientX : e.clientY;
    const delta = ((pos - d.start) / Math.max(1, d.extent)) * d.total;
    const pairSum = d.a0 + d.b0;
    const min = d.total * MIN_FRAC;
    const a = Math.min(Math.max(d.a0 + delta, min), pairSum - min);
    const b = pairSum - a;
    const next = (prev: number[]) => {
      const arr = [...prev];
      arr[d.i] = a;
      arr[d.i + 1] = b;
      return arr;
    };
    if (d.axis === "col") setColFr(next);
    else setRowFr(next);
  };

  const endDrag = (e: React.PointerEvent) => {
    if (drag.current) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      drag.current = null;
    }
  };

  // Cumulative fraction (0..1) of a boundary after track i — used to place the
  // gutter handle. Gap offset is negligible at typical sizes; the wide hit area
  // absorbs it.
  const colBoundary = (i: number) =>
    colFr.slice(0, i + 1).reduce((a, b) => a + b, 0) / totalCol;
  const rowBoundary = (i: number) =>
    rowFr.slice(0, i + 1).reduce((a, b) => a + b, 0) / totalRow;

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      <div
        className="grid h-full w-full"
        style={{
          gap,
          padding: gap,
          gridTemplateColumns: colFr.map((f) => `minmax(0, ${f}fr)`).join(" "),
          gridTemplateRows: rowFr.map((f) => `minmax(0, ${f}fr)`).join(" "),
        }}
      >
        {children}
      </div>

      {/* vertical gutters (resize columns) */}
      {Array.from({ length: cols - 1 }, (_, i) => (
        <div
          key={`c${i}`}
          onPointerDown={(e) => beginDrag("col", i, e)}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          className="group absolute top-0 bottom-0 z-20 flex w-2 -translate-x-1/2 cursor-col-resize items-center justify-center"
          style={{ left: `${colBoundary(i) * 100}%` }}
        >
          <span className="h-10 w-[3px] rounded-full bg-[var(--color-border)] opacity-0 transition-opacity group-hover:opacity-100 group-active:bg-[var(--color-accent)] group-active:opacity-100" />
        </div>
      ))}

      {/* horizontal gutters (resize rows) */}
      {Array.from({ length: rows - 1 }, (_, i) => (
        <div
          key={`r${i}`}
          onPointerDown={(e) => beginDrag("row", i, e)}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          className="group absolute left-0 right-0 z-20 flex h-2 -translate-y-1/2 cursor-row-resize items-center justify-center"
          style={{ top: `${rowBoundary(i) * 100}%` }}
        >
          <span className="h-[3px] w-10 rounded-full bg-[var(--color-border)] opacity-0 transition-opacity group-hover:opacity-100 group-active:bg-[var(--color-accent)] group-active:opacity-100" />
        </div>
      ))}
    </div>
  );
}
