const FILE_SCHEME = /^file:\/\//i;
const HTTP_SCHEME = /^https?:\/\//i;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
const HASH_SUFFIX = /#[^/]*$/;

const RELATIVE_ROOTS = /^(docs|src|src-tauri|scripts|tests?|lib|app|public|assets|config|\.agents|\.codex)\//;
const FILEISH_SEGMENT = /(^|\/)[^/\s]+\.[a-z0-9]{1,12}$/i;

export function isHttpPaneTarget(target: string): boolean {
  return HTTP_SCHEME.test(target.trim());
}

export function normalizePaneFileTarget(target: string): string {
  let s = target.trim();
  if ((s.startsWith("<") && s.endsWith(">")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1).trim();
  }
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith("`") && s.endsWith("`"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(HASH_SUFFIX, "");
  if (FILE_SCHEME.test(s)) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
    } catch {
      s = s.replace(FILE_SCHEME, "");
    }
  }
  return s.replace(LINE_SUFFIX, "");
}

export function isPaneFileTarget(target: string): boolean {
  const s = normalizePaneFileTarget(target);
  if (!s || /\s/.test(s)) return false;
  return (
    s.startsWith("/") ||
    s.startsWith("~/") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    RELATIVE_ROOTS.test(s) ||
    FILEISH_SEGMENT.test(s)
  );
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "/";
}

function normalizePosix(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

export function resolvePaneFileTarget(target: string, baseFilePath?: string): string {
  const s = normalizePaneFileTarget(target);
  if (!baseFilePath || s.startsWith("/") || s.startsWith("~/")) return s;
  if (!s.startsWith("./") && !s.startsWith("../")) return s;
  return normalizePosix(`${dirname(baseFilePath)}/${s}`);
}

export function targetLabel(target: string): string {
  const s = normalizePaneFileTarget(target);
  return s.split("/").filter(Boolean).pop() || s || "file";
}
