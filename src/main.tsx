import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { PaneErrorBoundary } from "./components/PaneErrorBoundary";
import { installGlobalDiagHandlers, reportDiag } from "./lib/diag";
import { pruneRunEventStores } from "./lib/runEvents";
import { installStorageQuotaGuard } from "./lib/safeStorage";

// Local-first diagnostics: capture uncaught errors + unhandled promise
// rejections at the window level and persist them via the diag store (Phase 0).
// Zero network — see TELEMETRY-PLAN.md.
installGlobalDiagHandlers();

// localStorage hygiene BEFORE React mounts: un-pruned per-session run-event logs
// accumulate until the origin quota fills, then an uncaught setItem crashes the
// whole app into a blank window (2026-06-19 incident). Keep them bounded.
pruneRunEventStores();

// And close the class for good: a runtime quota throw (a write that tips the
// quota over AFTER boot, where prune never runs) is the same blank-screen crash.
// Guard Storage.setItem so any quota throw prunes + retries instead of unmounting.
installStorageQuotaGuard();

// Top-level error boundary: before this, a single render throw anywhere in the
// tree white-screened the whole window with no recovery. Wrap the app root so a
// crash shows a calm reload affordance instead — and still flows the error into
// the local diag sink (alongside the window.error handler installed above).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PaneErrorBoundary
      fullScreen
      label="app"
      onError={(err, info) =>
        reportDiag("react.app-root", err, {
          action: "render",
          info: info.componentStack ?? "",
        })
      }
    >
      <App />
    </PaneErrorBoundary>
  </React.StrictMode>,
);
