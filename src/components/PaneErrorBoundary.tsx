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
