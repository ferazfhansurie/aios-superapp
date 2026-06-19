// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ARCHIVE_EXT,
  AUDIO_EXT,
  CODE_EXT,
  DOC_EXT,
  FONT_EXT,
  IMG_EXT,
  PDF_EXT,
  TEXT_EXT,
  VIDEO_EXT,
  VIEWER_EXT,
  extOf,
  kindForPath,
  languageForPath,
} from "./fileKinds.ts";

// ---------------------------------------------------------------------------
// Rust sync guard: src-tauri/src/files.rs keeps mirrored extension lists,
// each marked `KEEP IN SYNC with src/lib/fileKinds.ts <GROUP>`. Parse each
// marked list out of the source text and assert rust ⊆ the TS canonical set.
// ---------------------------------------------------------------------------

const filesRs = readFileSync(
  join(process.cwd(), "src-tauri/src/files.rs"),
  "utf8",
);

/** Extensions in the `matches!(...)` (or fn body) that follows a
 *  `KEEP IN SYNC with src/lib/fileKinds.ts <marker>` comment. */
function rustListAfterMarker(marker: string): string[] {
  const at = filesRs.indexOf(`KEEP IN SYNC with src/lib/fileKinds.ts ${marker}`);
  assert.notEqual(at, -1, `files.rs is missing the sync marker for ${marker}`);
  const open = filesRs.indexOf("matches!(", at);
  assert.notEqual(open, -1, `no matches!() after the ${marker} marker`);
  // Balanced-paren scan to the close of the matches! block.
  let depth = 0;
  let end = -1;
  for (let i = open + "matches!".length; i < filesRs.length; i++) {
    if (filesRs[i] === "(") depth++;
    else if (filesRs[i] === ")" && --depth === 0) {
      end = i;
      break;
    }
  }
  assert.notEqual(end, -1, `unbalanced matches!() block for ${marker}`);
  const block = filesRs.slice(open, end + 1);
  const exts = [...block.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  assert.ok(exts.length > 0, `no extensions parsed for ${marker}`);
  return exts;
}

function assertSubset(rust: string[], canonical: Set<string>, label: string) {
  const missing = rust.filter((e) => !canonical.has(e));
  assert.deepEqual(
    missing,
    [],
    `files.rs ${label} has extensions missing from the TS canonical set: ${missing.join(", ")}`,
  );
}

test("files.rs image list ⊆ IMG_EXT", () => {
  assertSubset(rustListAfterMarker("IMG_EXT"), IMG_EXT, "image list");
});

test("files.rs video list ⊆ VIDEO_EXT", () => {
  assertSubset(rustListAfterMarker("VIDEO_EXT"), VIDEO_EXT, "video list");
});

test("files.rs texty list ⊆ CODE_EXT ∪ TEXT_EXT", () => {
  const union = new Set([...CODE_EXT, ...TEXT_EXT]);
  assertSubset(rustListAfterMarker("CODE_EXT"), union, "texty list");
});

test("files.rs office list ⊆ DOC_EXT", () => {
  assertSubset(rustListAfterMarker("DOC_EXT"), DOC_EXT, "is_office_ext");
});

// ---------------------------------------------------------------------------
// Canonical-set invariants
// ---------------------------------------------------------------------------

test("ext groups are mutually disjoint", () => {
  const groups: [string, Set<string>][] = [
    ["IMG_EXT", IMG_EXT],
    ["VIDEO_EXT", VIDEO_EXT],
    ["AUDIO_EXT", AUDIO_EXT],
    ["PDF_EXT", PDF_EXT],
    ["DOC_EXT", DOC_EXT],
    ["ARCHIVE_EXT", ARCHIVE_EXT],
    ["FONT_EXT", FONT_EXT],
    ["CODE_EXT", CODE_EXT],
    ["TEXT_EXT", TEXT_EXT],
  ];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const overlap = [...groups[i][1]].filter((e) => groups[j][1].has(e));
      assert.deepEqual(
        overlap,
        [],
        `${groups[i][0]} ∩ ${groups[j][0]} should be empty`,
      );
    }
  }
});

test("VIEWER_EXT = media ∪ docs ∪ binaries ∪ markdown, never code", () => {
  for (const ext of [...IMG_EXT, ...VIDEO_EXT, ...AUDIO_EXT, ...PDF_EXT, ...DOC_EXT, ...ARCHIVE_EXT, ...FONT_EXT]) {
    assert.ok(VIEWER_EXT.has(ext), `${ext} should route to the viewer`);
  }
  assert.ok(VIEWER_EXT.has("md") && VIEWER_EXT.has("markdown"));
  for (const ext of CODE_EXT) {
    assert.ok(!VIEWER_EXT.has(ext), `${ext} must route to the editor`);
  }
});

// ---------------------------------------------------------------------------
// kindForPath / extOf / languageForPath behavior
// ---------------------------------------------------------------------------

