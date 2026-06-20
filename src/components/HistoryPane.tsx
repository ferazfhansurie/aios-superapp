import { useEffect, useMemo, useRef, useState } from "react";
import { History, MessageSquare, RotateCcw, Trash2 } from "lucide-react";

import type { PaneContent } from "../lib/apps";
import { readChatTranscript } from "../lib/chat";
import { isTauriRuntime } from "../lib/tauri";
import {
  clearPaneHistory,
  hydratePaneHistoryStore,
  loadPaneHistory,
  paneHistoryKindLabel,
  prunePaneHistoryResume,
  removePaneHistory,
  subscribePaneHistory,
  type PaneHistoryItem,
} from "../lib/paneHistory";

function timeAgo(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function historySubtitle(item: PaneHistoryItem): string {
  return item.detail;
}

export function HistoryPane({
  onOpenHistoryItem,
}: {
  onOpenHistoryItem: (kind: PaneContent, label: string) => void | Promise<void>;
}) {
  const [items, setItems] = useState<PaneHistoryItem[]>(() => loadPaneHistory());
  const checkedResumeIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void hydratePaneHistoryStore().then((next) => {
      if (alive) setItems(next);
    });
    const unsubscribe = subscribePaneHistory(() => setItems(loadPaneHistory()));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const ids = items
      .map((item) => (item.kind.type === "chat" ? item.kind.resume?.id?.trim() : ""))
      .filter((id): id is string => Boolean(id && !checkedResumeIds.current.has(id)));
    if (!ids.length) return;
    ids.forEach((id) => checkedResumeIds.current.add(id));
    let alive = true;
    void Promise.all(
      ids.map(async (id) => ({
        id,
        ok: (await readChatTranscript(id).catch(() => [])).length > 0,
      })),
    ).then((results) => {
      if (!alive) return;
      const stale = results.filter((result) => !result.ok).map((result) => result.id);
      if (!stale.length) return;
      for (const id of stale) {
        checkedResumeIds.current.delete(id);
        prunePaneHistoryResume(id);
      }
      setItems(loadPaneHistory());
    });
    return () => {
      alive = false;
    };
  }, [items]);

  const grouped = useMemo(() => {
    const today = Date.now() - 24 * 3600_000;
    const recent = items.filter((item) => item.openedAt >= today);
    const older = items.filter((item) => item.openedAt < today);
    return { recent, older };
  }, [items]);

  const remove = (id: string) => setItems(removePaneHistory(id));
  const clear = () => setItems(clearPaneHistory());
  const reopen = (item: PaneHistoryItem) => {
    onOpenHistoryItem(item.kind, item.label);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <History size={16} className="text-[var(--color-accent)]" />
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[var(--color-text)]">history</div>
            <div className="truncate text-[10px] text-[var(--color-muted)]">
              opened panes · reopen with context
            </div>
          </div>
        </div>
        {items.length > 0 && (
          <button
            type="button"
            onClick={clear}
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-danger)]/50 hover:text-[var(--color-danger)]"
          >
            clear all
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {items.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-[260px] text-[12px] text-[var(--color-muted)]">
              pane history will appear here after you open browser, chat, terminal, or files panes.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <HistoryGroup title="today" items={grouped.recent} onReopen={reopen} onRemove={remove} />
            <HistoryGroup title="earlier" items={grouped.older} onReopen={reopen} onRemove={remove} />
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryGroup({
  title,
  items,
  onReopen,
  onRemove,
}: {
  title: string;
  items: PaneHistoryItem[];
  onReopen: (item: PaneHistoryItem) => void;
  onRemove: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <div className="px-1 text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
        {title}
      </div>
      {items.map((item) => {
        const kindLabel = paneHistoryKindLabel(item.kind);
        const chatResume = item.kind.type === "chat" && item.kind.resume;
        return (
          <div
            key={item.id}
            className="group flex min-w-0 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/35 px-2.5 py-2 transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-2)]"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[var(--color-panel-2)] text-[var(--color-muted)]">
              {chatResume ? <MessageSquare size={15} /> : <History size={15} />}
            </span>
            <button
              type="button"
              onClick={() => onReopen(item)}
              className="min-w-0 flex-1 text-left"
              title={historySubtitle(item)}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13px] text-[var(--color-text)]">{item.label}</span>
                <span className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-muted)]">
                  {item.indicator || kindLabel}
                </span>
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-2">
                <span className="truncate text-[11px] text-[var(--color-muted)]">{historySubtitle(item)}</span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">{timeAgo(item.openedAt)}</span>
              </div>
            </button>
            <button
              type="button"
              onClick={() => onReopen(item)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--color-muted)] opacity-0 transition-opacity hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] group-hover:opacity-100"
              title="reopen"
            >
              <RotateCcw size={13} />
            </button>
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--color-muted)] opacity-0 transition-opacity hover:bg-[var(--color-panel)] hover:text-[var(--color-danger)] group-hover:opacity-100"
              title="delete"
            >
              <Trash2 size={13} />
            </button>
          </div>
        );
      })}
    </section>
  );
}
