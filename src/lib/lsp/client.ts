/** One LSP client = one language server for one (workspaceRoot, language).
 *
 *  Owns the initialize handshake, document sync (didOpen / debounced
 *  INCREMENTAL didChange / didSave / didClose driven by monaco model events),
 *  and the three B2 feature requests (hover, definition, completion+resolve).
 *  Everything protocol-shaped is delegated to protocol.ts converters so the
 *  ±1 position math lives in exactly one place.
 */
import type * as Monaco from "monaco-editor";
import type * as lsp from "vscode-languageserver-protocol";

import {
  hoverToMarkdown,
  toMonacoRange,
  pathToUri,
  toLspContentChanges,
  toLspPosition,
  toMonacoCompletion,
  toMonacoMarker,
  type MonacoCompletionItem,
  type MonacoMarkerData,
  type MonacoRange,
} from "./protocol.ts";
import { LspTransport } from "./transport.ts";

export type LspClientStatus = "starting" | "ready" | "failed" | "stopped";

/** How long edits coalesce before a didChange flush. Low enough that
 *  diagnostics feel live, high enough to not spam the server per keystroke. */
const DIDCHANGE_DEBOUNCE_MS = 150;

interface OpenDoc {
  model: Monaco.editor.ITextModel;
  version: number;
  /** queued incremental changes awaiting the debounce flush */
  queued: lsp.TextDocumentContentChangeEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  contentListener: Monaco.IDisposable;
}

export class LspClient {
  readonly root: string;
  readonly lang: string;
  status: LspClientStatus = "starting";
  /** resolved spawn line, surfaced in the editor status pill tooltip */
  command = "";

  private transport = new LspTransport();
  private docs = new Map<string, OpenDoc>(); // uri → doc
  private serverCaps: lsp.ServerCapabilities | null = null;
  private onDiagnostics: (uri: string, markers: MonacoMarkerData[]) => void;
  private onStatusChange: (c: LspClient) => void;
  private onExitCb: (c: LspClient) => void;

