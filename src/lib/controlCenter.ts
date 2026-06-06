import type { AiosNotification } from "./notifications";
import type { MoneyAgentSummary } from "./moneyAgents";
import type { MemoryFocus } from "./dashboard";

export interface AgentFleetSummary {
  total: number;
  runningOrScheduled: number;
  needsControl: number;
  failed: number;
  headline: string;
}

export interface NotificationSummary {
  unreadCount: number;
  importantCount: number;
  items: AiosNotification[];
}

export interface JarvisBriefing {
  primaryPrompt: string;
  talkPrompt: string;
  unreadCount: number;
  controlCount: number;
}

export function formatRelativeRunAge(lastRunAt: number | null | undefined, now = Date.now()): string {
  if (!lastRunAt) return "never";
  const delta = Math.max(0, now - lastRunAt);
  const minute = Math.max(1, Math.floor(delta / 60_000));
  if (minute < 60) return `${minute}m ago`;
  const hour = Math.floor(minute / 60);
  if (hour < 24) return `${hour}h ago`;
  return `${Math.floor(hour / 24)}d ago`;
}

export function agentUrgency(agent: Pick<MoneyAgentSummary, "health" | "nextAction">): "critical" | "control" | "active" | "idle" {
  if (agent.health === "failed") return "critical";
  if (agent.health === "needs-steer" || /approve|review|missing|blocked|control/i.test(agent.nextAction)) {
    return "control";
  }
  if (agent.health === "running" || agent.health === "scheduled") return "active";
  return "idle";
}

export function agentRunLabel(agent: Pick<MoneyAgentSummary, "schedule" | "lastRunAt">): string {
  const schedule = agent.schedule || "manual";
  return `${schedule} · last ${formatRelativeRunAge(agent.lastRunAt)}`;
}

export function summarizeAgentFleet(agents: MoneyAgentSummary[]): AgentFleetSummary {
  const runningOrScheduled = agents.filter((agent) => agent.health === "running" || agent.health === "scheduled").length;
  const failed = agents.filter((agent) => agent.health === "failed").length;
  const needsControl = agents.filter((agent) => agentUrgency(agent) === "control" || agentUrgency(agent) === "critical").length;
  const headline =
    failed > 0
      ? `${failed} failed`
      : needsControl > 0
        ? `${needsControl} control needed`
        : runningOrScheduled > 0
          ? `${runningOrScheduled} active`
          : "idle";

  return {
    total: agents.length,
    runningOrScheduled,
    needsControl,
    failed,
    headline,
  };
}

export function summarizeNotifications(notifications: AiosNotification[]): NotificationSummary {
  const important = (item: AiosNotification) => item.level === "warning" || item.level === "error";
  const items = [...notifications]
    .filter((item) => !item.read)
    .sort((a, b) => {
      const importance = Number(important(b)) - Number(important(a));
      return importance || b.ts - a.ts;
    })
    .slice(0, 5);

  return {
    unreadCount: notifications.filter((item) => !item.read).length,
    importantCount: notifications.filter((item) => !item.read && important(item)).length,
    items,
  };
}

export function buildJarvisBriefing({
  agents,
  notifications,
  focus,
}: {
  agents: MoneyAgentSummary[];
  notifications: AiosNotification[];
  focus: MemoryFocus | { title?: string; detail?: string } | null;
}): JarvisBriefing {
  const notificationSummary = summarizeNotifications(notifications);
  const fleet = summarizeAgentFleet(agents);
  const top = notificationSummary.items[0];
  const primaryPrompt = top?.title ?? (fleet.needsControl > 0 ? fleet.headline : focus?.title ?? "aios is monitoring");
  const body = top?.body ? `\n\ncontext:\n${top.body}` : "";
  const source = top ? `\n\nsource: ${top.sourceLabel ?? top.kind}` : "";

  return {
    primaryPrompt,
    talkPrompt: `help me handle this aios control-center item:\n\n${primaryPrompt}${body}${source}`,
    unreadCount: notificationSummary.unreadCount,
    controlCount: fleet.needsControl + notificationSummary.importantCount,
  };
}
