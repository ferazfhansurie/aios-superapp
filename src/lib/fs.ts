import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  /** Last-modified time in unix seconds (0 if unavailable). */
  mtime: number;
}

export type FilePreviewKind = "text" | "image" | "pdf" | "office" | "binary";

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

/** Dir listing for the VS Code-style tree — includes dotfiles (hides .git/.DS_Store). */
export async function readDirTree(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("read_dir_tree", { path });
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

/** Git status for the repo containing `path` (absolute path → status letter). */
export async function gitStatus(path: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { path });
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
  return convertFileSrc(path);
}

/** Reads a file's full UTF-8 contents for the editor pane (≤8 MB, text only). */
export async function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

/** Writes UTF-8 contents back to a file (editor save, atomic via temp+rename). */
export async function writeTextFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_text_file", { path, content });
}

/** Deletes a single file (notes CRUD). No-op if it's already gone; refuses dirs. */
export async function deletePath(path: string): Promise<void> {
  return invoke<void>("delete_path", { path });
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
