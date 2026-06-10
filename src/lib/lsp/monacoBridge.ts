/** One-time monaco ↔ LSP wiring, called from initMonaco().
 *
 *  Registers hover / definition / completion providers for ts/tsx/js/jsx that
 *  route by model URI → the owning LspClient (manager.ts), pipes
 *  publishDiagnostics into `setModelMarkers`, and routes cross-file
 *  go-to-definition through the pane system (paneBus.openEditorFileInPane).
 *
 *  DEMOTION: monaco's built-in TS worker stays fully active until a real
 *  server reports READY — then we disable the worker's hover/completion/
 *  definition (so results never appear twice) and its SEMANTIC validation
 *  (tsserver's project-aware squiggles replace the worker's lib-less guesses;
 *  syntax validation stays on as a fast first line). If every server dies or
 *  crash-loops, the hook restores the worker — the editor never goes dumb.
 */
import type * as Monaco from "monaco-editor";

import { openEditorFileInPane } from "../paneBus.ts";
import {
  lspClientForPath,
  setDemotionHook,
  setDiagnosticsSink,
} from "./manager.ts";
import { uriToPath, type MonacoRange } from "./protocol.ts";

const LANGUAGES = ["typescript", "javascript"]; // tsx/jsx map to these ids

let wired = false;

export function initLspBridge(monaco: typeof Monaco): void {
  if (wired) return;
  wired = true;

  wireDiagnostics(monaco);
  wireDemotion(monaco);

  for (const language of LANGUAGES) {
    monaco.languages.registerHoverProvider(language, {
      async provideHover(model, position) {
        const client = lspClientForPath(model.uri.fsPath);
        if (!client) return null;
        const hover = await client.hover(model.uri.fsPath, position).catch(() => null);
        if (!hover) return null;
        return {
          contents: hover.contents.map((value) => ({ value })),
          range: hover.range,
        };
      },
    });

    monaco.languages.registerDefinitionProvider(language, {
      async provideDefinition(model, position) {
        const client = lspClientForPath(model.uri.fsPath);
        if (!client) return null;
        const locs = await client.definition(model.uri.fsPath, position).catch(() => []);
        return locs.map((l) => ({
          uri: monaco.Uri.file(uriToPath(l.uri)),
          range: l.range,
        }));
      },
    });

    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: [".", '"', "'", "`", "/", "@", "<"],
      async provideCompletionItems(model, position, context) {
        const client = lspClientForPath(model.uri.fsPath);
        if (!client) return null;
        // default replace-range when an item carries no textEdit: the word
        // currently being typed (monaco's own convention).
        const word = model.getWordUntilPosition(position);
        const defaultRange: MonacoRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };
        const res = await client
          .completion(model.uri.fsPath, position, defaultRange, {
            // monaco CompletionTriggerKind is 0-based, LSP is 1-based, same order
            triggerKind: (context.triggerKind as number) + 1,
            triggerCharacter: context.triggerCharacter,
          })
          .catch(() => null);
        if (!res) return null;
        // stash routing info for resolveCompletionItem (monaco hands the same
        // object back, so the extra fields survive the round trip)
        for (const s of res.suggestions) {
          (s as unknown as { _path: string; _range: MonacoRange })._path = model.uri.fsPath;
          (s as unknown as { _path: string; _range: MonacoRange })._range = defaultRange;
        }
        return {
          suggestions: res.suggestions,
          incomplete: res.incomplete,
        } as unknown as Monaco.languages.CompletionList;
      },
      async resolveCompletionItem(item) {
        const carried = item as unknown as {
          _lsp?: unknown;
          _path?: string;
          _range?: MonacoRange;
        };
        if (!carried._lsp || !carried._path || !carried._range) return item;
        const client = lspClientForPath(carried._path);
        if (!client) return item;
        const resolved = await client
          .resolveCompletion(carried._lsp as never, carried._range)
          .catch(() => null);
        if (!resolved) return item;
        // merge the lazily-resolved fields onto the original item (monaco
        // matches by object identity — returning a new object is also fine,
        // but keep the stashed routing fields)
        return {
          ...item,
          detail: resolved.detail ?? item.detail,
          documentation: resolved.documentation ?? item.documentation,
          additionalTextEdits:
            (resolved.additionalTextEdits as Monaco.languages.CompletionItem["additionalTextEdits"]) ??
            item.additionalTextEdits,
        };
      },
    });
  }

  // Cross-file go-to-definition: monaco calls registered openers whenever a
  // definition targets a resource OTHER than the current model. Route it
  // through the pane system so ⌘-click opens (or jumps) a real editor pane —
  // never monaco's default behavior of swapping the current pane's model.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== "file") return false;
      const path = resource.fsPath;
      const name = path.split("/").pop() ?? path;
      let line: number | undefined;
      let col: number | undefined;
      if (selectionOrPosition) {
        if ("startLineNumber" in selectionOrPosition) {
          line = selectionOrPosition.startLineNumber;
          col = selectionOrPosition.startColumn;
        } else {
          line = selectionOrPosition.lineNumber;
          col = selectionOrPosition.column;
        }
      }
      return openEditorFileInPane(path, name, { line, col });
    },
  });
}

// ── diagnostics → markers ────────────────────────────────────────────────────

function wireDiagnostics(monaco: typeof Monaco) {
  setDiagnosticsSink((uri, markers) => {
    // normalize through path → Uri.file so encoding always matches how
    // EditorPane created the model
    const model = monaco.editor.getModel(monaco.Uri.file(uriToPath(uri)));
    if (!model || model.isDisposed()) return;
    monaco.editor.setModelMarkers(
      model,
      "lsp",
      markers as unknown as Monaco.editor.IMarkerData[],
    );
  });
}

// ── built-in TS worker demotion ──────────────────────────────────────────────

function wireDemotion(monaco: typeof Monaco) {
  let demoted = false;
  // monaco 0.55 moved the worker defaults from `languages.typescript` (now a
  // deprecation stub in the types) to the top-level `typescript` export.
  const apply = (defaults: typeof monaco.typescript.typescriptDefaults, off: boolean) => {
    defaults.setModeConfiguration({
      completionItems: !off,
      hovers: !off,
      definitions: !off,
      documentSymbols: true, // breadcrumbs/outline stay on the worker — LSP side not wired
      references: !off,
      documentHighlights: true,
      rename: !off,
      diagnostics: true, // syntax errors stay; semantic noise is silenced below
      documentRangeFormattingEdits: true,
      signatureHelp: !off,
      onTypeFormattingEdits: true,
      codeActions: !off,
      inlayHints: !off,
    });
    defaults.setDiagnosticsOptions({
      noSemanticValidation: off,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: off,
    });
  };
  setDemotionHook((anyReady) => {
    if (anyReady === demoted) return;
    demoted = anyReady;
    apply(monaco.typescript.typescriptDefaults, anyReady);
    apply(monaco.typescript.javascriptDefaults, anyReady);
  });
}
