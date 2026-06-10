/** Pure LSP ↔ Monaco data mapping — NO imports of monaco or tauri so this file
 *  is unit-testable under node's test runner (same pattern as paneLayout.ts).
 *
 *  The load-bearing subtlety: LSP positions are 0-based {line, character},
 *  Monaco positions are 1-based {lineNumber, column}. Every boundary crossing
 *  goes through these converters — never inline the ±1 anywhere else.
 */
import type * as lsp from "vscode-languageserver-protocol";

/** Structural twins of monaco's IPosition/IRange so this module stays
 *  monaco-import-free (monaco-editor pulls in CSS at import time, which the
 *  node test runner can't load). They're assignable both ways. */
export interface MonacoPosition {
  lineNumber: number;
  column: number;
}
export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

// ── positions ────────────────────────────────────────────────────────────────

export function toLspPosition(p: MonacoPosition): lsp.Position {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

export function toMonacoPosition(p: lsp.Position): MonacoPosition {
  return { lineNumber: p.line + 1, column: p.character + 1 };
}

export function toLspRange(r: MonacoRange): lsp.Range {
  return {
    start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
    end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
  };
}

export function toMonacoRange(r: lsp.Range): MonacoRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

// ── uris ─────────────────────────────────────────────────────────────────────

/** Absolute filesystem path → file:// uri (matches monaco.Uri.file().toString()
 *  for plain ascii paths; non-ascii goes through encodeURI minus the chars
 *  monaco keeps literal). Good enough for both sides since WE generate every
 *  uri that crosses the pipe from the same function. */
export function pathToUri(path: string): string {
  return "file://" + encodeURI(path).replace(/[?#]/g, encodeURIComponent);
}

/** file:// uri → absolute path. Tolerates both encoded and raw uris. */
export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  return decodeURIComponent(uri.slice("file://".length));
}

// ── diagnostics ──────────────────────────────────────────────────────────────

/** Monaco MarkerSeverity values (monaco.MarkerSeverity.* — stable enum). */
const MARKER_SEVERITY = { error: 8, warning: 4, info: 2, hint: 1 } as const;

export interface MonacoMarkerData {
  severity: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  code?: string;
  source?: string;
  tags?: number[];
}

export function toMonacoMarker(d: lsp.Diagnostic): MonacoMarkerData {
  const r = toMonacoRange(d.range);
  let severity: number = MARKER_SEVERITY.info;
  switch (d.severity) {
    case 1: severity = MARKER_SEVERITY.error; break;
    case 2: severity = MARKER_SEVERITY.warning; break;
    case 3: severity = MARKER_SEVERITY.info; break;
    case 4: severity = MARKER_SEVERITY.hint; break;
  }
  return {
    severity,
    // LSP 3.18 allows MarkupContent messages — markers want plain strings
    message: typeof d.message === "string" ? d.message : d.message.value,
    ...r,
    code: d.code != null ? String(d.code) : undefined,
    source: d.source,
    // LSP DiagnosticTag Unnecessary=1→monaco 1, Deprecated=2→monaco 2 (same values)
    tags: d.tags as number[] | undefined,
  };
}

// ── completions ──────────────────────────────────────────────────────────────

/** LSP CompletionItemKind (1-25) → monaco.languages.CompletionItemKind. The two
 *  enums cover the same concepts but with DIFFERENT numeric values — mapping by
 *  table, not by cast. Monaco values per monaco-editor 0.55 d.ts. */
const COMPLETION_KIND: Record<number, number> = {
  1: 18,  // Text
  2: 0,   // Method
  3: 1,   // Function
  4: 2,   // Constructor
  5: 3,   // Field
  6: 4,   // Variable
  7: 5,   // Class
  8: 7,   // Interface
  9: 8,   // Module
  10: 9,  // Property
  11: 12, // Unit
  12: 13, // Value
  13: 15, // Enum
  14: 17, // Keyword
  15: 27, // Snippet
  16: 19, // Color
  17: 20, // File
  18: 21, // Reference
  19: 23, // Folder
  20: 16, // EnumMember
  21: 14, // Constant
  22: 6,  // Struct
  23: 10, // Event
  24: 11, // Operator
  25: 24, // TypeParameter
};

/** monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet */
const INSERT_AS_SNIPPET = 4;

/** Structural twin of monaco.languages.CompletionItem (the fields we emit). */
export interface MonacoCompletionItem {
  label: string | { label: string; detail?: string; description?: string };
  kind: number;
  insertText: string;
  insertTextRules?: number;
  range:
    | MonacoRange
    | { insert: MonacoRange; replace: MonacoRange };
  detail?: string;
  documentation?: string | { value: string };
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  commitCharacters?: string[];
  additionalTextEdits?: { range: MonacoRange; text: string }[];
  tags?: number[];
}

/** Default range when the server sends no textEdit: monaco's "current word"
 *  range, computed by the caller from the model. */
export function toMonacoCompletion(
  item: lsp.CompletionItem,
  defaultRange: MonacoRange,
): MonacoCompletionItem {
  // Mirror textEdit ranges EXACTLY — getting this wrong is the classic source
  // of completions that mangle the word under the cursor.
  let range: MonacoCompletionItem["range"] = defaultRange;
  let insertText = item.insertText ?? item.label;
  const te = item.textEdit;
  if (te) {
    insertText = te.newText;
    if ("range" in te) {
      range = toMonacoRange(te.range);
    } else {
      // InsertReplaceEdit — monaco supports the dual range natively.
      range = { insert: toMonacoRange(te.insert), replace: toMonacoRange(te.replace) };
    }
  }
  const out: MonacoCompletionItem = {
    label: item.label,
    kind: COMPLETION_KIND[item.kind ?? 1] ?? 18,
    insertText,
    range,
    detail: item.detail,
    documentation:
      typeof item.documentation === "object" && item.documentation
        ? { value: item.documentation.value }
        : item.documentation,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    commitCharacters: item.commitCharacters,
    additionalTextEdits: item.additionalTextEdits?.map((e) => ({
      range: toMonacoRange(e.range),
      text: e.newText,
    })),
    // LSP CompletionItemTag.Deprecated=1 === monaco CompletionItemTag.Deprecated=1
    tags: item.tags as number[] | undefined,
  };
  // InsertTextFormat.Snippet — monaco must parse $0/${1:x} placeholders, not
  // insert them literally.
  if (item.insertTextFormat === 2) out.insertTextRules = INSERT_AS_SNIPPET;
  return out;
}

// ── hover ────────────────────────────────────────────────────────────────────

/** Hover contents → markdown strings (monaco hovers take IMarkdownString[]). */
export function hoverToMarkdown(contents: lsp.Hover["contents"]): string[] {
  const one = (c: lsp.MarkedString | lsp.MarkupContent): string => {
    if (typeof c === "string") return c;
    if ("language" in c) return "```" + c.language + "\n" + c.value + "\n```";
    return c.value;
  };
  if (Array.isArray(contents)) return contents.map(one).filter(Boolean);
  return [one(contents)].filter(Boolean);
}

// ── incremental didChange ────────────────────────────────────────────────────

/** Structural twin of monaco's IModelContentChange. */
export interface MonacoContentChange {
  range: MonacoRange;
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/** Monaco reports ALL of one event's changes relative to the document state
 *  BEFORE the event; LSP applies contentChanges SEQUENTIALLY. Sorting each
 *  event's changes by rangeOffset DESCENDING makes sequential application
 *  equivalent (a bottom-most edit can't shift the coordinates of edits above
 *  it). Same trick monaco-languageclient uses. */
export function toLspContentChanges(
  changes: readonly MonacoContentChange[],
): lsp.TextDocumentContentChangeEvent[] {
  return [...changes]
    .sort((a, b) => b.rangeOffset - a.rangeOffset)
    .map((c) => ({ range: toLspRange(c.range), text: c.text }));
}
