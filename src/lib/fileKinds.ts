/** Canonical file-extension knowledge for the shell — the ONE place that
 *  decides what a path *is*.
 *
 *  Consumers (keep their public APIs, import from here):
 *  - `languageForPath`   → Monaco language id (re-exported by editorLanguage.ts)
 *  - `fileIcons.tsx`     → icon class via `kindForPath` + the ext groups
 *  - `App.tsx`           → `VIEWER_EXT` viewer-vs-editor pane routing
 *  - `ChatPane.tsx`      → will migrate its private IMG_EXT/DOC_EXT/CODE_EXT
 *                          onto the named exports here during the planned split
 *
 *  The Rust side mirrors a subset of these lists in
 *  `src-tauri/src/files.rs` (`read_file_preview` / `is_office_ext`) — marked
 *  there with `KEEP IN SYNC with src/lib/fileKinds.ts`. The sync guard in
 *  `fileKinds.test.ts` reads files.rs as text and asserts rust ⊆ canonical. */

export type FileKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "doc"
  | "archive"
  | "font"
  | "code"
  | "text"
  | "binary";

/** Raster + vector images the webview renders natively. */
export const IMG_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif",
]);

/** Video formats the in-pane player handles. */
export const VIDEO_EXT = new Set(["mp4", "mov", "webm", "m4v", "avi", "mkv"]);

/** Audio formats. */
export const AUDIO_EXT = new Set(["mp3", "wav"]);

export const PDF_EXT = new Set(["pdf"]);

/** Office / document formats (word, excel, powerpoint, OpenDocument, rtf,
 *  iWork). The viewer asks the backend for a LibreOffice → PDF conversion;
 *  iWork formats (key/numbers/pages) still route here so they never hit the
 *  Monaco editor, even though LibreOffice can't convert them. */
export const DOC_EXT = new Set([
  "doc", "docx", "docm", "dot", "dotx", "rtf", "odt", "ott", "fodt",
  "xls", "xlsx", "xlsm", "xlsb", "ods", "ots", "fods",
  "ppt", "pptx", "pptm", "pps", "ppsx", "odp", "otp", "fodp",
  "key", "numbers", "pages",
]);

/** Archives / bundles — never editable, viewer shows the binary card. */
export const ARCHIVE_EXT = new Set(["zip", "gz", "tar", "dmg", "app"]);

/** Font binaries. */
export const FONT_EXT = new Set(["woff", "woff2", "ttf", "otf"]);

/** Source code + structured config — opens in the Monaco editor, gets the
 *  code icon. */
export const CODE_EXT = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc",
  "css", "scss", "less", "html", "htm", "vue", "svelte",
  "yaml", "yml", "toml", "ini", "xml",
  "sh", "bash", "zsh", "fish",
  "rs", "py", "go", "rb", "php", "java", "kt", "kts", "swift",
  "c", "h", "cpp", "cc", "hpp", "cs",
  "sql", "lua", "dart", "dockerfile", "makefile", "gradle", "properties",
  "pl", "r", "scala", "clj", "ex", "exs", "elm",
  "graphql", "gql", "proto",
  "tf", "tfvars", "hcl", "ps1", "psm1", "psd1", "bat", "cmd",
  "coffee", "jl", "sol", "tcl", "vb", "hbs", "handlebars", "pug",
]);

/** Plain-text-ish files — editor pane, text icon. */
export const TEXT_EXT = new Set([
  "md", "markdown", "txt", "rst", "log", "env",
  "jsonl", "csv", "tsv", "cfg", "conf",
  "diff", "patch", "lock", "gitignore",
]);

/** Extensions that open in the viewer pane (media / pdf / office / binary
 *  bundles, plus markdown which the viewer renders as a preview); everything
 *  else opens in the Monaco editor pane (the editor itself falls back to
 *  "open externally" if the file turns out to be binary). */
export const VIEWER_EXT = new Set([
  ...IMG_EXT, ...VIDEO_EXT, ...AUDIO_EXT, ...PDF_EXT, ...DOC_EXT,
  ...ARCHIVE_EXT, ...FONT_EXT,
  "md", "markdown",
]);

/** Lowercased extension of a path. Dotless basenames return the whole
 *  basename (so "Dockerfile" → "dockerfile"); dotfiles return the suffix
 *  (".env" → "env"). */
export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1) : base;
}

/** Classifies a path into its canonical kind. Unknown extensions are "binary"
 *  — callers that want editor-fallback semantics should use VIEWER_EXT
 *  membership instead (unknown → editor, which sniffs UTF-8 itself). */
export function kindForPath(path: string): FileKind {
  const ext = extOf(path);
  if (IMG_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (PDF_EXT.has(ext)) return "pdf";
  if (DOC_EXT.has(ext)) return "doc";
  if (ARCHIVE_EXT.has(ext)) return "archive";
  if (FONT_EXT.has(ext)) return "font";
  if (CODE_EXT.has(ext)) return "code";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

/** Monaco language id per extension. Anything unmapped is plaintext. */
const EDITOR_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  jsonl: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  env: "ini",
  properties: "ini",
  rst: "restructuredtext",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  rs: "rust",
  py: "python",
  go: "go",
  rb: "ruby",
  php: "php",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sql: "sql",
  lua: "lua",
  xml: "xml",
  dockerfile: "dockerfile",
  dart: "dart",
  graphql: "graphql",
  gql: "graphql",
  pl: "perl",
  r: "r",
  scala: "scala",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  proto: "proto",
  // Common infra/scripting/markup grammars Monaco ships out of the box — these
  // open in the editor (CODE_EXT) and would otherwise fall through to plaintext.
  tf: "hcl",
  tfvars: "hcl",
  hcl: "hcl",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "bat",
  cmd: "bat",
  coffee: "coffeescript",
  jl: "julia",
  sol: "sol",
  tcl: "tcl",
  vb: "vb",
  hbs: "handlebars",
  handlebars: "handlebars",
  pug: "pug",
};

/** Map a file extension to a Monaco language id. Defaults to plaintext. */
export function languageForPath(path: string): string {
  return EDITOR_LANGUAGE[extOf(path)] ?? "plaintext";
}
