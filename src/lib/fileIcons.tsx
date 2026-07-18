/** VS Code-ish file icons: a lucide glyph + a per-language colour keyed by
 *  extension. Keeps the Files tree readable at a glance like the VS Code
 *  explorer. Colours are approximations of the seti-ui palette.
 *
 *  Which glyph a file gets is decided by the canonical classifier in
 *  fileKinds.ts — this module only owns the colour palette + glyph mapping. */
import {
  File,
  FileCode,
  FileText,
  FileType,
  Image as ImageIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { extOf, kindForPath, type FileKind } from "./fileKinds";

interface IconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

const COLOR: Record<string, string> = {
  ts: "#4a9bd6", tsx: "#4a9bd6", mts: "#4a9bd6", cts: "#4a9bd6",
  js: "#e8c343", jsx: "#e8c343", mjs: "#e8c343", cjs: "#e8c343",
  json: "#e8c343", jsonc: "#e8c343",
  dart: "#45c0b8",
  rs: "#e8732c",
  py: "#4a9bd6",
  go: "#4ac0d6",
  rb: "#d64a4a", php: "#8a8ad6",
  java: "#e8732c", kt: "#c678dd", swift: "#e8732c",
  c: "#4a9bd6", h: "#4a9bd6", cpp: "#4a9bd6", cc: "#4a9bd6", hpp: "#4a9bd6", cs: "#45c08a",
  css: "#4a9bd6", scss: "#d6699b", less: "#4a9bd6",
  html: "#e8732c", htm: "#e8732c", vue: "#42b883", svelte: "#e8732c",
  md: "#5b9bd6", markdown: "#5b9bd6",
  yaml: "#d6699b", yml: "#d6699b", toml: "#9b8a6b", ini: "#9b8a6b", env: "#e8c343",
  sh: "#89e051", bash: "#89e051", zsh: "#89e051",
  sql: "#e8a13c", lua: "#4a6bd6", xml: "#89e051",
  png: "#a679c2", jpg: "#a679c2", jpeg: "#a679c2", gif: "#a679c2", webp: "#a679c2", svg: "#e8a13c", ico: "#a679c2",
  pdf: "#d64a4a",
  lock: "#8a8a96",
};

const GLYPH: Record<FileKind, ComponentType<IconProps>> = {
  image: ImageIcon,
  pdf: FileType,
  doc: FileType,
  code: FileCode,
  text: FileText,
  video: File,
  audio: File,
  archive: File,
  font: File,
  binary: File,
};

/** Returns the icon component + colour for a filename. */
export function fileIcon(name: string): {
  Icon: ComponentType<IconProps>;
  color: string;
} {
  const color = COLOR[extOf(name)] ?? "var(--color-muted)";
  return { Icon: GLYPH[kindForPath(name)], color };
}
