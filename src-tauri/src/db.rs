//! External database connections — Postgres (incl. Neon) + MySQL.
//!
//! Lets the Database pane browse real databases alongside the file-backed
//! memory vault. Connection configs (including credentials in the URL) are
//! stored locally at `$HOME/.aios/state/db-connections.json` with 0600 perms —
//! this is a single-user local cockpit, same trust model as the rest of AIOS.
//!
//! Query strategy:
//!   - Postgres: wrap SELECTs in `to_jsonb(row)` server-side so dynamic result
//!     rows come back as clean JSON objects — no per-type decode dance. Column
//!     order comes from `information_schema` (table browse) or the JSON key
//!     order (ad-hoc query; serde_json `preserve_order` keeps it stable).
//!   - MySQL: no `to_jsonb`, so decode each column by probing common types
//!     (i64 / f64 / bool / datetime / string / bytes) and fall back to null.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::{Column, Row, TypeInfo};

// ── connection store ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    /// "postgres" | "mysql".
    pub kind: String,
    /// Full connection URL (contains credentials). Never sent to the frontend.
    pub url: String,
}

/// Connection metadata safe to expose to the UI — URL/password stripped, just
/// enough to label and group connections.
#[derive(Debug, Clone, Serialize)]
pub struct ConnMeta {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// host:port/database — derived from the URL for display, no credentials.
    pub target: String,
}

fn store_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    std::path::Path::new(&home)
        .join(".aios")
        .join("state")
        .join("db-connections.json")
}

fn load_store() -> Vec<Connection> {
    let p = store_path();
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_store(conns: &[Connection]) -> Result<(), String> {
    let p = store_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(conns).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| e.to_string())?;
    // Best-effort lock-down — file holds credentials.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Strips credentials from a URL for display: `scheme://host:port/db`.
fn safe_target(url: &str) -> String {
    // Cheap parse — avoid a url-crate dep. Format: scheme://[user[:pass]@]host[:port]/db?...
    let after_scheme = url.splitn(2, "://").nth(1).unwrap_or(url);
    let after_auth = after_scheme.rsplitn(2, '@').next().unwrap_or(after_scheme);
    let no_query = after_auth.split(['?', '#']).next().unwrap_or(after_auth);
    no_query.to_string()
}

fn meta(c: &Connection) -> ConnMeta {
    ConnMeta {
        id: c.id.clone(),
        name: c.name.clone(),
        kind: c.kind.clone(),
        target: safe_target(&c.url),
    }
}

fn find(id: &str) -> Result<Connection, String> {
    load_store()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "connection not found".into())
}

// ── shaped query result ────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct QueryResult {
    /// Column names in display order.
    pub columns: Vec<String>,
    /// One JSON object per row, keyed by column name.
    pub rows: Vec<Value>,
    /// For non-SELECT statements — rows affected (else null).
    pub affected: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
}

// ── commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_list_connections() -> Vec<ConnMeta> {
    load_store().iter().map(meta).collect()
}

/// Tests a connection, then persists it. Returns the new connection's metadata.
#[tauri::command]
pub async fn db_add_connection(
    name: String,
    kind: String,
    url: String,
) -> Result<ConnMeta, String> {
    // Probe before saving so we never store a dead config.
    probe(&kind, &url).await?;

    let id = format!("{:x}", fnv1a(&format!("{name}|{url}")));
    let conn = Connection { id, name, kind, url };
    let mut store = load_store();
    // De-dupe by id (same name+url) — replace in place.
    store.retain(|c| c.id != conn.id);
    let m = meta(&conn);
    store.push(conn);
    save_store(&store)?;
    Ok(m)
}

#[tauri::command]
pub fn db_remove_connection(id: String) -> Result<(), String> {
    let mut store = load_store();
    let before = store.len();
    store.retain(|c| c.id != id);
    if store.len() == before {
        return Err("connection not found".into());
    }
    save_store(&store)
}

#[tauri::command]
pub async fn db_test_connection(kind: String, url: String) -> Result<String, String> {
    probe(&kind, &url).await?;
    Ok("ok".into())
}

#[tauri::command]
pub async fn db_list_tables(id: String) -> Result<Vec<TableInfo>, String> {
    let c = find(&id)?;
    match c.kind.as_str() {
        "postgres" => pg_list_tables(&c.url).await,
        "mysql" => my_list_tables(&c.url).await,
        k => Err(format!("unsupported kind: {k}")),
    }
}

