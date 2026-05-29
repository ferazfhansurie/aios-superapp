import { invoke } from "@tauri-apps/api/core";

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

/** Reads + parses the whole memory vault into a graph. */
export async function memoryGraph(): Promise<MemoryGraph> {
  return invoke<MemoryGraph>("memory_graph");
}

/** Returns the raw markdown for a single vault file (vault-scoped guard). */
export async function memoryFile(path: string): Promise<string> {
  return invoke<string>("memory_file", { path });
}
