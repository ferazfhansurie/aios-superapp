import { lazy, Suspense } from "react";

import type { PaneKind } from "./TerminalRuntime";

export type { PaneKind };

const TerminalRuntime = lazy(() =>
  import("./TerminalRuntime").then((m) => ({ default: m.TerminalPane })),
);

export function TerminalPane(props: { kind: PaneKind; paneKey?: string }) {
  return (
    <Suspense fallback={<TerminalLoading />}>
      <TerminalRuntime {...props} />
    </Suspense>
  );
}

function TerminalLoading() {
  return (
    <div className="grid h-full place-items-center bg-[var(--color-bg)]">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-faint)]">
        loading terminal
      </span>
    </div>
  );
}
