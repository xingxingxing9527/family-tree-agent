import type { WorkspaceDatabase } from "../open-database.js";
import Database from "better-sqlite3";
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

const migrationLedgerSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

interface SchemaObjectRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface TableColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

interface CurrentSchemaContract {
  objects: readonly SchemaObjectRow[];
  columns: ReadonlyMap<string, readonly TableColumnRow[]>;
}

const normalizedSql = (sql: string | null): string | null => sql
  ?.replace(/CREATE\s+(TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS/giu, "CREATE $1")
  .replace(/\s+/gu, " ")
  .replace(/\s*([(),])\s*/gu, "$1")
  .trim() ?? null;

function schemaObjects(database: Database.Database): SchemaObjectRow[] {
  return (database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as SchemaObjectRow[]).map((row) => ({ ...row, sql: normalizedSql(row.sql) }));
}

function tableColumns(database: Database.Database, table: string): TableColumnRow[] {
  return (database.prepare('SELECT cid, name, type, "notnull" AS "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid').all(table) as TableColumnRow[])
    .map((row) => ({ ...row, type: row.type.toLocaleUpperCase("en-US") }));
}

function buildCurrentSchemaContract(): CurrentSchemaContract {
  const reference = new Database(":memory:");
  try {
    reference.pragma("foreign_keys = ON");
    reference.exec(migrationLedgerSql);
    const record = reference.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
    for (const migration of migrations) {
      reference.exec(migration.sql);
      record.run(migration.version, migration.name, "1970-01-01T00:00:00.000Z");
      reference.pragma(`user_version = ${migration.version}`);
    }
    const objects = schemaObjects(reference);
    return {
      objects,
      columns: new Map(objects.filter((object) => object.type === "table").map((object) => [object.name, tableColumns(reference, object.name)]))
    };
  } finally { reference.close(); }
}

const currentSchemaContract = buildCurrentSchemaContract();

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
  const actualObjects = new Map(schemaObjects(database).map((object) => [object.name, object]));
  for (const expected of currentSchemaContract.objects) {
    const actual = actualObjects.get(expected.name);
    if (!actual || actual.type !== expected.type || actual.tbl_name !== expected.tbl_name || actual.sql !== expected.sql) {
      failSchema(`required ${expected.type} ${expected.name} has an unexpected definition`);
    }
  }
  for (const [table, expectedColumns] of currentSchemaContract.columns) {
    const actualColumns = tableColumns(database, table);
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) failSchema(`required table ${table} has unexpected columns or properties`);
  }
}

export function applyMigrations(database: WorkspaceDatabase): number {
  database.exec("BEGIN IMMEDIATE");
  try {
    const currentVersion = validateMigrationLedger(database);
    database.exec(migrationLedgerSql);
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
