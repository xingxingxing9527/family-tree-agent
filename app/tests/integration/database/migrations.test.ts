import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../src/main/database/open-database";
import { applyMigrations } from "../../../src/main/database/migrations";

describe("database migrations", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("migrates an empty database to version 4 exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-database-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));

    try {
      expect(applyMigrations(database)).toBe(4);
      expect(applyMigrations(database)).toBe(4);
      expect(database.pragma("user_version", { simple: true })).toBe(4);
      expect(database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get()).toBe(4);
      expect(database.prepare("SELECT name FROM pragma_table_info('operation_group') WHERE name = 'undone_at'").pluck().get()).toBe("undone_at");
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
      "parent_child", "person", "person_alias", "schema_migrations", "source",
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
});
