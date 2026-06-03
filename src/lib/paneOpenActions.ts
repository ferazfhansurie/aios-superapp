import type { PaneContent } from "./apps";

export type PaneFileTarget = {
  path: string;
  name: string;
};

export function paneFileTarget(kind: PaneContent): PaneFileTarget | null {
  if (kind.type !== "editor" && kind.type !== "file") return null;
  return {
    path: kind.path,
    name: kind.name || kind.path.split("/").filter(Boolean).pop() || kind.path,
  };
}

export function containingDir(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "/";
  return normalized.slice(0, idx);
}
