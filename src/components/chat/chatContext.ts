/** Chat pane react contexts — moved verbatim out of ChatPane.tsx (mechanical
 *  split, no behavior change). */
import { createContext, useContext } from "react";
import { openFileInPane } from "../../lib/paneBus";
import { resolvePaneFileTarget, targetLabel } from "../../lib/paneRouting";

// ── deterministic in-chat file open ──────────────────────────────────────────
//
// Opening a file the model mentioned must NOT rely on the model or on a
// name-search-and-hope. Two reliable sources:
//   1. ABSOLUTE paths harvested from tool_use inputs (Read/Edit/Write/… file_path,
//      codex apply_patch path) — already model-verified, opened directly.
//   2. text/code-fence mentions → resolved against the session cwd by the backend
//      (`resolve_in_cwd`), which returns a real absolute path ONLY if the file
//      exists. A bounded fuzzy `find_files` is the LAST resort (exact-join first).
// Everything routes through `openFileInPane` (paneBus) → identical to FilesPane.
//
// `cwd` is provided once at the ChatPane root via this context so the deep
// markdown/inline/tool renderers don't each need it threaded through.

export type ChatFileOpener = (ref: string) => void;
export const ChatFileOpenContext = createContext<ChatFileOpener | null>(null);

/** Session cwd, provided once at the ChatPane root so deep renderers (code-fence
 *  "run in terminal" affordance) can spawn a terminal rooted in the same dir
 *  without threading cwd through every layer. */
export const ChatCwdContext = createContext<string | null>(null);

export function useChatCwd(): string | null {
  return useContext(ChatCwdContext);
}

export function useChatFileOpener(): ChatFileOpener {
  const ctx = useContext(ChatFileOpenContext);
  return (
    ctx ??
    // fallback (no provider, e.g. web/test): open as-is, best-effort.
    ((ref: string) => {
      const path = resolvePaneFileTarget(ref);
      openFileInPane(path, targetLabel(path));
    })
  );
}
