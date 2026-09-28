import type { WorkspaceDatabase } from "../open-database.js";
import { initialSchemaMigration } from "./001-initial-schema.js";
import { mergeHistoryMigration } from "./002-merge-history.js";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: readonly Migration[] = [initialSchemaMigration, mergeHistoryMigration];

export function applyMigrations(database: WorkspaceDatabase): number {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
    const record = database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
    for (const migration of migrations) {
      if (applied.get(migration.version)) continue;
      database.exec(migration.sql);
      record.run(migration.version, migration.name, new Date().toISOString());
      database.pragma(`user_version = ${migration.version}`);
    }
    database.exec("COMMIT");
    return Number(database.pragma("user_version", { simple: true }));
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
