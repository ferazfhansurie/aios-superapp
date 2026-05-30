/** VS Code-ish file icons: a lucide glyph + a per-language colour keyed by
 *  extension. Keeps the Files tree readable at a glance like the VS Code
 *  explorer. Colours are approximations of the seti-ui palette. */
import {
  File,
  FileCode,
  FileText,
  FileType,
  Image as ImageIcon,
} from "lucide-react";
import type { ComponentType } from "react";

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

const CODE_EXT = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "dart", "rs", "py", "go",
  "rb", "php", "java", "kt", "swift", "c", "h", "cpp", "cc", "hpp", "cs", "css",
  "scss", "less", "html", "htm", "vue", "svelte", "lua", "sql", "sh", "bash",
  "zsh", "json", "jsonc", "yaml", "yml", "toml", "xml", "ini",
]);
const TEXT_EXT = new Set(["md", "markdown", "txt", "rst", "log", "env"]);
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);
const DOC_EXT = new Set(["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "key"]);

/** Returns the icon component + colour for a filename. */
export function fileIcon(name: string): {
  Icon: ComponentType<IconProps>;
  color: string;
} {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const color = COLOR[ext] ?? "var(--color-muted)";
  if (IMG_EXT.has(ext)) return { Icon: ImageIcon, color };
  if (DOC_EXT.has(ext)) return { Icon: FileType, color };
  if (CODE_EXT.has(ext)) return { Icon: FileCode, color };
  if (TEXT_EXT.has(ext)) return { Icon: FileText, color };
  return { Icon: File, color };
}
