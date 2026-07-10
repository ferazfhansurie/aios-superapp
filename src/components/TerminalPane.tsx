import { lazy, Suspense } from "react";

import type { PaneKind } from "./TerminalRuntime";
import type { TaskId } from "../lib/taskWorkspace";

export type { PaneKind };
export type TerminalPaneProps = {
  kind: PaneKind;
  paneKey?: string;
  active?: boolean;
  hidden?: boolean;
  taskId?: TaskId;
};

const TerminalRuntime = lazy(() =>
  import("./TerminalRuntime").then((m) => ({ default: m.TerminalPane })),
);

export function TerminalPane(props: TerminalPaneProps) {
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
