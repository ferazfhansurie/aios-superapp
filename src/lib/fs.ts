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

/** Converts an office doc (docx/xlsx/pptx/…) to a cached PDF via headless
 *  LibreOffice and returns the resulting PDF path. Slow on first call (~1-3s),
 *  instant on re-open. Render the returned path with {@link fileSrc} in an iframe. */
export async function convertOfficeToPdf(path: string): Promise<string> {
  return invoke<string>("convert_office_to_pdf", { path });
}
