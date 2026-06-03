import { MessageSquare, Radar } from "lucide-react";

import { buildJarvisBriefing } from "../../lib/controlCenter";
import type { MemoryFocus } from "../../lib/dashboard";
import type { MoneyAgentSummary } from "../../lib/moneyAgents";
import type { AiosNotification } from "../../lib/notifications";

export function JarvisBriefingLane({
  agents,
  notifications,
  focus,
  onTalkToJarvis,
}: {
  agents: MoneyAgentSummary[];
  notifications: AiosNotification[];
  focus: MemoryFocus | null;
  onTalkToJarvis: (seed: string) => void;
}) {
  const briefing = buildJarvisBriefing({ agents, notifications, focus });

  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center gap-2">
        <Radar size={14} className="text-[var(--color-accent)]" />
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">jarvis</div>
          <div className="text-[12px] text-[var(--color-faint)]">broker between firaz and agents</div>
        </div>
      </div>
      <div className="border border-[var(--color-border)] bg-[var(--color-panel)]/30 p-4">
        <div className="text-[16px] font-semibold text-[var(--color-text)]">{briefing.primaryPrompt}</div>
        <p className="mt-1 text-[12px] leading-5 text-[var(--color-muted)]">
          {briefing.controlCount} control signal{briefing.controlCount === 1 ? "" : "s"} · {briefing.unreadCount} unread notification{briefing.unreadCount === 1 ? "" : "s"}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {[briefing.talkPrompt].map((prompt: string) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onTalkToJarvis(prompt)}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--color-accent)]/40 px-2 py-1 text-[11px] text-[var(--color-text)] hover:bg-[var(--color-accent)]/10"
            >
              <MessageSquare size={12} />
              <span className="truncate">{prompt}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
