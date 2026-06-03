import { lazy, Suspense } from "react";
import { Command, FolderGit2, PanelLeftOpen, Search, Sparkles } from "lucide-react";

import type { AppDef } from "../App";
import type { IdleRate, MemoryFocus } from "../lib/dashboard";
import type { RepoPulse } from "../lib/fs";
import type { MoneyAgentSummary } from "../lib/moneyAgents";
import type { AiosNotification } from "../lib/notifications";
import type { OracleInfo } from "../lib/pty";
import type { ProjectInfo } from "../lib/run";
import type { SidebarItem, SidebarState } from "../lib/sidebar";
import type { UsageExtras } from "../lib/stats";
import { AgentOperationsLane } from "./dashboard/AgentOperationsLane";
import { ControlCenterCharts } from "./dashboard/ControlCenterCharts";
import { JarvisBriefingLane } from "./dashboard/JarvisBriefingLane";
import { NotificationCommandLane } from "./dashboard/NotificationCommandLane";
import { PulseIdentityBand } from "./dashboard/PulseIdentityBand";

const PetDashboardCompanion = lazy(() =>
  import("./PetPane").then((mod) => ({ default: mod.PetDashboardCompanion })),
);

export function IdleControlCenter({
  apps,
  oracles,
  projects,
  sidebar,
  extras,
  rate,
  focus,
  pulse,
  moneyAgents,
  notifications,
  onSpawn,
  onOpenProject,
  onOpenSidebarItem,
  onRevealSidebar,
  onOpenMoneyAgents,
  onOpenPet,
  onOpenMoneyAgentChat,
  onOpenPalette,
  onTalkToJarvis,
  onOpenNotificationTarget,
  onClearNotification,
}: {
  apps: AppDef[];
  oracles: OracleInfo[];
  projects: ProjectInfo[];
  sidebar: SidebarState;
  extras: UsageExtras | null;
  rate: IdleRate | null;
  focus: MemoryFocus | null;
  pulse: RepoPulse[];
  moneyAgents: MoneyAgentSummary[];
  notifications: AiosNotification[];
  onSpawn: (kind: AppDef["kind"], label: string) => void;
  onOpenProject: (p: ProjectInfo) => void;
  onOpenSidebarItem: (item: SidebarItem) => void;
  onRevealSidebar: () => void;
  onOpenMoneyAgents: () => void;
  onOpenPet: () => void;
  onOpenMoneyAgentChat: (id: string, label: string, command?: string) => void;
  onOpenPalette: () => void;
  onTalkToJarvis: (seed: string) => void;
  onOpenNotificationTarget: (item: AiosNotification) => void;
  onClearNotification: (id: string) => void;
}) {
  const activeAgents = moneyAgents.filter((agent) => agent.health === "running" || agent.health === "scheduled").length;
  const unread = notifications.filter((item) => !item.read).length;
  const dirtyProjects = pulse.filter((repo) => repo.dirty || repo.ahead || repo.behind).length;
  const pinned = sidebar.items.filter((item) => item.group === "pinned").slice(0, 4);

  return (
    <div className="relative flex h-full flex-col overflow-hidden p-4">
      <div className="mb-4 flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] pb-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--color-muted)]">aios control center</div>
          <div className="truncate text-[18px] font-semibold text-[var(--color-text)]">jarvis routes the work. chat panes keep the audit trail.</div>
        </div>
        <button
          type="button"
          onClick={onOpenPalette}
          className="ml-auto inline-flex h-10 min-w-[160px] items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]/50 px-3 text-[12px] text-[var(--color-muted)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
        >
          <Search size={14} />
          command
          <span className="ml-auto font-mono text-[10px] text-[var(--color-faint)]">⌘k</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="space-y-5">
          <PulseIdentityBand extras={extras} rate={rate} focus={focus} />

          <section className="grid gap-4 xl:grid-cols-[1fr_1fr_360px]">
            <JarvisBriefingLane
              agents={moneyAgents}
              notifications={notifications}
              focus={focus}
              onTalkToJarvis={onTalkToJarvis}
            />
            <NotificationCommandLane
              notifications={notifications}
              onTalkToJarvis={onTalkToJarvis}
              onOpenContext={onOpenNotificationTarget}
              onDismiss={onClearNotification}
            />
            <Suspense fallback={<div className="border border-[var(--color-border)] p-3 text-[12px] text-[var(--color-faint)]">pet system loading.</div>}>
              <PetDashboardCompanion onOpenPet={onOpenPet} onTalkToJarvis={onTalkToJarvis} />
            </Suspense>
          </section>

          <AgentOperationsLane
            agents={moneyAgents}
            onOpenOverview={onOpenMoneyAgents}
            onOpenAgent={onOpenMoneyAgentChat}
          />

          <ControlCenterCharts agents={moneyAgents} extras={extras} notifications={notifications} />

          <section className="grid gap-3 border-t border-[var(--color-border)] pt-4 lg:grid-cols-4">
            <button
              type="button"
              onClick={() => onTalkToJarvis("brief me on what needs operator attention across agents, sales, support, and product right now.")}
              className="flex items-center gap-3 border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 p-3 text-left text-[12px] text-[var(--color-text)]"
            >
              <Sparkles size={15} />
              talk to jarvis
            </button>
            <button
              type="button"
              onClick={() => onSpawn({ type: "pulse" }, "pulse")}
              className="flex items-center gap-3 border border-[var(--color-border)] p-3 text-left text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              <Command size={15} />
              {activeAgents}/{moneyAgents.length} agents running
            </button>
            <button
              type="button"
              onClick={onRevealSidebar}
              className="flex items-center gap-3 border border-[var(--color-border)] p-3 text-left text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              <PanelLeftOpen size={15} />
              {unread} notifications · {pinned.length} pinned
            </button>
            <button
              type="button"
              onClick={() => projects[0] && onOpenProject(projects[0])}
              className="flex items-center gap-3 border border-[var(--color-border)] p-3 text-left text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              <FolderGit2 size={15} />
              {dirtyProjects} repos need review
            </button>
          </section>

          {pinned.length > 0 && (
            <section className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-4">
              {pinned.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onOpenSidebarItem(item)}
                  className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-muted)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
                >
                  {item.label}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-[var(--color-faint)]">
                {oracles.filter((oracle) => oracle.running).length}/{oracles.length} oracle panes awake · {apps.length} tools
              </span>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
