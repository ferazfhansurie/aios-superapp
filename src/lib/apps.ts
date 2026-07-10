/** App catalog — the built-in spawnable apps shown in the sidebar + idle dock.
 *  Lives in a lib module (not App.tsx) so the sidebar store can reference the
 *  catalog by stable id without an import cycle. Icons are lucide components,
 *  fine to import here. */

import {
  BarChart3,
  Swords,
  Clapperboard,
  Folder,
  Globe,
  History,
  MessageSquare,
  Repeat,
  Smartphone,
  TerminalSquare,
  Ticket,
} from "lucide-react";

import type { PaneKind } from "../components/TerminalPane";
import type { LiveRoomMode } from "./liveRoom";
import type { TaskId } from "./taskWorkspace";

/** A pane's content — terminal-backed (shell/oracle/tmux) or a view. */
export type PaneContent = (
  | PaneKind
  | { type: "files"; root?: string }
  | { type: "loop" }
  | { type: "ticket" }
  | { type: "analytics" }
  | { type: "system" }
  | { type: "live-room"; mode?: LiveRoomMode; sessionId?: string; windowId?: number }
  | { type: "history" }
  | { type: "browser"; url?: string; profile?: string; memKey?: string; transient?: boolean }
  | { type: "chrome"; url?: string }
  | { type: "appcast"; windowId?: number }
  | { type: "wrms-device" }
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
      resume?: { id: string; title: string; engine?: string; model?: string; version?: number };
      reattach?: number;
      modelId?: string;
      agentLabel?: string;
    }
  | { type: "file"; path: string; name: string }
  | { type: "editor"; path: string; name: string; line?: number; col?: number }
) & { taskId?: TaskId };

/** A built-in app — `id` is the stable key persisted by the sidebar store
 *  (labels are user-editable, ids are not). */
export type AppDef = {
  id: string;
  kind: PaneContent;
  icon: typeof Folder;
  label: string;
  group: "tools";
};

/** Default app catalog — order here == the seeded default sidebar order. */
export const SPAWN: AppDef[] = [
  { id: "chat", kind: { type: "chat" }, icon: MessageSquare, label: "chat", group: "tools" },
  { id: "terminal", kind: { type: "shell" }, icon: TerminalSquare, label: "terminal", group: "tools" },
  { id: "files", kind: { type: "files" }, icon: Folder, label: "files", group: "tools" },
  { id: "browser", kind: { type: "browser" }, icon: Globe, label: "browser", group: "tools" },
  { id: "live-room", kind: { type: "live-room" }, icon: Clapperboard, label: "live room", group: "tools" },
  { id: "history", kind: { type: "history" }, icon: History, label: "history", group: "tools" },
  { id: "loop", kind: { type: "loop" }, icon: Repeat, label: "loops", group: "tools" },
  { id: "ticket", kind: { type: "ticket" }, icon: Ticket, label: "tickets", group: "tools" },
  { id: "analytics", kind: { type: "analytics" }, icon: BarChart3, label: "analytics", group: "tools" },
  { id: "system", kind: { type: "system" }, icon: Swords, label: "system", group: "tools" },
  { id: "wrms-device", kind: { type: "wrms-device" }, icon: Smartphone, label: "wrms device", group: "tools" },
];

/** Stable id → AppDef, for sidebar render-time lookup. */
export const SPAWN_BY_ID: Record<string, AppDef> = Object.fromEntries(
  SPAWN.map((a) => [a.id, a]),
);
