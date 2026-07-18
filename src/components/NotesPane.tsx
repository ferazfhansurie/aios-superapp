import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Plus, Search, Send, Trash2 } from "lucide-react";

import {
  createNote,
  deleteNote,
  listNotes,
  saveNote,
  titleOf,
  type Note,
} from "../lib/notes";
import { reportDiag } from "../lib/diag";
import { useVisible } from "../lib/useVisible";

/** Relative "edited" stamp — apple-notes-ish (Today / Yesterday / date). */
function relTime(unixSec: number): string {
  if (!unixSec) return "";
  const ms = unixSec * 1000;
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Apple-Notes-style scratch pane. Notes are markdown files under
 *  `~/.aios/notes/` (the oracle reads/writes the same files), so firaz can dump
 *  ideas here and hand the whole note to AIOS in one shot via "send to oracle".
 *  Full CRUD: new / edit (autosave) / delete; live search; cross-process sync
 *  (a gentle poll surfaces notes the oracle adds or edits). */
export function NotesPane({
  active = true,
  onSend,
}: {
  active?: boolean;
  onSend?: (text: string) => void;
}) {
  const { ref: rootRef, visible: paneVisible } = useVisible<HTMLDivElement>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  const dirtyRef = useRef(false);
  const selectedRef = useRef<string | null>(null);
  const draftRef = useRef("");
  const saveTimer = useRef<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  selectedRef.current = selected;
  draftRef.current = draft;

  // Flush the active note to disk now (used before switching notes / unmount).
  const flush = useCallback(async () => {
    if (!dirtyRef.current || !selectedRef.current) return;
    const path = selectedRef.current;
    const body = draftRef.current;
    dirtyRef.current = false;
    setStatus("saving");
    try {
      await saveNote(path, body);
      setStatus("saved");
    } catch {
      dirtyRef.current = true; // let a later save retry
      setStatus("idle");
    }
  }, []);

  // Reload the list from disk. Preserves selection; refreshes the open note's
  // body from disk ONLY when it isn't being actively edited (so the oracle's
  // edits show up without clobbering in-flight typing).
  const reload = useCallback(async () => {
    const list = await listNotes();
    setNotes(list);
    setSelected((cur) => {
      if (cur && list.some((n) => n.path === cur)) {
        if (!dirtyRef.current) {
          const fresh = list.find((n) => n.path === cur);
          if (fresh) setDraft(fresh.body);
        }
        return cur;
      }
      // selection gone (or none yet) → pick the newest.
      const first = list[0]?.path ?? null;
      if (first) setDraft(list[0].body);
      return first;
    });
  }, []);

  useEffect(() => {
    if (!active || !paneVisible) return;
    reload();
    const t = setInterval(reload, 5_000);
    return () => {
      clearInterval(t);
      // best-effort final save on unmount.
      if (dirtyRef.current && selectedRef.current) {
        saveNote(selectedRef.current, draftRef.current).catch((e) => reportDiag("notes.save", e, { action: "unmountSave" }));
      }
    };
  }, [active, paneVisible, reload]);

  // Switch the open note (flushing the previous one first).
  const select = useCallback(
    async (path: string) => {
      if (path === selectedRef.current) return;
      await flush();
      const n = notes.find((x) => x.path === path);
      setSelected(path);
      setDraft(n?.body ?? "");
      dirtyRef.current = false;
      setStatus("idle");
    },
    [flush, notes],
  );

  const onChange = useCallback((v: string) => {
    setDraft(v);
    dirtyRef.current = true;
    setStatus("saving");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const path = selectedRef.current;
      if (!path) return;
      try {
        await saveNote(path, draftRef.current);
        dirtyRef.current = false;
        setStatus("saved");
        // refresh list title/preview/order without yanking the editor.
        listNotes().then(setNotes).catch((e) => reportDiag("notes.load", e, { action: "list" }));
      } catch {
        setStatus("idle");
      }
    }, 600);
  }, []);

  const onNew = useCallback(async () => {
    await flush();
    try {
      const path = await createNote("");
      await reload();
      setSelected(path);
      setDraft("");
      dirtyRef.current = false;
      setStatus("idle");
      requestAnimationFrame(() => taRef.current?.focus());
    } catch {
      /* ignore — disk error surfaced via empty list */
    }
  }, [flush, reload]);

  const onDelete = useCallback(async () => {
    const path = selectedRef.current;
    if (!path) return;
    dirtyRef.current = false;
    try {
      await deleteNote(path);
    } catch {
      /* ignore */
    }
    setSelected(null);
    setDraft("");
    await reload();
  }, [reload]);

  const onSendToOracle = useCallback(() => {
    const body = draftRef.current.trim();
    if (!body || !onSend) return;
    onSend(body);
  }, [onSend]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => n.body.toLowerCase().includes(q));
  }, [notes, query]);

  const liveTitle = titleOf(draft);
  const wordCount = draft.trim() ? draft.trim().split(/\s+/).length : 0;

  return (
    <div ref={rootRef} className="flex h-full min-h-0 bg-[var(--color-pane)] text-[var(--color-text)]">
      {/* list column */}
      <div className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)]">
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] p-2">
          <div className="relative flex-1">
            <Search
              size={12}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-faint)]"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search"
              spellCheck={false}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1 pl-7 pr-2 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60"
            />
          </div>
          <button
            onClick={onNew}
            title="new note (⌘N within pane)"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)]"
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-[var(--color-faint)]">
              {query ? "no matches" : "no notes yet — tap +"}
            </div>
          ) : (
            filtered.map((n) => {
              const active = n.path === selected;
              return (
                <button
                  key={n.path}
                  onClick={() => select(n.path)}
                  className={`flex w-full flex-col gap-0.5 border-b border-[var(--color-border)]/50 px-3 py-2 text-left transition-colors ${
                    active
                      ? "bg-[var(--color-accent-soft)]"
                      : "hover:bg-[var(--color-panel-2)]/50"
                  }`}
                >
                  <span className="truncate text-[12px] font-medium text-[var(--color-text)]">
                    {n.title}
                  </span>
                  <span className="flex items-center gap-1.5 text-[10px] text-[var(--color-faint)]">
                    <span className="shrink-0">{relTime(n.mtime)}</span>
                    <span className="truncate text-[var(--color-muted)]">{n.preview}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* editor column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex h-8 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
              <span className="truncate text-[11px] text-[var(--color-muted)]">{liveTitle}</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-[var(--color-faint)]">
                  {status === "saving" ? "saving…" : status === "saved" ? "saved" : ""}
                </span>
                {onSend && (
                  <button
                    onClick={onSendToOracle}
                    title="send this note to the oracle (active chat)"
                    className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)]"
                  >
                    <Send size={11} />
                    send
                  </button>
                )}
                <button
                  onClick={onDelete}
                  title="delete note"
                  className="grid h-6 w-6 place-items-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-danger)]"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => onChange(e.target.value)}
              onBlur={() => flush()}
              placeholder="brain-dump here — first line is the title. tap send to hand it to the oracle."
              spellCheck={false}
              className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
            />
            <div className="flex h-6 shrink-0 items-center justify-end border-t border-[var(--color-border)] px-3 text-[10px] text-[var(--color-faint)]">
              {wordCount} {wordCount === 1 ? "word" : "words"}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[var(--color-faint)]">
            <FileText size={28} className="opacity-40" />
            <span className="text-[12px]">no note selected</span>
            <button
              onClick={onNew}
              className="mt-1 flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)]"
            >
              <Plus size={13} />
              new note
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
