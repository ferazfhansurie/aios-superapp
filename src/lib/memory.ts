import { invoke } from "./tauri";

/** One memory note in the vault graph. */
export interface MemoryNode {
  /** Filename without extension, e.g. `feedback_wa_must_go_through_push`. */
  id: string;
  /** Frontmatter `name`, falling back to the id. */
  title: string;
  /** Category — user / feedback / project / reference (from metadata.type). */
  type: string;
  /** Frontmatter `description`, empty when absent. */
  description: string;
  /** Absolute path to the source file. */
  path: string;
  /** Outbound `[[wikilink]]` targets that resolve to a known node. */
  links: string[];
}

/** A directed link between two nodes (file → referenced note). */
export interface MemoryEdge {
  source: string;
  target: string;
}

/** Full graph payload returned by the `memory_graph` command. */
export interface MemoryGraph {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  vault_path: string;
  count: number;
}

export interface MemoryHit {
  id: string;
  title: string;
  type: string;
  description: string;
  path: string;
  score: number;
  reasons: string[];
  preview: string;
}

/** Reads + parses the whole memory vault into a graph. */
export async function memoryGraph(): Promise<MemoryGraph> {
  return invoke<MemoryGraph>("memory_graph");
}

/** Returns the raw markdown for a single vault file (vault-scoped guard). */
export async function memoryFile(path: string): Promise<string> {
  return invoke<string>("memory_file", { path });
}

/** Ranked memory retrieval with reason strings for visible chat context. */
export async function memorySearch(
  query: string,
  cwd?: string | null,
  limit = 8,
): Promise<MemoryHit[]> {
  return invoke<MemoryHit[]>("memory_search", { query, cwd: cwd ?? null, limit });
}