#[tauri::command]
pub async fn db_table_rows(
    id: String,
    schema: String,
    table: String,
    limit: i64,
    offset: i64,
) -> Result<QueryResult, String> {
    let c = find(&id)?;
    let lim = limit.clamp(1, 1000);
    let off = offset.max(0);
    match c.kind.as_str() {
        "postgres" => {
            let sql = format!(
                "SELECT * FROM {}.{} LIMIT {lim} OFFSET {off}",
                quote_pg(&schema),
                quote_pg(&table)
            );
            pg_query(&c.url, &sql).await
        }
        "mysql" => {
            let sql = format!(
                "SELECT * FROM {}.{} LIMIT {lim} OFFSET {off}",
                quote_my(&schema),
                quote_my(&table)
            );
            my_query(&c.url, &sql).await
        }
        k => Err(format!("unsupported kind: {k}")),
    }
}

/// Runs an arbitrary statement. SELECTs return rows; other statements return
/// `affected`. A hard LIMIT is applied to SELECTs that lack one.
#[tauri::command]
pub async fn db_query(id: String, sql: String) -> Result<QueryResult, String> {
    let c = find(&id)?;
    match c.kind.as_str() {
        "postgres" => pg_query(&c.url, &sql).await,
        "mysql" => my_query(&c.url, &sql).await,
        k => Err(format!("unsupported kind: {k}")),
    }
}

// ── postgres ───────────────────────────────────────────────────────────────

use sqlx::postgres::PgPoolOptions;
use sqlx::mysql::MySqlPoolOptions;

async fn pg_connect(url: &str) -> Result<sqlx::PgPool, String> {
    PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(12))
        .connect(url)
        .await
        .map_err(|e| e.to_string())
}

async fn my_connect(url: &str) -> Result<sqlx::MySqlPool, String> {
    MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(12))
        .connect(url)
        .await
        .map_err(|e| e.to_string())
}

async fn probe(kind: &str, url: &str) -> Result<(), String> {
    match kind {
        "postgres" => {
            let pool = pg_connect(url).await?;
            sqlx::query("SELECT 1").execute(&pool).await.map_err(|e| e.to_string())?;
            pool.close().await;
            Ok(())
        }
        "mysql" => {
            let pool = my_connect(url).await?;
            sqlx::query("SELECT 1").execute(&pool).await.map_err(|e| e.to_string())?;
            pool.close().await;
            Ok(())
        }
        k => Err(format!("unsupported kind: {k}")),
    }
}

async fn pg_list_tables(url: &str) -> Result<Vec<TableInfo>, String> {
    let pool = pg_connect(url).await?;
    let rows = sqlx::query(
        "SELECT table_schema, table_name FROM information_schema.tables \
         WHERE table_schema NOT IN ('pg_catalog','information_schema') \
         ORDER BY table_schema, table_name",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    pool.close().await;
    Ok(rows
        .iter()
        .map(|r| TableInfo {
            schema: r.try_get::<String, _>(0).unwrap_or_default(),
            name: r.try_get::<String, _>(1).unwrap_or_default(),
        })
        .collect())
}

/// Determines whether a statement is a row-returning query we can wrap.
fn is_select(sql: &str) -> bool {
    let t = sql.trim_start().to_lowercase();
    t.starts_with("select") || t.starts_with("with") || t.starts_with("show") || t.starts_with("table")
}

async fn pg_query(url: &str, sql: &str) -> Result<QueryResult, String> {
    let pool = pg_connect(url).await?;
    let trimmed = sql.trim().trim_end_matches(';');

    if !is_select(trimmed) {
        let res = sqlx::query(trimmed).execute(&pool).await.map_err(|e| e.to_string());
        pool.close().await;
        let r = res?;
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected: Some(r.rows_affected()),
        });
    }

    // Wrap so every row arrives as one JSON object — no per-type decoding.
    let wrapped = format!("SELECT to_jsonb(_q) AS _row FROM ( {trimmed} ) _q LIMIT 1000");
    let rows = sqlx::query(&wrapped).fetch_all(&pool).await.map_err(|e| e.to_string());
    pool.close().await;
    let rows = rows?;

    let mut out: Vec<Value> = Vec::with_capacity(rows.len());
    let mut columns: Vec<String> = Vec::new();
    for r in &rows {
        let v: Value = r.try_get::<Value, _>(0).unwrap_or(Value::Null);
        if columns.is_empty() {
            if let Value::Object(map) = &v {
                columns = map.keys().cloned().collect();
            }
        }
        out.push(v);
    }
    Ok(QueryResult { columns, rows: out, affected: None })
}