test("extOf handles dotfiles, dotless names, and multi-dot paths", () => {
  assert.equal(extOf("/a/b/photo.JPG"), "jpg");
  assert.equal(extOf("/x/.env"), "env");
  assert.equal(extOf("Dockerfile"), "dockerfile");
  assert.equal(extOf("/v1.2/archive.tar.gz"), "gz");
  assert.equal(extOf("/v1.2/README"), "readme");
});

test("kindForPath classifies the canonical kinds", () => {
  assert.equal(kindForPath("a.png"), "image");
  assert.equal(kindForPath("a.mp4"), "video");
  assert.equal(kindForPath("a.mp3"), "audio");
  assert.equal(kindForPath("a.pdf"), "pdf");
  assert.equal(kindForPath("a.docx"), "doc");
  assert.equal(kindForPath("a.odt"), "doc");
  assert.equal(kindForPath("a.zip"), "archive");
  assert.equal(kindForPath("a.woff2"), "font");
  assert.equal(kindForPath("a.tsx"), "code");
  assert.equal(kindForPath("a.md"), "text");
  assert.equal(kindForPath("a.blob"), "binary");
});

test("languageForPath keeps its legacy mappings", () => {
  assert.equal(languageForPath("src/App.tsx"), "typescript");
  assert.equal(languageForPath("main.rs"), "rust");
  assert.equal(languageForPath("notes.md"), "markdown");
  assert.equal(languageForPath(".env"), "ini");
  assert.equal(languageForPath("unknown.xyz"), "plaintext");
});

test("languageForPath highlights the infra/scripting/markup grammars Monaco ships", () => {
  assert.equal(languageForPath("main.tf"), "hcl");
  assert.equal(languageForPath("vars.tfvars"), "hcl");
  assert.equal(languageForPath("config.hcl"), "hcl");
  assert.equal(languageForPath("deploy.ps1"), "powershell");
  assert.equal(languageForPath("mod.psm1"), "powershell");
  assert.equal(languageForPath("build.bat"), "bat");
  assert.equal(languageForPath("run.cmd"), "bat");
  assert.equal(languageForPath("app.coffee"), "coffeescript");
  assert.equal(languageForPath("plot.jl"), "julia");
  assert.equal(languageForPath("Token.sol"), "sol");
  assert.equal(languageForPath("init.tcl"), "tcl");
  assert.equal(languageForPath("Form.vb"), "vb");
  assert.equal(languageForPath("page.hbs"), "handlebars");
  assert.equal(languageForPath("view.pug"), "pug");
  // already declared as code/text but previously fell through to plaintext:
  assert.equal(languageForPath("app.properties"), "ini");
  assert.equal(languageForPath("README.rst"), "restructuredtext");
});

// Pins the only extensions we intentionally leave as plaintext: Monaco ships no
// grammar for them (Make, Gradle/Groovy, Elm). Any NEW CODE_EXT addition must
// either get an EDITOR_LANGUAGE mapping or be consciously added to this list —
// otherwise a code file silently opens with no syntax highlighting.
test("every CODE_EXT extension highlights, except the known Monaco-unsupported ones", () => {
  const NO_MONACO_GRAMMAR = ["elm", "gradle", "makefile"];
  const plaintext = [...CODE_EXT]
    .filter((ext) => languageForPath(`x.${ext}`) === "plaintext")
    .sort();
  assert.deepEqual(
    plaintext,
    NO_MONACO_GRAMMAR,
    "CODE_EXT entries falling through to plaintext changed — add a mapping or update the allowlist",
  );
});

// Guard against dead mappings: Monaco's setModelLanguage resolves by language
// *id*, not display alias — mapping ".sol" to "solidity" (an alias of id "sol")
// silently yields plaintext. Validate every value the language table can emit
// against the ids the INSTALLED Monaco actually registers, read from disk the
// same way the rust-sync guard above reads files.rs.
test("every emitted language id is registered by the installed Monaco", () => {
  const root = join(process.cwd(), "node_modules/monaco-editor/esm/vs");
  const basicDir = join(root, "basic-languages");
  const ids = new Set();
  for (const lang of readdirSync(basicDir, { withFileTypes: true })) {
    if (!lang.isDirectory()) continue;
    const src = readFileSync(
      join(basicDir, lang.name, `${lang.name}.contribution.js`),
      "utf8",
    );
    // A single contribution can register several ids (e.g. cpp → "c" + "cpp").
    for (const m of src.matchAll(/id:\s*["']([^"']+)["']/g)) ids.add(m[1]);
  }
  // Rich language-service ids (vs/language/*) + the manual Dart grammar
  // (monaco.ts) + the built-in plaintext fallback — none live in basic-languages.
  for (const id of ["typescript", "javascript", "json", "dart", "plaintext"]) {
    ids.add(id);
  }
  const emitted = new Set(
    [...CODE_EXT, ...TEXT_EXT].map((ext) => languageForPath(`x.${ext}`)),
  );
  const dead = [...emitted].filter((id) => !ids.has(id)).sort();
  assert.deepEqual(
    dead,
    [],
    `EDITOR_LANGUAGE maps to ids Monaco doesn't register (→ silent plaintext): ${dead.join(", ")}`,
  );
});
