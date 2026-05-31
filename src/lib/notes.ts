/** Disk-backed notes store for the AIOS scratch pane (apple-notes style).
 *
 *  Notes live as plain markdown files under `~/.aios/notes/` — ONE file per
 *  note. That path is the contract: the oracle (claude in a terminal) reads +
 *  writes the SAME files, so firaz can brain-dump ideas in the pane and hand the
 *  whole batch over in one shot, or AIOS can drop a note in for him to find.
 *
 *  Format: the note's title is its first non-empty line (a leading "# " is
 *  stripped for display); everything else is the body. Files are named by a
 *  stable id (`n-<ts>-<rand>.md`) so a rename never moves the file — the title
 *  just lives in line 1, exactly like Apple Notes does internally. */

import { homeDir, readDir, readTextFile, writeTextFile, deletePath, type DirEntry } from "./fs";

export interface Note {
  /** absolute file path — the stable id. */
  path: string;
  /** first non-empty line, "# " stripped; "new note" when empty. */
  title: string;
  /** short single-line preview of the body (after the title line). */
  preview: string;
  /** full file contents. */
  body: string;
  /** last-modified unix seconds (for sort + relative time). */
  mtime: number;
}

let notesDirCache: string | null = null;

/** Resolve (and cache) the notes directory path. */
export async function notesDir(): Promise<string> {
  if (notesDirCache) return notesDirCache;
  const home = await homeDir();
  notesDirCache = `${home}/.aios/notes`;
  return notesDirCache;
}

/** Derive a display title from raw note content (first non-empty line). */
export function titleOf(body: string): string {
  const line = body.split("\n").find((l) => l.trim().length > 0);
  if (!line) return "new note";
  return line.replace(/^#+\s*/, "").trim().slice(0, 80) || "new note";
}

/** One-line preview = the first non-empty line AFTER the title line. */
function previewOf(body: string): string {
  const lines = body.split("\n");
  let seenTitle = false;
  for (const l of lines) {
    if (l.trim().length === 0) continue;
    if (!seenTitle) {
      seenTitle = true;
      continue;
    }
    return l.replace(/^#+\s*/, "").trim().slice(0, 120);
  }
  return "";
}

/** A short, sortable, collision-resistant note id. */
function newId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `n-${ts}-${rand}`;
}

/** List every note, newest-edited first. Reads each file (notes are small and
 *  few) so the list can show real titles + previews without a second pass. */
export async function listNotes(): Promise<Note[]> {
  const dir = await notesDir();
  let entries: DirEntry[];
  try {
    entries = await readDir(dir);
  } catch {
    // dir doesn't exist yet — no notes.
    return [];
  }
  const mdFiles = entries.filter((e) => !e.is_dir && e.name.endsWith(".md"));
  const notes = await Promise.all(
    mdFiles.map(async (e) => {
      let body = "";
      try {
        body = await readTextFile(e.path);
      } catch {
        /* unreadable — show as empty */
      }
      return {
        path: e.path,
        title: titleOf(body),
        preview: previewOf(body),
        body,
        mtime: e.mtime,
      } satisfies Note;
    }),
  );
  return notes.sort((a, b) => b.mtime - a.mtime);
}

/** Create a new, empty note and return its (stable) path. The pane focuses it
 *  and the first thing typed becomes the title. */
export async function createNote(seed = ""): Promise<string> {
  const dir = await notesDir();
  const path = `${dir}/${newId()}.md`;
  await writeTextFile(path, seed);
  return path;
}

/** Save a note's full contents (atomic via the rust write). */
export async function saveNote(path: string, body: string): Promise<void> {
  await writeTextFile(path, body);
}

/** Delete a note file. */
export async function deleteNote(path: string): Promise<void> {
  await deletePath(path);
}
