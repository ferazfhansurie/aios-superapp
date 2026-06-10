// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  hoverToMarkdown,
  pathToUri,
  toLspContentChanges,
  toLspPosition,
  toLspRange,
  toMonacoCompletion,
  toMonacoMarker,
  toMonacoPosition,
  toMonacoRange,
  uriToPath,
} from "./protocol.ts";

test("position converters are 1-based ↔ 0-based inverses", () => {
  assert.deepEqual(toLspPosition({ lineNumber: 1, column: 1 }), { line: 0, character: 0 });
  assert.deepEqual(toMonacoPosition({ line: 0, character: 0 }), { lineNumber: 1, column: 1 });
  const m = { lineNumber: 42, column: 7 };
  assert.deepEqual(toMonacoPosition(toLspPosition(m)), m);
  const l = { line: 9, character: 0 };
  assert.deepEqual(toLspPosition(toMonacoPosition(l)), l);
});

test("range converters round-trip", () => {
  const mr = { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 12 };
  assert.deepEqual(toMonacoRange(toLspRange(mr)), mr);
  const lr = { start: { line: 0, character: 0 }, end: { line: 2, character: 4 } };
  assert.deepEqual(toLspRange(toMonacoRange(lr)), lr);
});

test("uri helpers round-trip plain and spaced paths", () => {
  assert.equal(pathToUri("/tmp/a.ts"), "file:///tmp/a.ts");
  assert.equal(uriToPath("file:///tmp/a.ts"), "/tmp/a.ts");
  const spaced = "/Users/f/My Repo/src/index.ts";
  assert.equal(uriToPath(pathToUri(spaced)), spaced);
});

test("diagnostic severity maps LSP → monaco MarkerSeverity values", () => {
  const base = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    message: "x",
  };
  assert.equal(toMonacoMarker({ ...base, severity: 1 }).severity, 8); // Error
  assert.equal(toMonacoMarker({ ...base, severity: 2 }).severity, 4); // Warning
  assert.equal(toMonacoMarker({ ...base, severity: 3 }).severity, 2); // Info
  assert.equal(toMonacoMarker({ ...base, severity: 4 }).severity, 1); // Hint
  const m = toMonacoMarker({ ...base, severity: 1, code: 2304, source: "ts" });
  assert.equal(m.code, "2304");
  assert.equal(m.startLineNumber, 1);
  assert.equal(m.endColumn, 2);
});

test("completion mirrors textEdit range exactly and flags snippets", () => {
  const defaultRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 };
  // plain item — falls back to the caller's word range + label as insertText
  const plain = toMonacoCompletion({ label: "foo" }, defaultRange);
  assert.equal(plain.insertText, "foo");
  assert.deepEqual(plain.range, defaultRange);
  assert.equal(plain.insertTextRules, undefined);

  // textEdit range must be mirrored EXACTLY, not the default word range
  const withEdit = toMonacoCompletion(
    {
      label: "bar",
      textEdit: {
        range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } },
        newText: "bar()",
      },
      insertTextFormat: 2,
      kind: 2, // LSP Method
    },
    defaultRange,
  );
  assert.deepEqual(withEdit.range, {
    startLineNumber: 5,
    startColumn: 3,
    endLineNumber: 5,
    endColumn: 10,
  });
  assert.equal(withEdit.insertText, "bar()");
  assert.equal(withEdit.insertTextRules, 4); // InsertAsSnippet
  assert.equal(withEdit.kind, 0); // monaco Method

  // InsertReplaceEdit → monaco's dual insert/replace range
  const dual = toMonacoCompletion(
    {
      label: "baz",
      textEdit: {
        insert: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
        replace: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "baz",
      },
    },
    defaultRange,
  );
  assert.deepEqual(dual.range, {
    insert: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 },
    replace: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
  });
});

test("hover contents normalize to markdown strings", () => {
  assert.deepEqual(hoverToMarkdown("plain"), ["plain"]);
  assert.deepEqual(hoverToMarkdown({ kind: "markdown", value: "**md**" }), ["**md**"]);
  assert.deepEqual(hoverToMarkdown({ language: "typescript", value: "const x: number" }), [
    "```typescript\nconst x: number\n```",
  ]);
  assert.deepEqual(hoverToMarkdown(["a", { language: "ts", value: "b" }]), [
    "a",
    "```ts\nb\n```",
  ]);
});

test("incremental changes sort descending by offset for sequential apply", () => {
  // two same-event edits (multi-cursor): monaco reports both against the
  // BEFORE state; LSP applies sequentially → bottom-most must go first.
  const changes = [
    {
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      rangeOffset: 0,
      rangeLength: 0,
      text: "a",
    },
    {
      range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 },
      rangeOffset: 20,
      rangeLength: 0,
      text: "b",
    },
  ];
  const out = toLspContentChanges(changes);
  assert.equal(out[0].text, "b");
  assert.equal(out[0].range.start.line, 2);
  assert.equal(out[1].text, "a");
  assert.equal(out[1].range.start.line, 0);
});
