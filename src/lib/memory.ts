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
  /** Source vault label. */
  vault?: string;
  /** Absolute path to the source vault. */
  vault_path?: string;
  /** File modified time, unix seconds. */
  mtime?: number;
  /** Outbound `[[wikilink]]` targets that resolve to a known node. */
  links: string[];
  /** Inbound links from notes that reference this node. */
  backlinks: string[];
  /** Notes mentioned in this body but not yet linked with `[[...]]`. */
  suggested_links: string[];
  /** Link count used to size important memories. */
  degree: number;
  /** Stable visual cluster, usually user/project/feedback/reference. */
  cluster: string;
  /** True when the node has no committed inbound/outbound links. */
  orphan: boolean;
}

/** A directed link between two nodes (file → referenced note). */
export interface MemoryEdge {
  source: string;
  target: string;
  kind?: string;
  weight?: number;
}

/** Full graph payload returned by the `memory_graph` command. */
export interface MemoryGraph {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  vault_path: string;
  vaults?: Array<{ path: string; label: string; primary: boolean }>;
  count: number;
}

export interface MemoryHit {
  id: string;
  title: string;
  type: string;
  description: string;
  path: string;
  vault?: string;
  mtime?: number;
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

export async function memorySave(
  name: string,
  nodeType: string,
  description: string,
  body: string,
  oldName?: string | null,
): Promise<string> {
  return invoke<string>("memory_save", {
    name,
    nodeType,
    description,
    body,
    oldName: oldName ?? null,
  });
}

export async function memorySaveRaw(path: string, body: string): Promise<void> {
  return invoke<void>("memory_save_raw", { path, body });
}

export async function memoryDeletePath(path: string): Promise<void> {
  return invoke<void>("memory_delete_path", { path });
}
