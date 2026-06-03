/** Monaco (VS Code's editor core) setup for the shell. Bundles the language
 *  web-workers via Vite's `?worker` imports — no CDN, so it works offline inside
 *  the Tauri webview. Registers a Dart grammar (Monaco ships none, and that's
 *  Firaz's Flutter stack) and an aios-dark theme matching the app chrome.
 *
 *  `initMonaco()` is idempotent; call it once before creating an editor. */
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

export { languageForPath } from "./editorLanguage";

let initialized = false;

export function initMonaco(): typeof monaco {
  if (initialized) return monaco;
  initialized = true;

  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      switch (label) {
        case "json":
          return new jsonWorker();
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  registerDart(monaco);
  defineTheme(monaco);
  return monaco;
}

/** A compact Monarch grammar for Dart — keywords, types, strings (incl. interp),
 *  comments, annotations, numbers. Enough to read like VS Code for Flutter code. */
function registerDart(m: typeof monaco) {
  if (m.languages.getLanguages().some((l) => l.id === "dart")) return;
  m.languages.register({ id: "dart", extensions: [".dart"], aliases: ["Dart", "dart"] });
  m.languages.setLanguageConfiguration("dart", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "'", close: "'", notIn: ["string", "comment"] },
      { open: '"', close: '"', notIn: ["string", "comment"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "'", close: "'" },
      { open: '"', close: '"' },
    ],
  });
  m.languages.setMonarchTokensProvider("dart", {
    defaultToken: "",
    keywords: [
      "abstract", "as", "assert", "async", "await", "break", "case", "catch",
      "class", "const", "continue", "covariant", "default", "deferred", "do",
      "dynamic", "else", "enum", "export", "extends", "extension", "external",
      "factory", "false", "final", "finally", "for", "Function", "get", "hide",
      "if", "implements", "import", "in", "interface", "is", "late", "library",
      "mixin", "new", "null", "on", "operator", "part", "rethrow", "return",
      "sealed", "set", "show", "static", "super", "switch", "sync", "this",
      "throw", "true", "try", "typedef", "var", "void", "while", "with", "yield",
      "required",
    ],
    typeKeywords: [
      "int", "double", "num", "bool", "String", "List", "Map", "Set", "Future",
      "Stream", "Object", "Widget", "BuildContext", "Color", "Key", "Iterable",
    ],
    operators: [
      "=", ">", "<", "!", "~", "?", ":", "==", "<=", ">=", "!=", "&&", "||",
      "++", "--", "+", "-", "*", "/", "&", "|", "^", "%", "<<", ">>", "+=",
      "-=", "*=", "/=", "??", "?.", "=>", "...",
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|u\{[0-9A-Fa-f]+\})/,
    tokenizer: {
      root: [
        [/@[a-zA-Z_$][\w$]*/, "annotation"],
        [
          /[a-zA-Z_$][\w$]*/,
          {
            cases: {
              "@keywords": "keyword",
              "@typeKeywords": "type",
              "@default": "identifier",
            },
          },
        ],
        [/[A-Z][\w$]*/, "type"],
        { include: "@whitespace" },
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],
        [/\d*\.\d+([eE][-+]?\d+)?/, "number.float"],
        [/0[xX][0-9a-fA-F]+/, "number.hex"],
        [/\d+/, "number"],
        [/[;,.]/, "delimiter"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string_double"],
        [/'/, "string", "@string_single"],
      ],
      whitespace: [
        [/[ \t\r\n]+/, ""],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
      string_double: [
        [/[^\\"$]+/, "string"],
        [/\$\{/, { token: "delimiter.bracket", next: "@interp" }],
        [/\$[a-zA-Z_$][\w$]*/, "variable"],
        [/@escapes/, "string.escape"],
        [/"/, "string", "@pop"],
      ],
      string_single: [
        [/[^\\'$]+/, "string"],
        [/\$\{/, { token: "delimiter.bracket", next: "@interp" }],
        [/\$[a-zA-Z_$][\w$]*/, "variable"],
        [/@escapes/, "string.escape"],
        [/'/, "string", "@pop"],
      ],
      interp: [
        [/[^}]+/, "variable"],
        [/\}/, { token: "delimiter.bracket", next: "@pop" }],
      ],
    },
  });
}

/** A dark theme tuned to the app's chrome (transparent bg so the pane shows). */
function defineTheme(m: typeof monaco) {
  m.editor.defineTheme("aios-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5c6370", fontStyle: "italic" },
      { token: "keyword", foreground: "c678dd" },
      { token: "type", foreground: "e5c07b" },
      { token: "string", foreground: "98c379" },
      { token: "string.escape", foreground: "56b6c2" },
      { token: "number", foreground: "d19a66" },
      { token: "number.float", foreground: "d19a66" },
      { token: "number.hex", foreground: "d19a66" },
      { token: "annotation", foreground: "e06c75" },
      { token: "variable", foreground: "e06c75" },
      { token: "operator", foreground: "56b6c2" },
      { token: "identifier", foreground: "abb2bf" },
    ],
    colors: {
      "editor.background": "#0a0a0c",
      "editor.foreground": "#c8ccd4",
      "editorLineNumber.foreground": "#3a3a42",
      "editorLineNumber.activeForeground": "#8a8a96",
      "editor.selectionBackground": "#2a2a35",
      "editor.lineHighlightBackground": "#15151a",
      "editorCursor.foreground": "#e8732c",
      "editorIndentGuide.background1": "#1c1c22",
      "editorGutter.background": "#0a0a0c",
      "scrollbarSlider.background": "#2a2a3580",
    },
  });
}
