import { Bell, Check, MessageSquare, PanelTopOpen } from "lucide-react";

import { summarizeNotifications } from "../../lib/controlCenter";
import type { AiosNotification } from "../../lib/notifications";

export function NotificationCommandLane({
  notifications,
  onTalkToJarvis,
  onOpenContext,
  onDismiss,
}: {
  notifications: AiosNotification[];
  onTalkToJarvis: (seed: string) => void;
  onOpenContext: (item: AiosNotification) => void;
  onDismiss: (id: string) => void;
}) {
  const summary = summarizeNotifications(notifications);
  const items = summary.items;

  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center gap-2">
        <Bell size={14} className="text-[var(--color-warning)]" />
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">notifications</div>
          <div className="text-[12px] text-[var(--color-faint)]">{summary.unreadCount} unread · {summary.importantCount} important</div>
        </div>
      </div>
      <div className="space-y-2">
        {items.map((item: AiosNotification) => (
          <article key={item.id} className="border border-[var(--color-border)] bg-[var(--color-panel)]/30 p-3">
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-[var(--color-text)]">{item.title}</div>
                <div className="line-clamp-2 text-[11px] text-[var(--color-muted)]">{item.body}</div>
              </div>
              <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-faint)]">
                {item.level}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onTalkToJarvis(`open context for ${item.title}\n\n${item.body}`)}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--color-accent)]/45 bg-[var(--color-accent)]/10 px-2 py-1 text-[11px] text-[var(--color-text)]"
              >
                <MessageSquare size={12} />
                talk to jarvis
              </button>
              <button
                type="button"
                onClick={() => onOpenContext(item)}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-muted)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
              >
                <PanelTopOpen size={12} />
                open context
              </button>
              <button
                type="button"
                onClick={() => onDismiss(item.id)}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-faint)] hover:text-[var(--color-text)]"
              >
                <Check size={12} />
                dismiss
              </button>
            </div>
          </article>
        ))}
        {!items.length && <p className="border border-[var(--color-border)] p-3 text-[12px] text-[var(--color-faint)]">quiet. no operator action waiting.</p>}
      </div>
    </section>
  );
}
