import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke, isTauriRuntime } from "./tauri";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  /** Last-modified time in unix seconds (0 if unavailable). */
  mtime: number;
}

export type FilePreviewKind = "text" | "image" | "pdf" | "office" | "video" | "binary";

export interface FilePreview {
  kind: FilePreviewKind;
  /** Inline contents for text files; null for image/pdf/binary. */
  text: string | null;
  /** File size in bytes. */
  size: number;
  name: string;
  /** True when a text preview was capped (~256 KB). */
  truncated: boolean;
}

export async function readDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("read_dir", { path });
}

/** Dir listing for the VS Code-style tree. By default hides dotfiles (VS Code
 *  style) and prunes heavy build/dep dirs (node_modules, target, dist, .next, …),
 *  matching what ⌘P searches. `.git`/`.DS_Store` are always hidden. Pass
 *  `showHidden`/`showAll` to reveal those classes. */
export async function readDirTree(
  path: string,
  showHidden = false,
  showAll = false,
): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("read_dir_tree", { path, showHidden, showAll });
}

export type GitCode = "M" | "A" | "D" | "R" | "U";
export interface GitEntry {
  path: string;
  status: GitCode;
}
export interface GitStatus {
  root: string | null;
  entries: GitEntry[];
}

export interface ShellSourceStatus {
  root: string | null;
  branch: string;
  dirty: number;
  changed: GitEntry[];
}

/** Git status for the repo containing `path` (absolute path → status letter). */
export async function gitStatus(path: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { path });
}

export async function shellSourceStatus(): Promise<ShellSourceStatus> {
  return invoke<ShellSourceStatus>("shell_source_status");
}

/** Compact per-repo git summary for the homescreen "dev pulse" tile. */
export interface RepoPulse {
  root: string;
  name: string;
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
}

/** Branch + dirty-count + ahead/behind for each repo path (best-effort). */
export async function gitPulse(paths: string[]): Promise<RepoPulse[]> {
  return invoke<RepoPulse[]>("git_pulse", { paths });
}

export async function homeDir(): Promise<string> {
  return invoke<string>("home_dir");
}

export async function startupOpenPane(): Promise<string | null> {
  return invoke<string | null>("startup_open_pane");
}

export async function readFilePreview(path: string): Promise<FilePreview> {
  return invoke<FilePreview>("read_file_preview", { path });
}

/** Asset-protocol URL for rendering a local file (images/pdf) in the webview. */
export function fileSrc(path: string): string {
  if (!isTauriRuntime()) return path;
  return convertFileSrc(path);
}

/** Reads a file's full UTF-8 contents for the editor pane (≤8 MB, text only). */
export async function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

/** File last-modified time in unix MILLISECONDS (0 if missing). The editor pane
 *  captures this on load for save-conflict detection. */
export async function fileMtime(path: string): Promise<number> {
  return invoke<number>("file_mtime", { path });
}

/** Thrown by {@link writeTextFile} when the on-disk file changed since the
 *  editor loaded it (AI or human edited it underneath us). `currentMtime` is the
 *  file's now-current mtime in ms, for re-basing after an explicit overwrite. */
export class SaveConflictError extends Error {
  constructor(public currentMtime: number) {
    super("file changed on disk");
    this.name = "SaveConflictError";
  }
}

/** Writes UTF-8 contents back to a file (editor save, atomic via temp+rename).
 *  When `expectedMtime` is given, the backend refuses the write if the file
 *  changed on disk since load (throws {@link SaveConflictError}). Returns the
 *  file's new mtime in ms so the caller can re-base its conflict guard. */
export async function writeTextFile(
  path: string,
  content: string,
  expectedMtime?: number,
): Promise<number> {
  try {
    return await invoke<number>("write_text_file", {
      path,
      content,
      expectedMtime: expectedMtime ?? null,
    });
  } catch (e) {
    const msg = String(e);
    const m = /^conflict:([\d.]+)$/.exec(msg);
    if (m) throw new SaveConflictError(Number(m[1]));
    throw e;
  }
}

/** Deletes a single file (notes CRUD). No-op if it's already gone; refuses dirs. */
export async function deletePath(path: string): Promise<void> {
  return invoke<void>("delete_path", { path });
}

/** Flat list of every file under `root` (relative paths), honoring .gitignore +
 *  pruning node_modules. Powers the ⌘P fuzzy finder — call once, cache, score
 *  client-side. `max` caps the walk (default backend = generous). */
export async function findFiles(root: string, max = 20000): Promise<string[]> {
  return invoke<string[]>("find_files", { root, max });
}

/** One content-search hit. `path` is RELATIVE to the search root; `line`/`col`
 *  are 1-based; `text` is the trimmed matching line. */
export interface SearchHit {
  path: string;
  line: number;
  col: number;
  text: string;
}

/** Literal, case-insensitive content search under `root` (ripgrep w/ Rust
 *  fallback). Returns flat hits (≤`max`, default 1000); the UI groups by file.
 *  Powers ⌘⇧F. */
export async function searchInFiles(
  root: string,
  query: string,
  max = 1000,
): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("search_in_files", { root, query, max });
}

/** Converts an office doc (docx/xlsx/pptx/…) to a cached PDF via headless
 *  LibreOffice and returns the resulting PDF path. Slow on first call (~1-3s),
 *  instant on re-open. Render the returned path with {@link fileSrc} in an iframe. */
export async function convertOfficeToPdf(path: string): Promise<string> {
  return invoke<string>("convert_office_to_pdf", { path });
}

/** Persists a pasted/dropped image (raw base64, no data-URL prefix) to a temp
 *  file and returns its path — so a terminal can hand the path to a CLI AI
 *  (claude code) for vision. `ext` is the file extension, e.g. "png". */
export async function saveImageTemp(data: string, ext: string): Promise<string> {
  return invoke<string>("save_image_temp", { data, ext });
}
