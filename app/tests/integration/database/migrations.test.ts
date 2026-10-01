import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../src/main/database/open-database";
import { applyMigrations, validateCurrentSchema } from "../../../src/main/database/migrations";
import { initialSchemaMigration } from "../../../src/main/database/migrations/001-initial-schema";

describe("database migrations", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("migrates an empty database to version 6 exactly once with stable person codes", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-database-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));

    try {
      expect(applyMigrations(database)).toBe(6);
      expect(applyMigrations(database)).toBe(6);
      expect(database.pragma("user_version", { simple: true })).toBe(6);
      expect(database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get()).toBe(6);
      expect(database.prepare("SELECT name FROM pragma_table_info('operation_group') WHERE name = 'undone_at'").pluck().get()).toBe("undone_at");
      expect(database.prepare("SELECT name FROM pragma_table_info('lineage_membership') WHERE name = 'generation_marker'").pluck().get()).toBe("generation_marker");
      expect(database.prepare("SELECT name FROM pragma_table_info('person') WHERE name = 'person_code'").pluck().get()).toBe("person_code");
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      database.close();
    }
  });

  it("rolls back a failed migration without advancing the schema version", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-database-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));
    database.exec("CREATE TABLE person (id TEXT PRIMARY KEY)");

    try {
      expect(() => applyMigrations(database)).toThrow();
      expect(database.pragma("user_version", { simple: true })).toBe(0);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("creates the complete schema and enforces genealogy invariants", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-database-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[]);
    expect(tables).toEqual([
      "audit_log", "id_redirect", "import_identity", "lineage", "lineage_membership",
      "marriage", "media_asset", "media_person", "merge_record", "operation_group",
      "parent_child", "person", "person_alias", "person_code_counter", "schema_migrations", "source",
      "wiki_entry", "wiki_fts", "wiki_fts_config", "wiki_fts_content", "wiki_fts_data", "wiki_fts_docsize", "wiki_fts_idx", "wiki_person", "wiki_source", "workspace_meta"
    ]);

    const now = new Date().toISOString();
    expect(() => database.prepare("INSERT INTO workspace_meta (workspace_id, name, origin_person_id, created_at, updated_at) VALUES ('workspace-1', 'Family', 'missing', ?, ?)").run(now, now)).toThrow();
    const insertPerson = database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, 'workspace-1', ?, ?, ?, ?)");
    insertPerson.run("a", "A", "male", now, now);
    insertPerson.run("b", "B", "female", now, now);
    insertPerson.run("child", "Child", "unknown", now, now);
    expect(() => database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, birth_calendar, created_at, updated_at) VALUES ('partial', 'workspace-1', 'Partial', 'unknown', 'solar', ?, ?)").run(now, now)).toThrow();
    expect(() => database.prepare("INSERT INTO parent_child (id, workspace_id, parent_id, child_id, parent_role, relationship_type, created_at, updated_at) VALUES ('self', 'workspace-1', 'a', 'a', 'father', 'biological', ?, ?)").run(now, now)).toThrow();
    database.prepare("INSERT INTO parent_child (id, workspace_id, parent_id, child_id, parent_role, relationship_type, created_at, updated_at) VALUES ('father-1', 'workspace-1', 'a', 'child', 'father', 'biological', ?, ?)").run(now, now);
    expect(() => database.prepare("INSERT INTO parent_child (id, workspace_id, parent_id, child_id, parent_role, relationship_type, created_at, updated_at) VALUES ('father-2', 'workspace-1', 'b', 'child', 'father', 'biological', ?, ?)").run(now, now)).toThrow();
    expect(() => database.prepare("INSERT INTO marriage (id, workspace_id, spouse_a_id, spouse_b_id, created_at, updated_at) VALUES ('unordered', 'workspace-1', 'b', 'a', ?, ?)").run(now, now)).toThrow();

    database.close();
  });

  it.each([
    ["a renamed ledger row", "UPDATE schema_migrations SET name = 'forged' WHERE version = 2"],
    ["a gap in the ledger", "DELETE FROM schema_migrations WHERE version = 2"],
    ["an unknown future ledger row", "INSERT INTO schema_migrations (version, name, applied_at) VALUES (7, 'future', '2026-09-16T00:00:00.000Z')"],
    ["a missing required index", "DROP INDEX operation_group_history_idx"]
  ])("rejects %s instead of trusting user_version", async (_case, mutation) => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-database-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));
    try {
      applyMigrations(database);
      database.exec(mutation);
      expect(() => applyMigrations(database)).toThrow(/migration|schema/i);
    } finally {
      database.close();
    }
  });

  it.each([
    ["person.display_name", "ALTER TABLE person DROP COLUMN display_name"],
    ["person.notes", "ALTER TABLE person DROP COLUMN notes"],
    ["a relied-upon relationship index", "DROP INDEX parent_child_active_father_uq"],
    ["the wiki FTS update trigger", "DROP TRIGGER wiki_fts_after_update"]
  ])("rejects a latest-version database missing %s", async (_case, mutation) => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-database-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));
    try {
      applyMigrations(database);
      database.exec(mutation);
      expect(() => validateCurrentSchema(database)).toThrow(/migration|schema/i);
    } finally { database.close(); }
  });

  it("rejects altered required column properties", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-database-"));
    roots.push(root);
    const properties = openDatabase(join(root, "properties.sqlite"));
    try {
      applyMigrations(properties);
      const createPerson = properties.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='person'").pluck().get() as string;
      properties.pragma("foreign_keys = OFF");
      properties.exec(`${createPerson.replace("CREATE TABLE person", "CREATE TABLE person_new").replace("display_name TEXT NOT NULL", "display_name TEXT")}; DROP TABLE person; ALTER TABLE person_new RENAME TO person;`);
      properties.pragma("foreign_keys = ON");
      expect(() => validateCurrentSchema(properties)).toThrow(/migration|schema/i);
    } finally { properties.close(); }
  });

  it("rejects an altered FTS virtual-table definition", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-database-"));
    roots.push(root);
    const fts = openDatabase(join(root, "fts.sqlite"));
    try {
      applyMigrations(fts);
      fts.exec("DROP TABLE wiki_fts; CREATE VIRTUAL TABLE wiki_fts USING fts5(wiki_entry_id, workspace_id, title, body)");
      expect(() => validateCurrentSchema(fts)).toThrow(/migration|schema/i);
    } finally { fts.close(); }
  });

  it.each([
    ["table", "CREATE TABLE unexpected_table (value TEXT)"],
    ["index", "CREATE INDEX unexpected_index ON person(display_name)"],
    ["trigger", "CREATE TRIGGER unexpected_trigger AFTER INSERT ON person BEGIN UPDATE workspace_meta SET name='rewritten'; END"],
    ["view", "CREATE VIEW unexpected_view AS SELECT id FROM person"],
    ["virtual table", "CREATE VIRTUAL TABLE unexpected_fts USING fts5(payload)"]
  ])("rejects an unexpected application-schema %s", async (_case, mutation) => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-database-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));
    try {
      applyMigrations(database);
      database.exec(mutation);
      expect(() => validateCurrentSchema(database)).toThrow(/migration|schema/i);
    } finally { database.close(); }
  });

  it("accepts a genuine contiguous version-1 database and migrates it exactly to the latest version", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-database-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      ${initialSchemaMigration.sql}
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (1, '${initialSchemaMigration.name}', '2026-09-16T00:00:00.000Z');
      PRAGMA user_version = 1;
    `);

    expect(applyMigrations(database)).toBe(6);
    expect(database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1, name: "initial schema" },
      { version: 2, name: "merge history" },
      { version: 3, name: "wiki full-text search" },
      { version: 4, name: "operation group undo state" },
      { version: 5, name: "lineage membership generation marker" },
      { version: 6, name: "person code and children completeness" }
    ]);
    expect(database.prepare("SELECT name FROM pragma_table_info('operation_group') WHERE name = 'undone_at'").pluck().get()).toBe("undone_at");
    expect(database.prepare("SELECT name FROM pragma_table_info('lineage_membership') WHERE name = 'generation_marker'").pluck().get()).toBe("generation_marker");
    database.close();
  });
});
