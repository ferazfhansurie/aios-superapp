import { createElement } from "react";
import {
  Layers,
  Maximize2,
  PanelLeft,
  Play,
  Rows2,
} from "lucide-react";

import type { Command as PaletteCommand } from "../components/CommandPalette.tsx";
import { SPAWN, type PaneContent } from "./apps.ts";
import { commandToPaletteCommand, createCommand, type AiosCommand } from "./commands.ts";

export interface AppCommandDeps {
  activeKey: string | null;
  panesCount: number;
  spawn: (kind: PaneContent, label: string) => void;
  runF5: () => void;
  setSidebarOpen: (updater: (value: boolean) => boolean) => void;
  setTopBarMode: (mode: "compact" | "hidden") => void;
  setOverviewOpen: (open: boolean) => void;
  setHiddenKeys: (keys: string[]) => void;
  setMaximizedKey: (key: string | null) => void;
}

interface RegistryEntry {
  command: AiosCommand;
  group: string;
  actionLabel: string;
}

export function buildAppCommands(deps: AppCommandDeps): PaletteCommand[] {
  const ctx = { source: "palette" as const, activePaneKey: deps.activeKey };
  const toPalette = (entry: RegistryEntry) =>
    commandToPaletteCommand(entry.command, {
      context: ctx,
      group: entry.group,
      actionLabel: entry.actionLabel,
      subtitle: entry.command.description,
    });

  const registry: RegistryEntry[] = [
    ...SPAWN.map((s) => ({
      command: createCommand({
        id: `pane.open.${s.id}`,
        label: `new ${s.label}`,
        scope: "pane",
        icon: createElement(s.icon, { size: 14 }),
        keywords: ["open", "pane", "spawn", "launch", "new"],
        run: () => deps.spawn(s.kind, s.label),
      }),
      group: "open",
      actionLabel: "open",
    })),
    {
      command: createCommand({
        id: "view.sidebar.toggle",
        label: "toggle sidebar",
        description: "⌘B",
        scope: "global",
        icon: createElement(PanelLeft, { size: 14 }),
        hotkeys: ["mod+b"],
        keywords: ["rail", "hide", "show"],
        run: () => deps.setSidebarOpen((v) => !v),
      }),
      group: "view",
      actionLabel: "toggle",
    },
    {
      command: createCommand({
        id: "view.topbar.hide",
        label: "hide top bar",
        scope: "global",
        icon: createElement(Rows2, { size: 14 }),
        keywords: ["topbar", "top", "bar", "chrome", "minimal", "hide"],
        run: () => deps.setTopBarMode("hidden"),
      }),
      group: "view",
      actionLabel: "hide",
    },
    {
      command: createCommand({
        id: "view.topbar.compact",
        label: "show compact top bar",
        scope: "global",
        icon: createElement(Rows2, { size: 14 }),
        keywords: ["topbar", "top", "bar", "chrome", "controls", "show", "compact"],
        run: () => deps.setTopBarMode("compact"),
      }),
      group: "view",
      actionLabel: "show",
    },
    {
      command: createCommand({
        id: "view.overview.open",
        label: "show all panes",
        description: "⌘`",
        scope: "pane",
        icon: createElement(Layers, { size: 14 }),
        keywords: ["overview", "mission", "control", "switch", "panes", "windows", "fan", "out"],
        enabled: () => deps.panesCount > 0,
        run: () => deps.setOverviewOpen(true),
      }),
      group: "view",
      actionLabel: "open",
    },
    {
      command: createCommand({
        id: "pane.tile.all",
        label: "tile all panes",
        scope: "pane",
        icon: createElement(Maximize2, { size: 14 }),
        keywords: ["show", "all", "restore", "unminimize", "tile", "grid", "every", "pane", "visible"],
        run: () => {
          deps.setHiddenKeys([]);
          deps.setMaximizedKey(null);
        },
      }),
      group: "view",
      actionLabel: "tile",
    },
    {
      command: createCommand({
        id: "project.run.focused",
        label: "run focused project",
        description: "F5",
        scope: "run",
        icon: createElement(Play, { size: 14 }),
        hotkeys: ["f5"],
        keywords: ["f5", "run", "debug", "start", "flutter", "npm", "dev", "build", "terminal", "focused", "open", "file"],
        run: deps.runF5,
      }),
      group: "actions",
      actionLabel: "run",
    },
  ];

  return registry.map(toPalette);
}
