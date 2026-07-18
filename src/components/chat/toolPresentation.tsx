/** Tool-call presentation helpers (Codex-style activity steps) — moved verbatim
 *  out of ChatPane.tsx (mechanical split, no behavior change), except the ext
 *  sets: the private IMG_EXT/DOC_EXT/CODE_EXT copies were replaced with the
 *  canonical groups from lib/fileKinds.ts (the one planned non-move change). */
import { FileText, Globe, Pencil, Search, Terminal, Wrench } from "lucide-react";
import { CODE_EXT, DOC_EXT, IMG_EXT, TEXT_EXT } from "../../lib/fileKinds";
import type { ChatTurn } from "../../lib/chatStream";
import { baseName, ellipsizeMid } from "./chatFormat";

export type ToolTurn = Extract<ChatTurn, { kind: "tool" }>;

/** Renders tool input as a compact `key: value` preview (first few keys). */
export function previewArgs(input: Record<string, unknown>): string {
  const entries = Object.entries(input ?? {});
  if (entries.length === 0) return "";
  return entries
    .slice(0, 3)
    .map(([k, v]) => {
      let s = typeof v === "string" ? v : JSON.stringify(v);
      if (s.length > 80) s = s.slice(0, 80) + "…";
      return `${k}: ${s}`;
    })
    .join("  ");
}

/** Pulls a total token count out of the loose result `usage` object. */
export function tokensFromUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const inT = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const outT = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const cacheRead =
    typeof u.cache_read_input_tokens === "number"
      ? u.cache_read_input_tokens
      : 0;
  const cacheCreate =
    typeof u.cache_creation_input_tokens === "number"
      ? u.cache_creation_input_tokens
      : 0;
  const total = inT + outT + cacheRead + cacheCreate;
  return total > 0 ? total : undefined;
}

/** Pull the most relevant target arg out of a tool's input. Mirrors the verbs
 *  below: a path basename for file tools, the command for Bash, the pattern for
 *  search, the URL for fetches, else a compact key:value preview. */
export function toolTarget(turn: ToolTurn): { label: string; full: string } {
  const inp = turn.input ?? {};
  const name = turn.name.toLowerCase();
  const str = (k: string) =>
    typeof inp[k] === "string" ? (inp[k] as string) : undefined;

  // file tools → basename (full path on hover)
  const path = str("file_path") ?? str("path") ?? str("notebook_path");
  if (path) return { label: ellipsizeMid(baseName(path)), full: path };

  // shell → the command (first line)
  if (name === "bash" || name === "bashoutput" || name === "exec_command" || name === "write_stdin") {
    const cmd = str("command") ?? str("cmd") ?? str("chars") ?? "";
    const firstLine = cmd.split("\n")[0] ?? cmd;
    return { label: ellipsizeMid(firstLine, 60), full: cmd };
  }

  // search / grep / glob → pattern (+ optional path)
  if (name === "grep" || name === "glob" || name === "search") {
    const pat = str("pattern") ?? str("query") ?? "";
    const where = str("path");
    const full = where ? `${pat}  in ${where}` : pat;
    return { label: ellipsizeMid(pat || full, 56), full };
  }

  // web → url / query / domains
  if (name === "webfetch" || name === "webfetch_tool") {
    const url = str("url") ?? "";
    return { label: ellipsizeMid(url, 56), full: url };
  }
  if (name === "websearch") {
    const q = str("query") ?? "";
    return { label: ellipsizeMid(q, 56), full: q };
  }

  // task / sub-agent → description
  if (name === "task") {
    const d = str("description") ?? str("subagent_type") ?? "";
    return { label: ellipsizeMid(d, 56), full: d };
  }

  // fall back to the generic key:value preview
  const preview = previewArgs(inp);
  return { label: ellipsizeMid(preview, 56), full: preview };
}