// ── mysql ──────────────────────────────────────────────────────────────────

async fn my_list_tables(url: &str) -> Result<Vec<TableInfo>, String> {
    let pool = my_connect(url).await?;
    let rows = sqlx::query(
        "SELECT table_schema, table_name FROM information_schema.tables \
         WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') \
         ORDER BY table_schema, table_name",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    pool.close().await;
    Ok(rows
        .iter()
        .map(|r| TableInfo {
            schema: r.try_get::<String, _>(0).unwrap_or_default(),
            name: r.try_get::<String, _>(1).unwrap_or_default(),
        })
        .collect())
}

async fn my_query(url: &str, sql: &str) -> Result<QueryResult, String> {
    let pool = my_connect(url).await?;
    let trimmed = sql.trim().trim_end_matches(';');

    if !is_select(trimmed) {
        let res = sqlx::query(trimmed).execute(&pool).await.map_err(|e| e.to_string());
        pool.close().await;
        let r = res?;
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected: Some(r.rows_affected()),
        });
    }

    let capped = if trimmed.to_lowercase().contains(" limit ") {
        trimmed.to_string()
    } else {
        format!("{trimmed} LIMIT 1000")
    };
    let rows = sqlx::query(&capped).fetch_all(&pool).await.map_err(|e| e.to_string());
    pool.close().await;
    let rows = rows?;

    let mut columns: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::with_capacity(rows.len());
    for (ri, r) in rows.iter().enumerate() {
        if ri == 0 {
            columns = r.columns().iter().map(|c| c.name().to_string()).collect();
        }
        let mut obj = Map::new();
        for (i, col) in r.columns().iter().enumerate() {
            obj.insert(col.name().to_string(), my_decode(r, i, col.type_info().name()));
        }
        out.push(Value::Object(obj));
    }
    Ok(QueryResult { columns, rows: out, affected: None })
}

/// Best-effort decode of one MySQL cell to a JSON value. Probes by declared
/// type first, then falls back through common scalar types to a string.
fn my_decode(row: &sqlx::mysql::MySqlRow, i: usize, type_name: &str) -> Value {
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

    let t = type_name.to_uppercase();
    // Integers.
    if t.contains("INT") {
        if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(i) {
            return json!(v);
        }
    }
    // Floats / decimals.
    if t.contains("FLOAT") || t.contains("DOUBLE") || t.contains("DECIMAL") || t.contains("NUMERIC")
    {
        if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(i) {
            return json!(v);
        }
    }
    // Booleans (TINYINT(1) usually surfaces as BOOL/TINYINT).
    if t.contains("BOOL") {
        if let Ok(Some(v)) = row.try_get::<Option<bool>, _>(i) {
            return json!(v);
        }
    }
    // Temporal → ISO string.
    if t.contains("DATETIME") || t.contains("TIMESTAMP") {
        if let Ok(Some(v)) = row.try_get::<Option<NaiveDateTime>, _>(i) {
            return json!(v.to_string());
        }
    }
    if t == "DATE" {
        if let Ok(Some(v)) = row.try_get::<Option<NaiveDate>, _>(i) {
            return json!(v.to_string());
        }
    }
    if t == "TIME" {
        if let Ok(Some(v)) = row.try_get::<Option<NaiveTime>, _>(i) {
            return json!(v.to_string());
        }
    }
    // JSON columns.
    if t.contains("JSON") {
        if let Ok(Some(v)) = row.try_get::<Option<Value>, _>(i) {
            return v;
        }
    }
    // Strings / everything textual.
    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(i) {
        return json!(v);
    }
    // Binary blobs → hex-ish length marker rather than dumping bytes.
    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return json!(format!("‹{} bytes›", v.len()));
    }
    Value::Null
}

