import type { WorkspaceDatabase } from "../open-database.js";
import { initialSchemaMigration } from "./001-initial-schema.js";
import { mergeHistoryMigration } from "./002-merge-history.js";
import { wikiFtsMigration } from "./003-wiki-fts.js";
import { operationGroupUndoMigration } from "./004-operation-group-undo.js";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: readonly Migration[] = [initialSchemaMigration, mergeHistoryMigration, wikiFtsMigration, operationGroupUndoMigration];

export const LATEST_SCHEMA_VERSION = migrations.at(-1)!.version;

const requiredTables = [
  "audit_log", "id_redirect", "import_identity", "lineage", "lineage_membership", "marriage", "media_asset", "media_person",
  "merge_record", "operation_group", "parent_child", "person", "person_alias", "schema_migrations", "source", "wiki_entry",
  "wiki_fts", "wiki_person", "wiki_source", "workspace_meta"
] as const;

const requiredColumns: Readonly<Record<string, readonly string[]>> = {
  workspace_meta: ["workspace_id", "name", "origin_person_id", "row_version"],
  operation_group: ["id", "workspace_id", "kind", "undone_at", "row_version"],
  merge_record: ["id", "workspace_id", "status", "snapshot_json", "post_versions_json", "reversed_operation_group_id"],
  media_asset: ["id", "workspace_id", "sha256", "byte_size", "relative_path"],
  audit_log: ["id", "workspace_id", "operation_group_id", "entity_type", "entity_id", "before_json", "after_json"],
  wiki_source: ["id", "workspace_id", "wiki_entry_id", "source_id"]
};

const requiredIndexes = [
  "audit_log_operation_group_idx", "media_asset_active_hash_uq", "operation_group_history_idx", "person_alias_active_uq",
  "source_active_key_uq", "wiki_source_active_uq"
] as const;

const failSchema = (message: string): never => { throw new Error(`Migration schema validation failed: ${message}`); };

export function validateMigrationLedger(database: WorkspaceDatabase, expectedVersion?: number): number {
  const userVersion = Number(database.pragma("user_version", { simple: true }));
  if (!Number.isSafeInteger(userVersion) || userVersion < 0 || userVersion > LATEST_SCHEMA_VERSION) failSchema("PRAGMA user_version is unsupported");
  const hasLedger = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get());
  if (!hasLedger) {
    if (userVersion !== 0) failSchema("user_version exists without a migration ledger");
    if (expectedVersion !== undefined && expectedVersion !== 0) failSchema("migration ledger is missing");
    return 0;
  }
  let rows: Array<{ version: number; name: string }>;
  try {
    rows = database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{ version: number; name: string }>;
  } catch {
    return failSchema("migration ledger columns are invalid");
  }
  if (rows.length !== userVersion) failSchema("migration ledger length does not match user_version");
  rows.forEach((row, index) => {
    const expected = migrations[index];
    if (!expected || row.version !== expected.version || row.name !== expected.name) failSchema("migration ledger is non-contiguous or unknown");
  });
  if (expectedVersion !== undefined && userVersion !== expectedVersion) failSchema("schema version is not the required version");
  return userVersion;
}

export function validateCurrentSchema(database: WorkspaceDatabase): void {
  validateMigrationLedger(database, LATEST_SCHEMA_VERSION);
  const objects = new Map((database.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; type: string }>).map((row) => [row.name, row.type]));
  for (const table of requiredTables) if (objects.get(table) !== "table") failSchema(`required table ${table} is missing`);
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = new Set((database.prepare(`SELECT name FROM pragma_table_info(?)`).pluck().all(table) as string[]));
    for (const column of columns) if (!actual.has(column)) failSchema(`required column ${table}.${column} is missing`);
  }
  for (const index of requiredIndexes) if (objects.get(index) !== "index") failSchema(`required index ${index} is missing`);
}

export function applyMigrations(database: WorkspaceDatabase): number {
  database.exec("BEGIN IMMEDIATE");
  try {
    const currentVersion = validateMigrationLedger(database);
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const record = database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue;
      database.exec(migration.sql);
      record.run(migration.version, migration.name, new Date().toISOString());
      database.pragma(`user_version = ${migration.version}`);
    }
    validateCurrentSchema(database);
    database.exec("COMMIT");
    return LATEST_SCHEMA_VERSION;
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
