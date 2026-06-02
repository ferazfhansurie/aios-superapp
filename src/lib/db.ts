import { invoke } from "./tauri";

/** A saved external database connection (credentials live only in the backend). */
export interface ConnMeta {
  id: string;
  name: string;
  /** "postgres" | "mysql". */
  kind: string;
  /** host:port/database — display only, no credentials. */
  target: string;
}

export interface TableInfo {
  schema: string;
  name: string;
}

/** Result of a query/table browse. Each row is a JSON object keyed by column. */
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Rows affected for non-SELECT statements; null otherwise. */
  affected: number | null;
}

export type DbKind = "postgres" | "mysql";

export async function dbListConnections(): Promise<ConnMeta[]> {
  return invoke<ConnMeta[]>("db_list_connections");
}

export async function dbAddConnection(name: string, kind: DbKind, url: string): Promise<ConnMeta> {
  return invoke<ConnMeta>("db_add_connection", { name, kind, url });
}

export async function dbRemoveConnection(id: string): Promise<void> {
  return invoke<void>("db_remove_connection", { id });
}

export async function dbTestConnection(kind: DbKind, url: string): Promise<string> {
  return invoke<string>("db_test_connection", { kind, url });
}

export async function dbListTables(id: string): Promise<TableInfo[]> {
  return invoke<TableInfo[]>("db_list_tables", { id });
}

export async function dbTableRows(
  id: string,
  schema: string,
  table: string,
  limit: number,
  offset: number,
): Promise<QueryResult> {
  return invoke<QueryResult>("db_table_rows", { id, schema, table, limit, offset });
}

export async function dbQuery(id: string, sql: string, allowWrite = false): Promise<QueryResult> {
  return invoke<QueryResult>("db_query", { id, sql, allowWrite });
}

// ── row-level CRUD (postgres / neon) ─────────────────────────────────────────

export interface ColumnInfo {
  name: string;
  /** postgres udt_name (int4, varchar, timestamptz, uuid, jsonb, bool, …). */
  udt: string;
  nullable: boolean;
  is_pk: boolean;
  has_default: boolean;
}

export async function dbTableColumns(
  id: string,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  return invoke<ColumnInfo[]>("db_table_columns", { id, schema, table });
}

export async function dbUpdateRow(
  id: string,
  schema: string,
  table: string,
  pk: Record<string, unknown>,
  changes: Record<string, unknown>,
): Promise<number> {
  return invoke<number>("db_update_row", { id, schema, table, pk, changes });
}

export async function dbInsertRow(
  id: string,
  schema: string,
  table: string,
  values: Record<string, unknown>,
): Promise<number> {
  return invoke<number>("db_insert_row", { id, schema, table, values });
}

export async function dbDeleteRow(
  id: string,
  schema: string,
  table: string,
  pk: Record<string, unknown>,
): Promise<number> {
  return invoke<number>("db_delete_row", { id, schema, table, pk });
}

// ── memory vault CRUD ────────────────────────────────────────────────────────

export async function memorySave(args: {
  name: string;
  nodeType: string;
  description: string;
  body: string;
  oldName?: string;
}): Promise<string> {
  return invoke<string>("memory_save", {
    name: args.name,
    nodeType: args.nodeType,
    description: args.description,
    body: args.body,
    oldName: args.oldName ?? null,
  });
}

export async function memoryDelete(name: string): Promise<void> {
  return invoke<void>("memory_delete", { name });
}
