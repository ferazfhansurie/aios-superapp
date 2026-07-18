import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  FileText,
  FolderOpen,
  GitBranch as GitBranchIcon,
  MessageSquare,
  RefreshCw,
  Search,
  TerminalSquare,
} from "lucide-react";

import {
  gitCheckout,
  gitCommit,
  gitSnapshot,
  shellSourceStatus,
  type GitBranch,
  type GitCode,
  type GitEntry,
  type GitSnapshot,
} from "../lib/fs";
import { openEditorFileInPane, spawnPane } from "../lib/paneBus";

const STATUS_LABEL: Record<GitCode, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  U: "untracked",
};

const STATUS_CLASS: Record<GitCode, string> = {
  M: "text-[#e2b341]",
  A: "text-[#73c991]",
  D: "text-[#e05252]",
  R: "text-[#6cb6ff]",
  U: "text-[#73c991]",
};

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function relPath(root: string | null, path: string): string {
  if (!root) return path;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function dirOfRel(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx > 0 ? rel.slice(0, idx) : "";
}

function buildGitChatSeed(snapshot: GitSnapshot): string {
  const root = snapshot.root ?? "";
  const changes = snapshot.entries
    .slice(0, 30)
    .map((entry) => `- ${entry.status} ${relPath(root, entry.path)}`)
    .join("\n");
  const graph = snapshot.graph
    .slice(0, 12)
    .map((line) => line.text)
    .join("\n");

  return [
    "use this git context for the repo and help me decide the next best source-control action.",
    "",
    `repo: ${root}`,
    `branch: ${snapshot.current || "detached"}`,
    `ahead: ${snapshot.ahead}`,
    `behind: ${snapshot.behind}`,
    `changed files: ${snapshot.entries.length}`,
    changes ? `\nchanges:\n${changes}` : "\nchanges: clean",
    graph ? `\nrecent graph:\n${graph}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function GitPane({ initialRoot }: { initialRoot?: string }) {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [root, setRoot] = useState(initialRoot ?? "");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"refresh" | "switch" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSnapshot = useCallback(async (path: string) => {
    setBusy("refresh");
    try {
      const next = await gitSnapshot(path);
      setSnapshot(next);
      setRoot(next.root ?? path);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const source = initialRoot || (await shellSourceStatus().catch(() => null))?.root || "";
      if (!alive) return;
      await loadSnapshot(source);
    })();
    return () => {
      alive = false;
    };
  }, [initialRoot, loadSnapshot]);

  const branches = useMemo(() => snapshot?.branches ?? [], [snapshot]);
  const filteredBranches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((branch) => branch.name.toLowerCase().includes(q));
  }, [branches, query]);

  const entries = snapshot?.entries ?? [];
  const dirtyCount = entries.length;

  const refresh = useCallback(() => {
    if (root) void loadSnapshot(root);
  }, [loadSnapshot, root]);

  const switchBranch = useCallback(
    async (branch: GitBranch) => {
      if (!snapshot?.root || branch.current || branch.remote) return;
      setBusy("switch");
      try {
        const next = await gitCheckout(snapshot.root, branch.name);
        setSnapshot(next);
        setRoot(next.root ?? snapshot.root);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [snapshot],
  );

  const commitAll = useCallback(async () => {
    if (!snapshot?.root || !message.trim()) return;
    setBusy("commit");
    try {
      const next = await gitCommit(snapshot.root, message);
      setSnapshot(next);
      setRoot(next.root ?? snapshot.root);
      setMessage("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [message, snapshot]);

  const openChangedFile = useCallback(
    (entry: GitEntry) => {
      openEditorFileInPane(entry.path, basename(entry.path));
    },
    [],
  );

  const openRepoFiles = useCallback(() => {
    if (!snapshot?.root) return;
    spawnPane("files", { path: snapshot.root, label: `files - ${basename(snapshot.root)}` });
  }, [snapshot]);

  const openRepoTerminal = useCallback(() => {
    if (!snapshot?.root) return;
    spawnPane("terminal", { cwd: snapshot.root, label: `terminal - ${basename(snapshot.root)}` });
  }, [snapshot]);

  const openGitChat = useCallback(() => {
    if (!snapshot?.root) return;
    spawnPane("chat", {
      cwd: snapshot.root,
      seed: buildGitChatSeed(snapshot),
      label: `chat - git ${snapshot.current || basename(snapshot.root)}`,
    });
  }, [snapshot]);

  if (!snapshot?.root) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)] text-[13px] text-[var(--color-text)]">
        <GitPaneHeader busy={busy} onRefresh={() => root && loadSnapshot(root)} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <GitBranchIcon size={28} className="text-[var(--color-faint)]" />
          <div className="text-[15px] font-medium">no git repo selected</div>
          <div className="max-w-sm text-[12px] leading-5 text-[var(--color-muted)]">
            open git from a files pane or use the source checkout. this pane will show branches, changes, commits, and chat handoff.
          </div>
          {error && <div className="max-w-sm rounded border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] text-[var(--color-danger)]">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)] text-[13px] text-[var(--color-text)]">
      <GitPaneHeader busy={busy} onRefresh={refresh} />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 w-[42%] min-w-[260px] flex-col border-r border-[var(--color-border)]">
          <div className="border-b border-[var(--color-border)] px-3 py-2">
            <div className="flex items-center gap-2">
              <GitBranchIcon size={15} className="text-[var(--color-accent)]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold">{snapshot.current || "detached"}</div>
                <div className="truncate font-mono text-[10px] text-[var(--color-faint)]" title={snapshot.root}>
                  {snapshot.root}
                </div>
              </div>
              {(snapshot.ahead > 0 || snapshot.behind > 0) && (
                <div className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
                  {snapshot.ahead} up / {snapshot.behind} down
                </div>
              )}
            </div>
            <div className="mt-2 flex gap-1.5">
              <button
                className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2 text-[11px] text-[var(--color-text-2)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                type="button"
                onClick={openRepoFiles}
              >
                <FolderOpen size={13} /> files
              </button>
              <button
                className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2 text-[11px] text-[var(--color-text-2)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                type="button"
                onClick={openRepoTerminal}
              >
                <TerminalSquare size={13} /> terminal
              </button>
              <button
                className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2 text-[11px] text-[var(--color-text-2)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                type="button"
                onClick={openGitChat}
              >
                <MessageSquare size={13} /> chat
              </button>
            </div>
          </div>

          <div className="border-b border-[var(--color-border)] p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]">changes</div>
              <div className="rounded-full bg-[var(--color-accent)]/20 px-2 py-0.5 font-mono text-[10px] text-[var(--color-accent)]">{dirtyCount}</div>
            </div>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void commitAll();
                }
              }}
              placeholder={`message (#enter to commit on "${snapshot.current || "branch"}")`}
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)] focus:border-[var(--color-accent)]/70"
            />
            <button
              type="button"
              onClick={commitAll}
              disabled={!message.trim() || dirtyCount === 0 || busy === "commit"}
              className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[var(--color-accent)]/50 bg-[var(--color-accent)]/70 text-[13px] font-semibold text-[var(--color-accent-fg)] disabled:cursor-not-allowed disabled:border-[var(--color-border)] disabled:bg-[var(--color-panel-2)] disabled:text-[var(--color-muted)]"
            >
              <Check size={15} /> commit all
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {entries.length === 0 ? (
              <div className="px-3 py-8 text-center text-[12px] text-[var(--color-muted)]">working tree clean</div>
            ) : (
              entries.map((entry) => {
                const rel = relPath(snapshot.root, entry.path);
                const dir = dirOfRel(rel);
                return (
                  <button
                    key={`${entry.status}:${entry.path}`}
                    type="button"
                    onClick={() => openChangedFile(entry)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-panel-2)]"
                    title={`${STATUS_LABEL[entry.status]} - ${entry.path}`}
                  >
                    <FileText size={13} className="shrink-0 text-[var(--color-muted)]" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{basename(rel)}</span>
                    {dir && <span className="max-w-[42%] truncate font-mono text-[10px] text-[var(--color-faint)]">{dir}</span>}
                    <span className={`shrink-0 font-mono text-[11px] font-semibold ${STATUS_CLASS[entry.status]}`}>{entry.status}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-[var(--color-border)] p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]">branches</div>
            <div className="flex h-8 items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2">
              <Search size={13} className="text-[var(--color-faint)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search branches"
                className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--color-faint)]"
              />
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-rows-[minmax(120px,42%)_1fr]">
            <div className="min-h-0 overflow-y-auto border-b border-[var(--color-border)] py-1">
              {filteredBranches.map((branch) => (
                <button
                  key={`${branch.remote ? "r" : "l"}:${branch.name}`}
                  type="button"
                  disabled={branch.current || branch.remote || busy === "switch"}
                  onClick={() => switchBranch(branch)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-panel-2)] disabled:cursor-default ${
                    branch.current ? "bg-[var(--color-accent)]/12 text-[var(--color-text)]" : "text-[var(--color-text-2)]"
                  }`}
                  title={branch.remote ? "remote branch - create local tracking branch from terminal for now" : branch.name}
                >
                  <GitBranchIcon size={13} className={branch.current ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"} />
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.current && <span className="rounded bg-[var(--color-accent)]/20 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-accent)]">current</span>}
                  {branch.remote && <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-faint)]">remote</span>}
                </button>
              ))}
              {filteredBranches.length === 0 && (
                <div className="px-3 py-6 text-center text-[12px] text-[var(--color-muted)]">no branches match</div>
              )}
            </div>

            <div className="min-h-0 overflow-y-auto p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]">graph</div>
                <div className="font-mono text-[10px] text-[var(--color-faint)]">{snapshot.graph.length} commits</div>
              </div>
              {snapshot.graph.length === 0 ? (
                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-6 text-center text-[12px] text-[var(--color-muted)]">
                  no graph yet
                </div>
              ) : (
                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-2 font-mono text-[11px] leading-5 text-[var(--color-text-2)]">
                  {snapshot.graph.map((line, idx) => (
                    <div key={`${idx}:${line.text}`} className="truncate" title={line.text}>
                      {line.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="border-t border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] text-[var(--color-danger)]">
          {error}
        </div>
      )}
    </div>
  );
}

function GitPaneHeader({
  busy,
  onRefresh,
}: {
  busy: "refresh" | "switch" | "commit" | null;
  onRefresh: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
      <div className="min-w-0 flex-1 text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-2)]">
        source control
      </div>
      {busy && <span className="font-mono text-[10px] text-[var(--color-faint)]">{busy}</span>}
      <button
        type="button"
        onClick={onRefresh}
        className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        title="refresh git"
      >
        <RefreshCw size={13} className={busy === "refresh" ? "animate-spin" : ""} />
      </button>
    </div>
  );
}
