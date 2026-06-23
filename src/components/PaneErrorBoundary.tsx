/** Generic React error boundary for panes. Catches any render throw inside a
 *  pane so one bad row can't white-screen the whole app — shows the error +
 *  component stack inline with a retry button instead.
 *
 *  Telemetry-ready: pass `onError` to forward crashes to a sink (the default
 *  logs to the console, which surfaces in the Tauri dev console). `label` tunes
 *  the headline + console tag for whichever pane wraps its content. */
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface PaneErrorBoundaryProps {
  children: ReactNode;
  /** Human label for the surface, used in the headline + console tag. */
  label?: string;
  /** Optional telemetry hook; called on every caught render crash. */
  onError?: (err: Error, info: ErrorInfo) => void;
  /** Root mode: when the WHOLE app render throws (not just one pane), show a
   *  calm, centered, recoverable fallback with a reload button instead of the
   *  terse inline pane variant. A retry alone can't help if the app root is
   *  wedged, so the primary action is `location.reload()`. */
  fullScreen?: boolean;
}

interface PaneErrorBoundaryState {
  err: Error | null;
  stack: string;
}

export class PaneErrorBoundary extends Component<
  PaneErrorBoundaryProps,
  PaneErrorBoundaryState
> {
  state: PaneErrorBoundaryState = { err: null, stack: "" };

  static getDerivedStateFromError(err: Error): PaneErrorBoundaryState {
    return { err, stack: "" };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    this.setState({ err, stack: info.componentStack ?? "" });
    const tag = this.props.label ? `[${this.props.label}]` : "[pane]";
    console.error(`${tag} render crash:`, err, info.componentStack);
    this.props.onError?.(err, info);
  }

  render() {
    if (this.state.err) {
      const what = this.props.label ?? "this pane";
      if (this.props.fullScreen) {
        // Whole-app crash: a calm, centered recovery surface. One throw used to
        // white-screen the entire window with no way back — this keeps firaz in
        // control with a reload (the only reliable recovery when the root render
        // itself is wedged). On-brand: neutral glass, no alarm-red, restraint.
        return (
          <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg)] p-8 text-[var(--color-text)]">
            <div className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.05] p-6 backdrop-blur-md">
              <span className="text-[14px] font-medium text-[var(--color-text)]">
                aios hit a snag
              </span>
              <span className="text-[12.5px] leading-relaxed text-[var(--color-text-2)]">
                something crashed while rendering. your sessions are still
                running in the background — a reload should bring everything
                back.
              </span>
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md bg-black/20 p-2 text-[11px] text-[var(--color-muted)]">
                {String(this.state.err?.message || this.state.err)}
              </pre>
              <button
                onClick={() => location.reload()}
                className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.08] px-3 py-2 text-[12.5px] font-medium text-[var(--color-text)] backdrop-blur-md transition-colors hover:bg-white/[0.12]"
              >
                reload
              </button>
            </div>
          </div>
        );
      }
      return (
        <div className="flex h-full flex-col gap-2 overflow-auto bg-[var(--color-pane)] p-4 text-[12px]">
          <span className="font-medium text-[var(--color-danger)]">
            {what} hit a render error
          </span>
          <pre className="whitespace-pre-wrap text-[11px] text-[var(--color-text-2)]">
            {String(this.state.err?.message || this.state.err)}
          </pre>
          {this.state.stack && (
            <pre className="whitespace-pre-wrap text-[10px] text-[var(--color-faint)]">
              {this.state.stack.trim()}
            </pre>
          )}
          <button
            onClick={() => this.setState({ err: null, stack: "" })}
            className="mt-1 w-fit rounded-md bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)]"
          >
            retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