// ── identifier quoting ───────────────────────────────────────────────────────

fn quote_pg(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

fn quote_my(ident: &str) -> String {
    format!("`{}`", ident.replace('`', "``"))
}

// ── tiny hash for connection ids ─────────────────────────────────────────────

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

// ════════════════════════════════════════════════════════════════════════
// Row-level CRUD (Postgres / Neon). Writes are parameterized and cast to each
// column's declared type (`$n::udt`), and UPDATE/DELETE are keyed strictly on
// the table's primary key — a table without one can't be edited safely.
// ════════════════════════════════════════════════════════════════════════

#[derive(Debug, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    /// Postgres `udt_name` (int4, varchar, timestamptz, uuid, jsonb, bool, …) —
    /// also a valid cast target for parameter binding.
    pub udt: String,
    pub nullable: bool,
    pub is_pk: bool,
    pub has_default: bool,
}

#[tauri::command]
pub async fn db_table_columns(
    id: String,
    schema: String,
    table: String,
) -> Result<Vec<ColumnInfo>, String> {
    let c = find(&id)?;
    match c.kind.as_str() {
        "postgres" => pg_columns(&c.url, &schema, &table).await,
        k => Err(format!("column introspection not supported for {k} yet")),
    }
}

async fn pg_columns(url: &str, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let pool = pg_connect(url).await?;
    let qualified = format!("{}.{}", quote_pg(schema), quote_pg(table));
    let sql = "SELECT c.column_name, c.udt_name, (c.is_nullable = 'YES') AS nullable, \
               (c.column_default IS NOT NULL) AS has_default, \
               COALESCE(pk.is_pk, false) AS is_pk \
               FROM information_schema.columns c \
               LEFT JOIN ( \
                 SELECT a.attname AS col, true AS is_pk \
                 FROM pg_index i \
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
                 WHERE i.indrelid = $3::regclass AND i.indisprimary \
               ) pk ON pk.col = c.column_name \
               WHERE c.table_schema = $1 AND c.table_name = $2 \
               ORDER BY c.ordinal_position";
    let rows = sqlx::query(sql)
        .bind(schema)
        .bind(table)
        .bind(&qualified)
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string());
    pool.close().await;
    let rows = rows?;
    Ok(rows
        .iter()
        .map(|r| ColumnInfo {
            name: r.try_get::<String, _>("column_name").unwrap_or_default(),
            udt: r.try_get::<String, _>("udt_name").unwrap_or_else(|_| "text".into()),
            nullable: r.try_get::<bool, _>("nullable").unwrap_or(true),
            has_default: r.try_get::<bool, _>("has_default").unwrap_or(false),
            is_pk: r.try_get::<bool, _>("is_pk").unwrap_or(false),
        })
        .collect())
}