  constructor(opts: {
    root: string;
    lang: string;
    onDiagnostics: (uri: string, markers: MonacoMarkerData[]) => void;
    onStatusChange: (c: LspClient) => void;
    onExit: (c: LspClient) => void;
  }) {
    this.root = opts.root;
    this.lang = opts.lang;
    this.onDiagnostics = opts.onDiagnostics;
    this.onStatusChange = opts.onStatusChange;
    this.onExitCb = opts.onExit;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.transport.onExit(() => {
      // wipe stale markers — a dead server's squiggles are lies
      for (const uri of this.docs.keys()) this.onDiagnostics(uri, []);
      if (this.status !== "stopped") this.setStatus("failed");
      this.onExitCb(this);
    });
    this.transport.onNotification("textDocument/publishDiagnostics", (params) => {
      const p = params as lsp.PublishDiagnosticsParams;
      this.onDiagnostics(p.uri, p.diagnostics.map(toMonacoMarker));
    });

    await this.transport.start(this.root, this.lang);
    this.command = this.transport.command;

    const initParams: lsp.InitializeParams = {
      processId: null,
      rootUri: pathToUri(this.root),
      workspaceFolders: [{ uri: pathToUri(this.root), name: this.root.split("/").pop() ?? this.root }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          completion: {
            completionItem: {
              snippetSupport: true,
              insertReplaceSupport: true,
              documentationFormat: ["markdown", "plaintext"],
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
            },
            contextSupport: true,
          },
          publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] } },
        },
        workspace: { configuration: true, workspaceFolders: true },
        window: { workDoneProgress: true },
      },
      initializationOptions: {},
    };
    const init = await this.transport.request<lsp.InitializeResult>("initialize", initParams);
    this.serverCaps = init.capabilities;
    this.transport.notify("initialized", {});
    this.setStatus("ready");
  }

  /** Polite stop (also used on idle shutdown). */
  async stop(): Promise<void> {
    this.setStatus("stopped");
    for (const [uri, doc] of this.docs) {
      doc.contentListener.dispose();
      if (doc.timer) clearTimeout(doc.timer);
      this.onDiagnostics(uri, []);
    }
    this.docs.clear();
    await this.transport.stop();
  }

  private setStatus(s: LspClientStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatusChange(this);
  }

  get openDocCount(): number {
    return this.docs.size;
  }

  // ── document sync ──────────────────────────────────────────────────────────

  didOpen(path: string, model: Monaco.editor.ITextModel): void {
    const uri = pathToUri(path);
    if (this.docs.has(uri)) return;
    const languageId = model.getLanguageId(); // "typescript" | "javascript" | …
    const doc: OpenDoc = {
      model,
      version: 1,
      queued: [],
      timer: null,
      contentListener: model.onDidChangeContent((e) => this.queueChanges(uri, e)),
    };
    this.docs.set(uri, doc);
    this.transport.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text: model.getValue() },
    } satisfies lsp.DidOpenTextDocumentParams);
  }

  didClose(path: string): void {
    const uri = pathToUri(path);
    const doc = this.docs.get(uri);
    if (!doc) return;
    doc.contentListener.dispose();
    if (doc.timer) clearTimeout(doc.timer);
    this.docs.delete(uri);
    this.transport.notify("textDocument/didClose", {
      textDocument: { uri },
    } satisfies lsp.DidCloseTextDocumentParams);
    this.onDiagnostics(uri, []); // clear markers for the closed doc
  }

  didSave(path: string): void {
    const uri = pathToUri(path);
    if (!this.docs.has(uri)) return;
    this.transport.notify("textDocument/didSave", { textDocument: { uri } });
  }

  private queueChanges(uri: string, e: Monaco.editor.IModelContentChangedEvent) {
    const doc = this.docs.get(uri);
    if (!doc) return;
    // Each event's changes are pre-sorted to be sequentially applicable
    // (protocol.ts); appending event batches in arrival order keeps the whole
    // queue sequentially correct.
    doc.queued.push(...toLspContentChanges(e.changes));
    if (doc.timer) return; // a flush is already scheduled
    doc.timer = setTimeout(() => this.flushChanges(uri), DIDCHANGE_DEBOUNCE_MS);
  }

  private flushChanges(uri: string) {
    const doc = this.docs.get(uri);
    if (!doc) return;
    doc.timer = null;
    if (doc.queued.length === 0) return;
    const contentChanges = doc.queued;
    doc.queued = [];
    doc.version += 1;
    this.transport.notify("textDocument/didChange", {
      textDocument: { uri, version: doc.version },
      contentChanges,
    } satisfies lsp.DidChangeTextDocumentParams);
  }

  /** Requests must see the server's view == the model — flush before asking. */
  private syncNow(uri: string) {
    const doc = this.docs.get(uri);
    if (doc?.timer) {
      clearTimeout(doc.timer);
      doc.timer = null;
      this.flushChanges(uri);
    }
  }

  // ── features (B2) ─────────────────────────────────────────────────────────

  async hover(path: string, pos: Monaco.IPosition): Promise<{ contents: string[]; range?: MonacoRange } | null> {
    if (this.status !== "ready") return null;
    const uri = pathToUri(path);
    this.syncNow(uri);
    const res = await this.transport.request<lsp.Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position: toLspPosition(pos),
    });
    if (!res || !res.contents) return null;
    const contents = hoverToMarkdown(res.contents).filter((s) => s.trim().length > 0);
    if (contents.length === 0) return null;
    return {
      contents,
      range: res.range ? toMonacoRange(res.range) : undefined,
    };
  }

  async definition(
    path: string,
    pos: Monaco.IPosition,
  ): Promise<{ uri: string; range: MonacoRange }[]> {
    if (this.status !== "ready") return [];
    const uri = pathToUri(path);
    this.syncNow(uri);
    const res = await this.transport.request<
      lsp.Location | lsp.Location[] | lsp.LocationLink[] | null
    >("textDocument/definition", { textDocument: { uri }, position: toLspPosition(pos) });
    if (!res) return [];
    const list = Array.isArray(res) ? res : [res];
    return list.map((loc) => {
      if ("targetUri" in loc) {
        return { uri: loc.targetUri, range: toMonacoRange(loc.targetSelectionRange ?? loc.targetRange) };
      }
      return { uri: loc.uri, range: toMonacoRange(loc.range) };
    });
  }

  async completion(
    path: string,
    pos: Monaco.IPosition,
    defaultRange: MonacoRange,
    context?: { triggerKind: number; triggerCharacter?: string },
  ): Promise<{ suggestions: (MonacoCompletionItem & { _lsp: lsp.CompletionItem })[]; incomplete: boolean }> {
    if (this.status !== "ready") return { suggestions: [], incomplete: false };
    const uri = pathToUri(path);
    this.syncNow(uri);
    const res = await this.transport.request<lsp.CompletionList | lsp.CompletionItem[] | null>(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: toLspPosition(pos),
        context: context ?? { triggerKind: 1 },
      },
    );
    if (!res) return { suggestions: [], incomplete: false };
    const items = Array.isArray(res) ? res : res.items;
    const incomplete = Array.isArray(res) ? false : Boolean(res.isIncomplete);
    return {
      suggestions: items.map((item) => ({
        ...toMonacoCompletion(item, defaultRange),
        // stash the raw item so resolveCompletionItem can round-trip it
        _lsp: item,
      })),
      incomplete,
    };
  }

  /** completionItem/resolve — lazily fills documentation/detail on highlight. */
  async resolveCompletion(item: lsp.CompletionItem, defaultRange: MonacoRange): Promise<MonacoCompletionItem & { _lsp: lsp.CompletionItem }> {
    if (this.serverCaps?.completionProvider?.resolveProvider !== true) {
      return { ...toMonacoCompletion(item, defaultRange), _lsp: item };
    }
    const resolved = await this.transport
      .request<lsp.CompletionItem>("completionItem/resolve", item)
      .catch(() => item);
    return { ...toMonacoCompletion(resolved, defaultRange), _lsp: resolved };
  }
}