/** Extract the file path a tool acted on, from its model-emitted input — the
 *  gold source for "open in pane". Covers claude Read/Edit/Write/MultiEdit/
 *  NotebookEdit (`file_path`/`notebook_path`) and codex apply_patch/exec
 *  (`path`/`file`). Bash file args are intentionally NOT guessed here (too
 *  ambiguous); a real file there shows up as a separate Read/Edit tool anyway.
 *  Returns null when the tool isn't file-shaped. */
export function toolFilePath(turn: ToolTurn): string | null {
  const name = turn.name.toLowerCase();
  const inp = turn.input ?? {};
  const str = (k: string) => (typeof inp[k] === "string" ? (inp[k] as string) : undefined);
  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "multiedit":
      return str("file_path") ?? str("path") ?? null;
    case "notebookedit":
      return str("notebook_path") ?? str("file_path") ?? null;
    // tools whose `path`/args are NOT a single file to open (a search dir, a
    // shell command, a URL) — never offer "open in pane".
    case "bash":
    case "bashoutput":
    case "exec_command":
    case "write_stdin":
    case "grep":
    case "glob":
    case "search":
    case "webfetch":
    case "webfetch_tool":
    case "websearch":
    case "task":
    case "todowrite":
      return null;
    // codex maps apply_patch/fileChange → "edit" (handled above); a bare codex
    // file action may still carry path/file.
    default:
      return str("file_path") ?? str("notebook_path") ?? str("path") ?? str("file") ?? null;
  }
}

/** A short verb for the tool, Codex-style ("Read", "Ran", "Edited", "Searched"). */
export function toolVerb(name: string): string {
  switch (name.toLowerCase()) {
    case "read":
      return "Read";
    case "write":
      return "Wrote";
    case "edit":
    case "multiedit":
      return "Edited";
    case "notebookedit":
      return "Edited";
    case "bash":
    case "exec_command":
      return "Ran";
    case "bashoutput":
    case "write_stdin":
      return "Output";
    case "grep":
    case "search":
      return "Searched";
    case "glob":
      return "Globbed";
    case "webfetch":
    case "webfetch_tool":
      return "Fetched";
    case "websearch":
      return "Web search";
    case "task":
      return "Agent";
    case "mcp":
    case "mcp_tool_call":
      return "MCP";
    case "todowrite":
      return "Planned";
    default:
      return name;
  }
}

/** Pick the lucide icon component for a tool's activity row. */
export function toolIcon(name: string) {
  switch (name.toLowerCase()) {
    case "read":
      return FileText;
    case "write":
    case "notebookedit":
      return FileText;
    case "edit":
    case "multiedit":
      return Pencil;
    case "bash":
    case "bashoutput":
    case "exec_command":
    case "write_stdin":
      return Terminal;
    case "grep":
    case "glob":
    case "search":
      return Search;
    case "webfetch":
    case "webfetch_tool":
    case "websearch":
      return Globe;
    case "mcp":
    case "mcp_tool_call":
      return Wrench;
    default:
      return Wrench;
  }
}

// ── file artifacts (Write / Edit / NotebookEdit targets) ─────────────────────

export interface Artifact {
  path: string;
  name: string;
  kind: "img" | "pdf" | "doc" | "code" | "file";
}

export function artifactKind(path: string): Artifact["kind"] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (IMG_EXT.has(ext)) return "img";
  if (CODE_EXT.has(ext)) return "code";
  if (DOC_EXT.has(ext) || TEXT_EXT.has(ext)) return "doc";
  return "file";
}

/** Detect the file an artifact-producing tool wrote to (Write/Edit/NotebookEdit). */
export function artifactFromTool(turn: ToolTurn): Artifact | null {
  const name = turn.name.toLowerCase();
  if (
    name !== "write" &&
    name !== "edit" &&
    name !== "multiedit" &&
    name !== "notebookedit"
  ) {
    return null;
  }
  const inp = turn.input ?? {};
  const path =
    (typeof inp.file_path === "string" && inp.file_path) ||
    (typeof inp.path === "string" && inp.path) ||
    (typeof inp.notebook_path === "string" && inp.notebook_path) ||
    "";
  if (!path) return null;
  return { path, name: baseName(path), kind: artifactKind(path) };
}