/// A JSON cell value rendered to the text form sqlx binds; `None` → SQL NULL.
/// Objects/arrays serialize back to JSON text so they can cast into jsonb.
fn json_to_bind(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

/// Builds the per-connection column → udt map once for a write.
async fn pg_udt_map(
    url: &str,
    schema: &str,
    table: &str,
) -> Result<(std::collections::HashMap<String, String>, Vec<String>), String> {
    let cols = pg_columns(url, schema, table).await?;
    let map = cols.iter().map(|c| (c.name.clone(), c.udt.clone())).collect();
    let pk = cols.iter().filter(|c| c.is_pk).map(|c| c.name.clone()).collect::<Vec<_>>();
    Ok((map, pk))
}

/// Quotes a udt name for use as a cast target. Built-in names (int4, varchar,
/// timestamptz, jsonb, uuid, _text, …) are all real `pg_type` names, so quoting
/// is always valid — and it's *required* for mixed-case enums / custom types
/// (e.g. `UserRole`), which would otherwise fold to lowercase and not resolve.
fn cast_target(udt: &str) -> String {
    format!("\"{}\"", udt.replace('"', "\"\""))
}

#[tauri::command]
pub async fn db_update_row(
    id: String,
    schema: String,
    table: String,
    pk: Map<String, Value>,
    changes: Map<String, Value>,
) -> Result<u64, String> {
    let c = find(&id)?;
    if c.kind != "postgres" {
        return Err("row editing supported for postgres only right now".into());
    }
    if changes.is_empty() {
        return Ok(0);
    }
    let (udt, pk_cols) = pg_udt_map(&c.url, &schema, &table).await?;
    if pk_cols.is_empty() {
        return Err("table has no primary key — can't update safely".into());
    }
    // Guard: the supplied pk must match the real primary key exactly.
    for col in &pk_cols {
        if !pk.contains_key(col) {
            return Err(format!("missing primary key column: {col}"));
        }
    }

    let mut idx = 1;
    let mut set_parts = Vec::new();
    let mut binds: Vec<Option<String>> = Vec::new();
    for (col, val) in &changes {
        let t = udt.get(col).cloned().unwrap_or_else(|| "text".into());
        set_parts.push(format!("{} = ${}::{}", quote_pg(col), idx, cast_target(&t)));
        binds.push(json_to_bind(val));
        idx += 1;
    }
    let mut where_parts = Vec::new();
    for col in &pk_cols {
        let t = udt.get(col).cloned().unwrap_or_else(|| "text".into());
        where_parts.push(format!("{} = ${}::{}", quote_pg(col), idx, cast_target(&t)));
        binds.push(json_to_bind(&pk[col]));
        idx += 1;
    }

    let sql = format!(
        "UPDATE {}.{} SET {} WHERE {}",
        quote_pg(&schema),
        quote_pg(&table),
        set_parts.join(", "),
        where_parts.join(" AND ")
    );
    run_write(&c.url, &sql, binds).await
}

#[tauri::command]
pub async fn db_insert_row(
    id: String,
    schema: String,
    table: String,
    values: Map<String, Value>,
) -> Result<u64, String> {
    let c = find(&id)?;
    if c.kind != "postgres" {
        return Err("row editing supported for postgres only right now".into());
    }
    if values.is_empty() {
        return Err("no values to insert".into());
    }
    let (udt, _pk) = pg_udt_map(&c.url, &schema, &table).await?;

    let mut cols = Vec::new();
    let mut placeholders = Vec::new();
    let mut binds: Vec<Option<String>> = Vec::new();
    let mut idx = 1;
    for (col, val) in &values {
        let t = udt.get(col).cloned().unwrap_or_else(|| "text".into());
        cols.push(quote_pg(col));
        placeholders.push(format!("${}::{}", idx, cast_target(&t)));
        binds.push(json_to_bind(val));
        idx += 1;
    }
    let sql = format!(
        "INSERT INTO {}.{} ({}) VALUES ({})",
        quote_pg(&schema),
        quote_pg(&table),
        cols.join(", "),
        placeholders.join(", ")
    );
    run_write(&c.url, &sql, binds).await
}

#[tauri::command]
pub async fn db_delete_row(
    id: String,
    schema: String,
    table: String,
    pk: Map<String, Value>,
) -> Result<u64, String> {
    let c = find(&id)?;
    if c.kind != "postgres" {
        return Err("row editing supported for postgres only right now".into());
    }
    let (udt, pk_cols) = pg_udt_map(&c.url, &schema, &table).await?;
    if pk_cols.is_empty() {
        return Err("table has no primary key — can't delete safely".into());
    }
    let mut where_parts = Vec::new();
    let mut binds: Vec<Option<String>> = Vec::new();
    let mut idx = 1;
    for col in &pk_cols {
        let v = pk.get(col).ok_or_else(|| format!("missing primary key column: {col}"))?;
        let t = udt.get(col).cloned().unwrap_or_else(|| "text".into());
        where_parts.push(format!("{} = ${}::{}", quote_pg(col), idx, cast_target(&t)));
        binds.push(json_to_bind(v));
        idx += 1;
    }
    let sql = format!(
        "DELETE FROM {}.{} WHERE {}",
        quote_pg(&schema),
        quote_pg(&table),
        where_parts.join(" AND ")
    );
    run_write(&c.url, &sql, binds).await
}

/// Executes a parameterized write and returns rows affected.
async fn run_write(url: &str, sql: &str, binds: Vec<Option<String>>) -> Result<u64, String> {
    let pool = pg_connect(url).await?;
    let mut q = sqlx::query(sql);
    for b in &binds {
        q = q.bind(b.clone());
    }
    let res = q.execute(&pool).await.map_err(|e| e.to_string());
    pool.close().await;
    Ok(res?.rows_affected())
}

