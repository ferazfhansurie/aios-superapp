/** App catalog — the built-in spawnable apps shown in the sidebar + idle dock.
 *  Lives in a lib module (not App.tsx) so the sidebar store can reference the
 *  catalog by stable id without an import cycle. Icons are lucide components,
 *  fine to import here. */

import {
  Bot,
  Bug,
  Folder,
  Globe,
  MessageSquare,
  MonitorPlay,
  MonitorUp,
  NotebookPen,
  TerminalSquare,
} from "lucide-react";

import type { PaneKind } from "../components/TerminalPane";

/** A pane's content — terminal-backed (shell/oracle/tmux) or a view. */
export type PaneContent =
  | PaneKind
  | { type: "files"; root?: string }
  | { type: "browser"; url?: string; profile?: string; memKey?: string; transient?: boolean }
  | { type: "appcast"; windowId?: number }
  | { type: "notes" }
  | { type: "bridges" }
  | { type: "plugins" }
  | { type: "pulse" }
  | { type: "notifications" }
  | { type: "money-agents" }
  | { type: "apps" }
  | { type: "app"; name: string; bundleId?: string | null }
  | {
      type: "chat";
      cwd?: string;
      seed?: string;
      resume?: { id: string; title: string; engine?: string; model?: string };
      reattach?: number;
      modelId?: string;
      agentId?: string;
      agentLabel?: string;
    }
  | { type: "pet" }
  | { type: "file"; path: string; name: string }
  | { type: "editor"; path: string; name: string; line?: number; col?: number };

/** A built-in app — `id` is the stable key persisted by the sidebar store
 *  (labels are user-editable, ids are not). */
export type AppDef = {
  id: string;
  kind: PaneContent;
  icon: typeof Folder;
  label: string;
  /** which default sidebar group this app seeds into. */
  group: "sessions" | "tools";
  /** first-class apps show in the default sidebar; everything else seeds hidden
   *  (still reachable via ⌘K). Lets us ship the full catalog while keeping the
   *  default rail focused. */
  firstClass?: boolean;
};

/** Default app catalog — order here == the seeded default sidebar order. */
export const SPAWN: AppDef[] = [
  { id: "chat", kind: { type: "chat" }, icon: MessageSquare, label: "chat", group: "tools", firstClass: true },
  { id: "pet", kind: { type: "pet" }, icon: Bug, label: "pet", group: "tools" },
  { id: "terminal", kind: { type: "shell" }, icon: TerminalSquare, label: "terminal", group: "tools", firstClass: true },
  { id: "codex-code", kind: { type: "shell", cmd: "codex --model gpt-5.3-codex-spark --dangerously-bypass-approvals-and-sandbox" }, icon: Bot, label: "codex", group: "tools", firstClass: true },
  { id: "claude-code", kind: { type: "shell", cmd: "claude --dangerously-skip-permissions" }, icon: Bot, label: "claude code", group: "tools" },
  { id: "notes", kind: { type: "notes" }, icon: NotebookPen, label: "notes", group: "tools", firstClass: true },
  { id: "files", kind: { type: "files" }, icon: Folder, label: "files", group: "tools", firstClass: true },
  { id: "browser", kind: { type: "browser" }, icon: Globe, label: "browser", group: "tools", firstClass: true },
  { id: "apps", kind: { type: "apps" }, icon: MonitorUp, label: "apps", group: "tools" },
  // App-cast (ScreenCaptureKit spike): live-mirror a native macOS window in a
  // pane. Hidden by default (not firstClass) — reachable via ⌘K. macOS-only.
  { id: "appcast", kind: { type: "appcast" }, icon: MonitorPlay, label: "app cast", group: "tools" },
];

/** Stable id → AppDef, for sidebar render-time lookup. */
export const SPAWN_BY_ID: Record<string, AppDef> = Object.fromEntries(
  SPAWN.map((a) => [a.id, a]),
);
