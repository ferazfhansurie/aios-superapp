import type { PaneContent } from "./apps.ts";

export type MirrorCapability =
  | "view_state"
  | "pixel_stream"
  | "focus"
  | "hide"
  | "maximize"
  | "close"
  | "input"
  | "stop"
  | "detach"
  | "navigate"
  | "history"
  | "reload"
  | "screenshot";

export type MirrorPaneRenderMode = "structured" | "visual" | "local-only";

export interface MirrorPaneInput {
  key: string;
  label: string;
  kind: PaneContent;
}

export interface MirrorPaneSnapshot {
  key: string;
  label: string;
  type: PaneContent["type"];
  hidden: boolean;
  active: boolean;
  maximized: boolean;
  renderMode: MirrorPaneRenderMode;
  capabilities: MirrorCapability[];
  resource?: string;
}

export interface MirrorSnapshotInput {
  panes: MirrorPaneInput[];
  hiddenKeys: string[];
  activeKey: string | null;
  maximizedKey: string | null;
  sidebarOpen: boolean;
  overviewOpen: boolean;
  settingsOpen: boolean;
  now?: number;
}

export interface MirrorSnapshot {
  schema: "aios.mirror.v1";
  generatedAt: number;
  desktop: {
    sidebarOpen: boolean;
    overviewOpen: boolean;
    settingsOpen: boolean;
    activeKey: string | null;
    maximizedKey: string | null;
    panesCount: number;
    visiblePanesCount: number;
  };
  panes: MirrorPaneSnapshot[];
  controls: {
    readonly: string[];
    ui: string[];
    confirmRequired: string[];
  };
}

const BASE_PANE_CONTROLS: MirrorCapability[] = ["focus", "hide", "maximize", "close"];

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function terminalLike(kind: PaneContent): boolean {
  return kind.type === "shell" || kind.type === "oracle" || kind.type === "tmux";
}

export function mirrorPaneRenderMode(kind: PaneContent): MirrorPaneRenderMode {
  if (kind.type === "browser") return "visual";
  if (kind.type === "file") return "visual";
  if (terminalLike(kind)) return "structured";
  if (kind.type === "editor") return "structured";
  return "structured";
}

export function mirrorPaneCapabilities(kind: PaneContent): MirrorCapability[] {
  const caps: MirrorCapability[] = ["view_state", ...BASE_PANE_CONTROLS];

  if (terminalLike(kind)) caps.push("input", "pixel_stream");
  if (kind.type === "chat") caps.push("input", "stop", "detach");
  if (kind.type === "browser") {
    caps.push("pixel_stream", "navigate", "history", "reload", "screenshot");
  }
  if (kind.type === "editor" || kind.type === "notes") caps.push("input");
  if (kind.type === "file") caps.push("pixel_stream", "screenshot");

  return unique(caps);
}

export function mirrorPaneResource(kind: PaneContent): string | undefined {
  if (kind.type === "browser") return kind.url;
  if (kind.type === "file" || kind.type === "editor") return kind.name;
  if (kind.type === "chat" && kind.resume) return kind.resume.title;
  if (kind.type === "shell" && kind.cmd) return kind.cmd.split(/\s+/).slice(0, 2).join(" ");
  if (kind.type === "tmux") return kind.session;
  if (kind.type === "oracle") return kind.identity;
  return undefined;
}

export function buildMirrorSnapshot(input: MirrorSnapshotInput): MirrorSnapshot {
  const hidden = new Set(input.hiddenKeys);
  const panes = input.panes.map((pane) => ({
    key: pane.key,
    label: pane.label,
    type: pane.kind.type,
    hidden: hidden.has(pane.key),
    active: pane.key === input.activeKey,
    maximized: pane.key === input.maximizedKey,
    renderMode: mirrorPaneRenderMode(pane.kind),
    capabilities: mirrorPaneCapabilities(pane.kind),
    resource: mirrorPaneResource(pane.kind),
  }));

  return {
    schema: "aios.mirror.v1",
    generatedAt: input.now ?? Date.now(),
    desktop: {
      sidebarOpen: input.sidebarOpen,
      overviewOpen: input.overviewOpen,
      settingsOpen: input.settingsOpen,
      activeKey: input.activeKey,
      maximizedKey: input.maximizedKey,
      panesCount: panes.length,
      visiblePanesCount: panes.filter((pane) => !pane.hidden).length,
    },
    panes,
    controls: {
      readonly: ["pane.list", "mirror.snapshot"],
      ui: [
        "pane.focus",
        "pane.hide",
        "pane.maximize",
        "view.show_overview",
        "view.open_settings",
        "view.set_sidebar",
        "chat.stop",
        "chat.detach",
      ],
      confirmRequired: ["pane.close", "browser.navigate"],
    },
  };
}
