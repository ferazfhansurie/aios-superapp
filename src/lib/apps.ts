/** App catalog — the built-in spawnable apps shown in the sidebar + idle dock.
 *  Lives in a lib module (not App.tsx) so the sidebar store can reference the
 *  catalog by stable id without an import cycle. Icons are lucide components,
 *  fine to import here. */

import {
  Database,
  Bot,
  Clock,
  Folder,
  Globe,
  MessageCircle,
  MessageSquare,
  Wand2,
  TerminalSquare,
} from "lucide-react";

import type { PaneKind } from "../components/TerminalPane";

/** A pane's content — terminal-backed (shell/oracle/tmux) or a view. */
export type PaneContent =
  | PaneKind
  | { type: "files" }
  | { type: "browser"; url?: string }
  | { type: "memory" }
  | { type: "automations" }
  | { type: "bridges" }
  | { type: "plugins" }
  | { type: "pulse" }
  | { type: "chat"; seed?: string; resume?: { id: string; title: string }; reattach?: number }
  | { type: "customers" }
  | { type: "motion" }
  | { type: "file"; path: string; name: string }
  | { type: "editor"; path: string; name: string };

/** A built-in app — `id` is the stable key persisted by the sidebar store
 *  (labels are user-editable, ids are not). */
export type AppDef = {
  id: string;
  kind: PaneContent;
  icon: typeof Folder;
  label: string;
  /** which default sidebar group this app seeds into. */
  group: "sessions" | "tools";
};

/** Default app catalog — order here == the seeded default sidebar order. */
export const SPAWN: AppDef[] = [
  { id: "chat", kind: { type: "chat" }, icon: MessageSquare, label: "chat", group: "sessions" },
  { id: "terminal", kind: { type: "shell" }, icon: TerminalSquare, label: "terminal", group: "sessions" },
  { id: "claude-code", kind: { type: "shell", cmd: "claude --dangerously-skip-permissions" }, icon: Bot, label: "claude code", group: "tools" },
  { id: "files", kind: { type: "files" }, icon: Folder, label: "files", group: "tools" },
  { id: "browser", kind: { type: "browser" }, icon: Globe, label: "browser", group: "tools" },
  { id: "database", kind: { type: "memory" }, icon: Database, label: "database", group: "tools" },
  { id: "automations", kind: { type: "automations" }, icon: Clock, label: "automations", group: "tools" },
  { id: "contacts", kind: { type: "customers" }, icon: MessageCircle, label: "contacts", group: "tools" },
  { id: "studio", kind: { type: "motion" }, icon: Wand2, label: "studio", group: "tools" },
];

/** Stable id → AppDef, for sidebar render-time lookup. */
export const SPAWN_BY_ID: Record<string, AppDef> = Object.fromEntries(
  SPAWN.map((a) => [a.id, a]),
);
