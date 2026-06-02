import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  FileText,
  GitBranch,
  Loader2,
  MessageSquare,
  RefreshCw,
  Square,
  XCircle,
} from "lucide-react";

import { readTextFile, shellSourceStatus, type ShellSourceStatus } from "../lib/fs";
import { listAutomations, type Agent } from "../lib/automations";
import { chatStop, listChatLive, type LiveChat } from "../lib/chat";

const BUILD_LOG = "/tmp/aios-shell-tauri-build.log";
const BUILD_STATUS = "/tmp/aios-shell-tauri-build.status";

type TaskState = "running" | "done" | "failed" | "idle";

function tail(text: string, lines = 80): string {
  return text.split("\n").slice(-lines).join("\n").trim();
}

function relPath(root: string | null, path: string): string {
  if (!root) return path;
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

export function StatusPane({ onReattachChat }: { onReattachChat?: (chat: LiveChat) => void }) {
  const [log, setLog] = useState("");
  const [statusRaw, setStatusRaw] = useState<string | null>(null);
  const [liveChats, setLiveChats] = useState<LiveChat[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [source, setSource] = useState<ShellSourceStatus | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);
  const [lastRead, setLastRead] = useState<number>(() => Date.now());
  const [stoppingChatId, setStoppingChatId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setWorkError(null);
    const [nextLog, nextStatus, chats, automationState, sourceState] = await Promise.all([
      readTextFile(BUILD_LOG).catch(() => ""),
      readTextFile(BUILD_STATUS).catch(() => null),
      listChatLive().catch((e) => {
        setWorkError(e instanceof Error ? e.message : String(e));
        return [];
      }),
      listAutomations().catch((e) => {
        setWorkError(e instanceof Error ? e.message : String(e));
        return null;
      }),
      shellSourceStatus().catch((e) => {
        setWorkError(e instanceof Error ? e.message : String(e));
        return null;
      }),
    ]);
    setLog(nextLog);
    setStatusRaw(nextStatus);
    setLiveChats(chats);
    setAgents(automationState?.agents ?? []);
    setSource(sourceState);
    setLastRead(Date.now());
  }, []);

  const stopChat = useCallback(async (chat: LiveChat) => {
    setStoppingChatId(chat.id);
    setWorkError(null);
    try {
      await chatStop(chat.id);
      setLiveChats((items) => items.filter((item) => item.id !== chat.id));
      void load();
    } catch (e) {
      setWorkError(e instanceof Error ? e.message : String(e));
    } finally {
      setStoppingChatId(null);
    }
  }, [load]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const [nextLog, nextStatus] = await Promise.all([
        readTextFile(BUILD_LOG).catch(() => ""),
        readTextFile(BUILD_STATUS).catch(() => null),
      ]);
      const [chats, automationState, sourceState] = await Promise.all([
        listChatLive().catch((e) => {
          if (alive) setWorkError(e instanceof Error ? e.message : String(e));
          return [];
        }),
        listAutomations().catch((e) => {
          if (alive) setWorkError(e instanceof Error ? e.message : String(e));
          return null;
        }),
        shellSourceStatus().catch((e) => {
          if (alive) setWorkError(e instanceof Error ? e.message : String(e));
          return null;
        }),
      ]);
      if (!alive) return;
      setLog(nextLog);
      setStatusRaw(nextStatus);
      setLiveChats(chats);
      setAgents(automationState?.agents ?? []);
      setSource(sourceState);
      setLastRead(Date.now());
    };
    void tick();
    const timer = window.setInterval(tick, 2_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const state: TaskState = useMemo(() => {
    const code = statusRaw?.trim();
    if (code === "0") return "done";
    if (code && code !== "0") return "failed";
    if (log.trim()) return "running";
    return "idle";
  }, [log, statusRaw]);

  const icon =
    state === "done" ? (
      <CheckCircle2 size={15} className="text-[var(--color-success)]" />
    ) : state === "failed" ? (
      <XCircle size={15} className="text-[var(--color-danger)]" />
    ) : state === "running" ? (
      <Loader2 size={15} className="animate-spin text-[var(--color-accent)]" />
    ) : (
      <Clock3 size={15} className="text-[var(--color-muted)]" />
    );

  const title =
    state === "done"
      ? "signed app build complete"
      : state === "failed"
        ? "signed app build failed"
        : state === "running"
          ? "signed app build running"
          : "no active build";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Activity size={15} className="shrink-0 text-[var(--color-accent)]" />
          <div className="min-w-0">
            <div className="truncate text-[12px] font-medium">status</div>
            <div className="truncate text-[10px] text-[var(--color-muted)]">
              builds, installs, long-running shell work
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-[var(--color-faint)]">
            {new Date(lastRead).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title="refresh status"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {workError && (
          <div className="mb-3 rounded-md border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] p-3 text-[11.5px] text-[var(--color-danger)]">
            {workError}
          </div>
        )}

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <MessageSquare size={14} className="text-[var(--color-accent)]" />
                <span className="truncate text-[12px] font-medium">chatpane runs</span>
              </div>
              <span className="font-mono text-[10px] text-[var(--color-faint)]">{liveChats.length}</span>
            </div>
            <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto p-2">
              {liveChats.length === 0 ? (
                <div className="px-1 py-4 text-center text-[11.5px] text-[var(--color-muted)]">no detached chat runs</div>
              ) : (
                liveChats.map((chat) => (
                  <div
                    key={chat.id}
                    className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 hover:border-[var(--color-accent)]/50"
                  >
                    <button
                      type="button"
                      onClick={() => onReattachChat?.(chat)}
                      disabled={!onReattachChat}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
                      title="reattach chatpane"
                    >
                      <span className={`status-dot shrink-0 ${chat.busy ? "status-dot--active" : "status-dot--cold"}`} />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-2)]">{chat.title || "chat"}</span>
                      <span className="shrink-0 font-mono text-[9.5px] text-[var(--color-faint)]">{chat.busy ? "working" : "done"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void stopChat(chat)}
                      disabled={stoppingChatId === chat.id}
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)] hover:text-[var(--color-danger)] disabled:opacity-50"
                      title="stop chat run"
                    >
                      {stoppingChatId === chat.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Square size={11} className="fill-current" />
                      )}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <Bot size={14} className="text-[var(--color-accent)]" />
                <span className="truncate text-[12px] font-medium">background agents</span>
              </div>
              <span className="font-mono text-[10px] text-[var(--color-faint)]">{agents.length}</span>
            </div>
            <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto p-2">
              {agents.length === 0 ? (
                <div className="px-1 py-4 text-center text-[11.5px] text-[var(--color-muted)]">no background agents</div>
              ) : (
                agents.map((agent) => (
                  <div
                    key={agent.name}
                    className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
                  >
                    <span className={`status-dot shrink-0 ${agent.attached ? "status-dot--active" : "status-dot--dormant"}`} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-2)]">{agent.name.replace(/^aios-/, "")}</span>
                    <span className="shrink-0 font-mono text-[9.5px] text-[var(--color-faint)]">{agent.attached ? "attached" : "detached"}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch size={14} className="text-[var(--color-accent)]" />
              <span className="truncate text-[12px] font-medium">source state</span>
            </div>
            <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-faint)]">
              {source?.branch || "unknown"}
            </span>
          </div>
          <div className="grid gap-2 p-3 md:grid-cols-[220px_minmax(0,1fr)]">
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
              <div className="mb-1 text-[9px] uppercase tracking-wide text-[var(--color-faint)]">working tree</div>
              <div className="text-[12px] font-medium text-[var(--color-text-2)]">
                {source?.root ? `${source.dirty} changed` : "source repo not found"}
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-[var(--color-faint)]">
                {source?.root ?? "set aios_shell_source_root"}
              </div>
            </div>
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
              {source?.root && source.dirty > 0 ? (
                <>
                  <div className="mb-2 flex items-center gap-2 text-[11.5px] text-[var(--color-warning)]">
                    <AlertTriangle size={13} />
                    source has changes not guaranteed to be in the installed app
                  </div>
                  <div className="grid max-h-28 gap-1 overflow-y-auto">
                    {source.changed.map((entry) => (
                      <div key={`${entry.status}:${entry.path}`} className="flex min-w-0 items-center gap-2 text-[11px]">
                        <span className="w-4 shrink-0 rounded border border-[var(--color-border)] text-center font-mono text-[9px] text-[var(--color-faint)]">
                          {entry.status}
                        </span>
                        <span className="truncate font-mono text-[var(--color-text-2)]">{relPath(source.root, entry.path)}</span>
                      </div>
                    ))}
                    {source.dirty > source.changed.length && (
                      <div className="font-mono text-[10px] text-[var(--color-faint)]">
                        +{source.dirty - source.changed.length} more
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex h-full min-h-16 items-center text-[11.5px] text-[var(--color-muted)]">
                  {source?.root ? "source tree clean; installed app can be considered current after a fresh signed build" : "no source state available"}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {icon}
              <span className="truncate text-[12px] font-medium">{title}</span>
            </div>
            <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-faint)]">
              tauri
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 border-b border-[var(--color-border)] p-3 text-[11px]">
            <div className="min-w-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
              <div className="mb-1 text-[9px] uppercase tracking-wide text-[var(--color-faint)]">log</div>
              <div className="truncate font-mono text-[var(--color-text-2)]">{BUILD_LOG}</div>
            </div>
            <div className="min-w-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
              <div className="mb-1 text-[9px] uppercase tracking-wide text-[var(--color-faint)]">status</div>
              <div className="truncate font-mono text-[var(--color-text-2)]">
                {statusRaw == null ? "pending" : statusRaw.trim() || "pending"}
              </div>
            </div>
          </div>
          <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap p-3 font-mono text-[10.5px] leading-relaxed text-[var(--color-text-2)]">
            {tail(log) || "no log yet"}
          </pre>
        </div>

        <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-3">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-medium">
            <FileText size={14} className="text-[var(--color-muted)]" />
            pending install note
          </div>
          <p className="text-[11.5px] leading-relaxed text-[var(--color-muted)]">
            when the tauri build finishes, this pane shows whether the signed app is ready. reinstall should happen only after status is 0 and codesign verifies the app bundle.
          </p>
        </div>
      </div>
    </div>
  );
}
