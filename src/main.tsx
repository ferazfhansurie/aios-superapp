import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { installGlobalDiagHandlers } from "./lib/diag";

// Local-first diagnostics: capture uncaught errors + unhandled promise
// rejections at the window level and persist them via the diag store (Phase 0).
// Zero network — see TELEMETRY-PLAN.md.
installGlobalDiagHandlers();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
