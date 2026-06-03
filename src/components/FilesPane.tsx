/** Files pane — a VS Code-style explorer tree. Nested expandable folders,
 *  file-type icons, git status decorations (M/A/D/U + folder change-dots),
 *  indent guides. Single-click a file opens it (editor pane for code, viewer
 *  for media). Rows stay draggable → drop onto a terminal/chat to insert the
 *  path. Files open in the Monaco editor now, so there's no inline preview. */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ChevronRight,
  FolderClosed,
  FolderOpen,
  Home,
  ListCollapse,
  RefreshCw,
  Search,
} from "lucide-react";

import {
  gitStatus,
  homeDir,
  readDirTree,
  type DirEntry,
  type GitCode,
} from "../lib/fs";
import { AIOS_PATH_MIME } from "../lib/paneBus";
import { fileIcon } from "../lib/fileIcons";

const GIT_COLOR: Record<GitCode, string> = {
  M: "#e2b341", // modified — amber
  A: "#73c991", // added (staged) — green
  U: "#73c991", // untracked — green
  D: "#e05252", // deleted — red
  R: "#6cb6ff", // renamed — blue
};

export function FilesPane({
  initialRoot,
  onOpenFile,
}: {
  initialRoot?: string;
  onOpenFile?: (path: string, name: string) => void;
}) {
  const [root, setRoot] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, DirEntry[]>>(new Map());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [git, setGit] = useState<Map<string, GitCode>>(new Map());
  const [gitFolders, setGitFolders] = useState<Set<string>>(new Set());
  const [gitRoot, setGitRoot] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (path: string) => {
    setLoadingDirs((s) => new Set(s).add(path));
    try {
      const list = await readDirTree(path);
      setChildren((m) => new Map(m).set(path, list));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDirs((s) => {
        const n = new Set(s);
        n.delete(path);
        return n;
      });
    }
  }, []);

  const refreshGit = useCallback(async (path: string) => {
    try {
      const st = await gitStatus(path);
      setGitRoot(st.root);
      const m = new Map<string, GitCode>();
      const folders = new Set<string>();
      const stop = st.root ?? "";
      for (const e of st.entries) {
        m.set(e.path, e.status);
        let dir = e.path.slice(0, e.path.lastIndexOf("/"));
        while (dir && dir.length >= stop.length) {
          folders.add(dir);
          if (dir === stop) break;
          const next = dir.slice(0, dir.lastIndexOf("/"));
          if (next === dir) break;
          dir = next;
        }
      }
      setGit(m);
      setGitFolders(folders);
    } catch {
      setGit(new Map());
      setGitFolders(new Set());
      setGitRoot(null);
    }
  }, []);

  const setRootTo = useCallback(
    (path: string) => {
      setRoot(path);
      setChildren(new Map());
      setExpanded(new Set([path]));
      setSelected(null);
      loadDir(path);
      refreshGit(path);
    },
    [loadDir, refreshGit],
  );

  // initial: open the requested directory, falling back to the user's home
  useEffect(() => {
    (async () => {
      setRootTo(initialRoot || (await homeDir()));
    })();
  }, [initialRoot, setRootTo]);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const n = new Set(prev);
        if (n.has(path)) {
          n.delete(path);
        } else {
          n.add(path);
          if (!children.has(path)) loadDir(path);
        }
        return n;
      });
    },
    [children, loadDir],
  );

  const openFile = (e: DirEntry) => {
    setSelected(e.path);
    onOpenFile?.(e.path, e.name);
  };

  const refreshAll = useCallback(() => {
    for (const p of expanded) loadDir(p);
    if (!children.has(root)) loadDir(root);
    refreshGit(root);
  }, [expanded, children, root, loadDir, refreshGit]);

  const collapseAll = () => setExpanded(new Set([root]));
  const goUp = () => {
    const parent = root.replace(/\/[^/]+\/?$/, "") || "/";
    if (parent !== root) setRootTo(parent);
  };

  const rootName = root.split("/").filter(Boolean).pop() ?? root;
  const f = filter.trim().toLowerCase();

  // flatten the visible tree into rows (respecting expand state + filter)
  const rows = useMemo(() => {
    const out: { entry: DirEntry; depth: number }[] = [];
    const walk = (path: string, depth: number) => {
      const list = children.get(path);
      if (!list) return;
      for (const e of list) {
        if (f && !e.is_dir && !e.name.toLowerCase().includes(f)) continue;
        out.push({ entry: e, depth });
        if (e.is_dir && expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [children, expanded, root, f]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)] text-[13px]">
      {/* header: root + actions */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-2 text-[var(--color-muted)]">
        <button onClick={() => homeDir().then(setRootTo)} className="rounded p-1 hover:text-[var(--color-text)]" title="Home">
          <Home size={13} />
        </button>
        <button
          onClick={goUp}
          className="truncate px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-2)] hover:text-[var(--color-text)]"
          title={`${root}\n(click to go up)`}
        >
          {rootName}
        </button>
        {gitRoot && (
          <span className="shrink-0 font-mono text-[9.5px] text-[var(--color-faint)]" title={`git repo · ${gitRoot}`}>
            git
          </span>
        )}
        <span className="flex-1" />
        <button onClick={collapseAll} className="rounded p-1 hover:text-[var(--color-text)]" title="Collapse all">
          <ListCollapse size={13} />
        </button>
        <button onClick={refreshAll} className="rounded p-1 hover:text-[var(--color-text)]" title="Refresh">
          <RefreshCw size={12} className={loadingDirs.size ? "animate-spin" : ""} />
        </button>
      </div>

      {/* filter */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-2.5 py-1.5">
        <Search size={12} className="text-[var(--color-faint)]" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter files…"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
        />
      </div>

      {error && <p className="px-3 py-2 text-[12px] text-[var(--color-danger)]">{error}</p>}

      {/* tree */}
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {rows.map(({ entry, depth }) => (
          <TreeRow
            key={entry.path}
            entry={entry}
            depth={depth}
            open={expanded.has(entry.path)}
            loading={loadingDirs.has(entry.path)}
            selected={selected === entry.path}
            gitCode={git.get(entry.path)}
            folderDirty={entry.is_dir && gitFolders.has(entry.path)}
            onToggle={() => toggle(entry.path)}
            onOpen={() => openFile(entry)}
          />
        ))}
        {!rows.length && (
          <p className="px-3 py-2 text-[12px] text-[var(--color-muted)]/60">
            {f ? "no matches" : loadingDirs.size ? "loading…" : "empty"}
          </p>
        )}
      </div>
    </div>
  );
}

function TreeRow({
  entry,
  depth,
  open,
  loading,
  selected,
  gitCode,
  folderDirty,
  onToggle,
  onOpen,
}: {
  entry: DirEntry;
  depth: number;
  open: boolean;
  loading: boolean;
  selected: boolean;
  gitCode?: GitCode;
  folderDirty: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const isDir = entry.is_dir;
  const { Icon, color } = fileIcon(entry.name);
  const nameColor = gitCode
    ? GIT_COLOR[gitCode]
    : isDir
      ? "var(--color-text-2)"
      : "var(--color-text-2)";

  return (
    <div
      draggable
      onDragStart={(ev) => {
        ev.dataTransfer.setData("text/plain", entry.path);
        ev.dataTransfer.setData(AIOS_PATH_MIME, entry.path);
        ev.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => (isDir ? onToggle() : onOpen())}
      onDoubleClick={() => !isDir && onOpen()}
      title={entry.path}
      className={`group flex cursor-pointer items-center gap-1 pr-2 transition-colors ${
        selected ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel-2)]"
      }`}
      style={{ height: 22 }}
    >
      {/* indent guides */}
      {Array.from({ length: depth }).map((_, i) => (
        <span key={i} className="h-full w-3 shrink-0 border-l border-[var(--color-border)]/40" />
      ))}

      {/* chevron (dirs) or spacer */}
      {isDir ? (
        <ChevronRight
          size={12}
          className={`shrink-0 text-[var(--color-faint)] transition-transform ${open ? "rotate-90" : ""}`}
        />
      ) : (
        <span className="w-3 shrink-0" />
      )}

      {/* icon */}
      {isDir ? (
        open ? (
          <FolderOpen size={14} className="shrink-0 text-[var(--color-accent)]/80" />
        ) : (
          <FolderClosed size={14} className="shrink-0 text-[var(--color-accent)]/80" />
        )
      ) : (
        <Icon size={14} className="shrink-0" style={{ color }} />
      )}

      {/* name */}
      <span
        className="min-w-0 flex-1 truncate"
        style={{ color: nameColor, fontWeight: gitCode || folderDirty ? 500 : 400 }}
      >
        {entry.name}
      </span>

      {/* git decoration: a letter for files, a dot for changed folders */}
      {gitCode ? (
        <span className="shrink-0 font-mono text-[10px]" style={{ color: GIT_COLOR[gitCode] }}>
          {gitCode}
        </span>
      ) : folderDirty ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
      ) : null}

      {loading && <span className="shrink-0 font-mono text-[9px] text-[var(--color-faint)]">…</span>}
    </div>
  );
}
