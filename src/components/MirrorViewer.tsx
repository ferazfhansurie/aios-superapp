import {
  Eye,
  EyeOff,
  Maximize2,
  MonitorUp,
  PanelLeft,
  RefreshCw,
  Settings,
  Square,
  X,
} from "lucide-react";

import type { AgentAction } from "../lib/agentActions";
import type { MirrorConnectionStatus, MirrorPresence } from "../lib/mirrorTransport";
import type { MirrorSnapshot, MirrorPaneSnapshot } from "../lib/mirror";

interface MirrorViewerProps {
  snapshot: MirrorSnapshot | null;
  status: MirrorConnectionStatus;
  presence: MirrorPresence | null;
  onControl: (action: AgentAction) => void;
}

export function MirrorViewer({ snapshot, status, presence, onControl }: MirrorViewerProps) {
  const panes = snapshot?.panes ?? [];
  const active = panes.find((pane) => pane.active) ?? panes.find((pane) => !pane.hidden) ?? panes[0] ?? null;
  const connected = status === "connected";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-accent)]">
            <MonitorUp size={17} />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium">desktop mirror</div>
            <div className="truncate text-[11px] text-[var(--color-muted)]">
              {connected
                ? presence?.desktops
                  ? `${presence.desktops} desktop · ${presence.viewers} viewer${presence.viewers === 1 ? "" : "s"}`
                  : "waiting for desktop"
                : status === "connecting"
                  ? "connecting to cloudflare room"
                  : status === "error"
                    ? "connection interrupted"
                    : "mirror not connected"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onControl({ type: "view.set_sidebar", open: true })}
            className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title="show desktop sidebar"
          >
            <PanelLeft size={15} />
          </button>
          <button
            type="button"
            onClick={() => onControl({ type: "view.show_overview" })}
            className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title="show desktop pane overview"
          >
            <Square size={14} />
          </button>
          <button
            type="button"
            onClick={() => onControl({ type: "view.open_settings" })}
            className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title="open desktop settings"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {!snapshot ? (
        <div className="grid flex-1 place-items-center p-8 text-center">
          <div className="max-w-sm">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-accent)]">
              <RefreshCw size={18} className={status === "connecting" ? "animate-spin" : ""} />
            </div>
            <div className="text-[13px] font-medium">waiting for your desktop</div>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-muted)]">
              open the desktop shell and use its mirror link. this page will fill with the live pane map as soon as the desktop connects.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,280px)_1fr] gap-0">
          <div className="min-h-0 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-panel)]/55 p-2">
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-widest text-[var(--color-faint)]">
              panes
            </div>
            <div className="mt-1 flex flex-col gap-1">
              {panes.length === 0 ? (
                <div className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-8 text-center text-[11px] text-[var(--color-faint)]">
                  desktop has no open panes
                </div>
              ) : (
                panes.map((pane) => (
                  <MirrorPaneRow key={pane.key} pane={pane} onControl={onControl} />
                ))
              )}
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto p-4">
            <div className="grid h-full min-h-[420px] place-items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]">
              {active ? (
                <div className="w-full max-w-xl p-6">
                  <div className="text-[10px] uppercase tracking-widest text-[var(--color-faint)]">
                    active pane
                  </div>
                  <div className="mt-2 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h2 className="truncate text-[26px] font-semibold tracking-normal text-[var(--color-text)]">
                        {active.label}
                      </h2>
                      <div className="mt-1 text-[12px] text-[var(--color-muted)]">
                        {active.type} · {active.renderMode}
                        {active.resource ? ` · ${active.resource}` : ""}
                      </div>
                    </div>
                    <span className={`mt-1 h-2.5 w-2.5 rounded-full ${active.hidden ? "bg-[var(--color-muted)]" : "bg-[var(--color-accent)]"}`} />
                  </div>
                  <div className="mt-6 grid grid-cols-2 gap-2">
                    <MirrorAction label="focus" onClick={() => onControl({ type: "pane.focus", paneKey: active.key })} />
                    <MirrorAction label={active.hidden ? "show" : "hide"} onClick={() => onControl({ type: "pane.hide", paneKey: active.key })} />
                    <MirrorAction label={active.maximized ? "restore" : "maximize"} onClick={() => onControl({ type: "pane.maximize", paneKey: active.key })} />
                    {active.type === "chat" && (
                      <MirrorAction label="stop chat" danger onClick={() => onControl({ type: "chat.stop", paneKey: active.key })} />
                    )}
                  </div>
                  <div className="mt-6 rounded-md border border-dashed border-[var(--color-border)] p-3 text-[11px] leading-relaxed text-[var(--color-muted)]">
                    pixel streaming is not enabled yet. this mirror currently syncs pane state and safe controls; live visual streaming is the next bridge layer.
                  </div>
                </div>
              ) : (
                <div className="text-[12px] text-[var(--color-faint)]">no desktop pane selected</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MirrorPaneRow({
  pane,
  onControl,
}: {
  pane: MirrorPaneSnapshot;
  onControl: (action: AgentAction) => void;
}) {
  return (
    <div
      className={`group rounded-md border px-2.5 py-2 ${
        pane.active
          ? "border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10"
          : "border-transparent bg-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-panel-2)]"
      }`}
    >
      <button type="button" onClick={() => onControl({ type: "pane.focus", paneKey: pane.key })} className="w-full min-w-0 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${pane.hidden ? "bg-[var(--color-muted)]" : "bg-[var(--color-accent)]"}`} />
          <span className="truncate text-[12px] font-medium text-[var(--color-text)]">{pane.label}</span>
        </div>
        <div className="mt-1 truncate pl-4 text-[10px] text-[var(--color-muted)]">
          {pane.type}
          {pane.resource ? ` · ${pane.resource}` : ""}
        </div>
      </button>
      <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={() => onControl({ type: "pane.hide", paneKey: pane.key })}
          className="grid h-6 w-6 place-items-center rounded text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
          title={pane.hidden ? "show pane" : "hide pane"}
        >
          {pane.hidden ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        <button
          type="button"
          onClick={() => onControl({ type: "pane.maximize", paneKey: pane.key })}
          className="grid h-6 w-6 place-items-center rounded text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
          title="maximize pane"
        >
          <Maximize2 size={12} />
        </button>
        <button
          type="button"
          onClick={() => onControl({ type: "pane.close", paneKey: pane.key })}
          className="ml-auto grid h-6 w-6 place-items-center rounded text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-danger)]"
          title="close pane"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

function MirrorAction({
  label,
  onClick,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-2 text-[12px] transition-colors ${
        danger
          ? "border-[var(--color-danger)]/40 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
          : "border-[var(--color-border)] text-[var(--color-text-2)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
      }`}
    >
      {label}
    </button>
  );
}
