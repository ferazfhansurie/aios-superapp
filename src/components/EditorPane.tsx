/** A Monaco-backed code editor pane — VS Code's editor core, so syntax
 *  highlighting, minimap, breadcrumbs, multi-cursor, find/replace all feel
 *  identical. Opens a file from the Files pane, edits in-app, ⌘S to save
 *  (atomic write). This is the foundation of replacing VS Code with the shell. */
import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { openPath } from "@tauri-apps/plugin-opener";
import { Check, Circle, ExternalLink, Loader2 } from "lucide-react";

import { readTextFile, writeTextFile } from "../lib/fs";
import { initMonaco, languageForPath } from "../lib/monaco";

export function EditorPane({ path, name }: { path: string; name: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // keep the latest save fn reachable from the monaco keybinding closure
  const saveRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null;

    (async () => {
      const monaco = initMonaco();
      let content: string;
      try {
        content = await readTextFile(path);
      } catch (e) {
        if (!disposed) {
          setError(String(e));
          setLoading(false);
        }
        return;
      }
      if (disposed || !hostRef.current) return;

      editor = monaco.editor.create(hostRef.current, {
        value: content,
        language: languageForPath(path),
        theme: "aios-dark",
        automaticLayout: true,
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontLigatures: true,
        minimap: { enabled: true },
        smoothScrolling: true,
        cursorBlinking: "smooth",
        scrollBeyondLastLine: false,
        renderWhitespace: "selection",
        tabSize: 2,
        bracketPairColorization: { enabled: true },
        padding: { top: 10 },
      });
      editorRef.current = editor;
      setLoading(false);

      const save = async () => {
        const ed = editorRef.current;
        if (!ed) return;
        try {
          await writeTextFile(path, ed.getValue());
          if (disposed) return;
          setDirty(false);
          setSavedAt(Date.now());
        } catch (e) {
          if (!disposed) setError(String(e));
        }
      };
      saveRef.current = save;

      editor.onDidChangeModelContent(() => {
        if (!disposed) {
          setDirty(true);
          setSavedAt(null);
        }
      });
      // ⌘S / Ctrl+S → save
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
    })();

    return () => {
      disposed = true;
      editor?.getModel()?.dispose();
      editor?.dispose();
      editorRef.current = null;
    };
  }, [path]);

  // a tiny ⌘S affordance that also works when focus is in the header
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        {dirty ? (
          <Circle size={8} className="shrink-0 fill-[var(--color-accent)] text-[var(--color-accent)]" />
        ) : savedAt ? (
          <Check size={11} className="shrink-0 text-[var(--color-success,#22c55e)]" />
        ) : null}
        <span className="truncate font-mono text-[11px] text-[var(--color-text-2)]" title={path}>
          {name}
        </span>
        {dirty && <span className="font-mono text-[10px] text-[var(--color-faint)]">⌘S to save</span>}
        <span className="flex-1" />
        <button
          onClick={() => openPath(path).catch(() => {})}
          className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="open externally"
        >
          <ExternalLink size={12} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full w-full" />
        {loading && (
          <div className="absolute inset-0 grid place-items-center bg-[var(--color-bg)]">
            <Loader2 size={18} className="animate-spin text-[var(--color-accent)]" />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 grid place-items-center bg-[var(--color-bg)] px-6 text-center">
            <div className="flex flex-col items-center gap-2">
              <span className="font-mono text-[12px] text-[var(--color-danger)]">{error}</span>
              <button
                onClick={() => openPath(path).catch(() => {})}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
              >
                open externally instead
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
