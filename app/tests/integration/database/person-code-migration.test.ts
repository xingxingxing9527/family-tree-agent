import { describe, expect, it } from "vitest";
import { applyMigrations } from "../../../src/main/database/migrations";
import { initialSchemaMigration } from "../../../src/main/database/migrations/001-initial-schema";
import { mergeHistoryMigration } from "../../../src/main/database/migrations/002-merge-history";
import { wikiFtsMigration } from "../../../src/main/database/migrations/003-wiki-fts";
import { operationGroupUndoMigration } from "../../../src/main/database/migrations/004-operation-group-undo";
import { lineageGenerationMarkerMigration } from "../../../src/main/database/migrations/005-lineage-generation-marker";
import { openDatabase } from "../../../src/main/database/open-database";
import { allocatePersonCode } from "../../../src/main/database/person-code-allocator";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { UndoService } from "../../../src/main/application/audit/undo-service";

const workspaceId = "workspace-1";

function versionFiveDatabase() {
  const database = openDatabase(":memory:");
  const migrations = [initialSchemaMigration, mergeHistoryMigration, wikiFtsMigration, operationGroupUndoMigration, lineageGenerationMarkerMigration];
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const record = database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  for (const migration of migrations) {
    database.exec(migration.sql);
    record.run(migration.version, migration.name, "2026-10-01T00:00:00.000Z");
    database.pragma(`user_version = ${migration.version}`);
  }
  return database;
}

describe("person code migration and allocation", () => {
  it("backfills stable ordered codes when a version-5 family is opened", () => {
    const database = versionFiveDatabase();
    const insert = database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, ?, ?, 'unknown', ?, ?)");
    insert.run("person-z", workspaceId, "最早", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
    insert.run("person-b", workspaceId, "同日乙", "2025-02-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z");
    insert.run("person-a", workspaceId, "同日甲", "2025-02-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z");

    expect(applyMigrations(database)).toBe(6);
    expect(database.prepare("SELECT person_code FROM person WHERE workspace_id=? ORDER BY person_code").pluck().all(workspaceId))
      .toEqual(["P000001", "P000002", "P000003"]);
    expect(database.prepare("SELECT id FROM person WHERE workspace_id=? ORDER BY person_code").pluck().all(workspaceId))
      .toEqual(["person-z", "person-a", "person-b"]);
    database.close();
  });

  it("allocates unique codes atomically and never reuses an archived code", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const allocated = database.transaction(() => Array.from({ length: 4 }, () => allocatePersonCode(database, workspaceId)))();
    expect(allocated).toEqual(["P000001", "P000002", "P000003", "P000004"]);

    const now = "2026-10-01T00:00:00.000Z";
    database.prepare("INSERT INTO person (id, workspace_id, person_code, display_name, gender, created_at, updated_at, deleted_at) VALUES ('archived', ?, 'P000004', '旧人物', 'unknown', ?, ?, ?)")
      .run(workspaceId, now, now, now);
    expect(allocatePersonCode(database, workspaceId)).toBe("P000005");
    expect(() => database.prepare("UPDATE person SET person_code='P999999' WHERE id='archived'").run()).toThrow();
    database.close();
  });

  it("does not reuse a person code after undo removes the person", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const facts = new FactCommandService(database, workspaceId);
    const first = facts.execute({
      type: "person.create",
      draft: { id: "first", workspaceId, displayName: "第一人", gender: "unknown" },
      source: { sourceKey: "first", title: "测试", kind: "form" }
    });
    expect(database.prepare("SELECT person_code FROM person WHERE id='first'").pluck().get()).toBe("P000001");
    new UndoService(database, workspaceId).undoOperationGroup(first.operationGroupId);
    facts.execute({
      type: "person.create",
      draft: { id: "second", workspaceId, displayName: "第二人", gender: "unknown" },
      source: { sourceKey: "second", title: "测试", kind: "form" }
    });
    expect(database.prepare("SELECT person_code FROM person WHERE id='second'").pluck().get()).toBe("P000002");
    database.close();
  });
});
