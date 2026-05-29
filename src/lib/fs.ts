import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export type FilePreviewKind = "text" | "image" | "pdf" | "binary";

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

export async function homeDir(): Promise<string> {
  return invoke<string>("home_dir");
}

export async function readFilePreview(path: string): Promise<FilePreview> {
  return invoke<FilePreview>("read_file_preview", { path });
}

/** Asset-protocol URL for rendering a local file (images/pdf) in the webview. */
export function fileSrc(path: string): string {
  return convertFileSrc(path);
}
