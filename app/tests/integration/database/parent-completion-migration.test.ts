import { describe, expect, it } from "vitest";
import { FactCommandError, FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { UndoService } from "../../../src/main/application/audit/undo-service";
import { initialSchemaMigration } from "../../../src/main/database/migrations/001-initial-schema";
import { mergeHistoryMigration } from "../../../src/main/database/migrations/002-merge-history";
import { wikiFtsMigration } from "../../../src/main/database/migrations/003-wiki-fts";
import { operationGroupUndoMigration } from "../../../src/main/database/migrations/004-operation-group-undo";
import { lineageGenerationMarkerMigration } from "../../../src/main/database/migrations/005-lineage-generation-marker";
import { personCodeAndCompletenessMigration } from "../../../src/main/database/migrations/006-person-code-and-completeness";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";
import { RelationRepository } from "../../../src/main/database/repositories/relation-repository";
import { createUnitOfWork } from "../../../src/main/database/unit-of-work";

const workspaceId = "workspace-parent-completion";
const source = (key: string) => ({ sourceKey: key, title: key, kind: "test" });

function versionSixDatabaseWithParent() {
  const database = openDatabase(":memory:");
  const migrations = [
    initialSchemaMigration,
    mergeHistoryMigration,
    wikiFtsMigration,
    operationGroupUndoMigration,
    lineageGenerationMarkerMigration,
    personCodeAndCompletenessMigration
  ];
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of migrations) {
    database.exec(migration.sql);
    database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, "2026-10-01T00:00:00.000Z");
  }
  database.pragma("user_version = 6");
  const now = "2026-10-01T00:00:00.000Z";
  const person = database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, ?, ?, 'unknown', ?, ?)");
  person.run("parent", workspaceId, "父母", now, now);
  person.run("child", workspaceId, "孩子", now, now);
  database.prepare("INSERT INTO parent_child (id, workspace_id, parent_id, child_id, parent_role, relationship_type, created_at, updated_at) VALUES ('old-parent', ?, 'parent', 'child', 'father', 'biological', ?, ?)")
    .run(workspaceId, now, now);
  return database;
}

describe("parent completion provenance migration", () => {
  it("backfills old parent-child rows as explicit", () => {
    const database = versionSixDatabaseWithParent();
    try {
      expect(applyMigrations(database)).toBe(8);
      expect(database.prepare("SELECT origin_kind, inferred_from_marriage_id FROM parent_child").get())
        .toEqual({ origin_kind: "explicit", inferred_from_marriage_id: null });
      expect(applyMigrations(database)).toBe(8);
    } finally {
      database.close();
    }
  });

  it("creates the nullable marriage foreign key and its partial lookup index", () => {
    const database = versionSixDatabaseWithParent();
    try {
      applyMigrations(database);
      expect(database.prepare("SELECT [table], [from], [to], on_delete FROM pragma_foreign_key_list('parent_child') WHERE [from] = 'inferred_from_marriage_id'").get())
        .toEqual({ table: "marriage", from: "inferred_from_marriage_id", to: "id", on_delete: "NO ACTION" });
      expect(database.prepare("SELECT name, [unique], partial FROM pragma_index_list('parent_child') WHERE name = 'parent_child_inferred_marriage_idx'").get())
        .toEqual({ name: "parent_child_inferred_marriage_idx", unique: 0, partial: 1 });
      expect(database.prepare("SELECT name FROM pragma_index_info('parent_child_inferred_marriage_idx') ORDER BY seqno").pluck().all())
        .toEqual(["workspace_id", "inferred_from_marriage_id"]);
    } finally {
      database.close();
    }
  });

  it("keeps version-six parent audit snapshots undoable as explicit facts", () => {
    const database = versionSixDatabaseWithParent();
    const before = {
      id: "old-parent", workspaceId, parentId: "parent", childId: "child", parentRole: "father", relationshipType: "biological",
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", deletedAt: null, rowVersion: 1
    };
    const after = { ...before, updatedAt: "2026-10-01T00:01:00.000Z", deletedAt: "2026-10-01T00:01:00.000Z", rowVersion: 2 };
    try {
      database.prepare("UPDATE parent_child SET deleted_at = ?, updated_at = ?, row_version = ? WHERE id = 'old-parent'")
        .run(after.deletedAt, after.updatedAt, after.rowVersion);
      database.prepare("INSERT INTO operation_group (id, workspace_id, kind, created_at, updated_at) VALUES ('old-parent-archive', ?, 'fact.softDelete', ?, ?)")
        .run(workspaceId, after.updatedAt, after.updatedAt);
      database.prepare("INSERT INTO audit_log (id, workspace_id, operation_group_id, entity_type, entity_id, action, before_json, after_json, created_at, updated_at) VALUES ('old-parent-audit', ?, 'old-parent-archive', 'parent_child', 'old-parent', 'archive', ?, ?, ?, ?)")
        .run(workspaceId, JSON.stringify(before), JSON.stringify(after), after.updatedAt, after.updatedAt);
      expect(applyMigrations(database)).toBe(8);
      expect(database.prepare("SELECT COUNT(*) FROM fact_source_link").pluck().get()).toBe(0);

      new UndoService(database, workspaceId).undoOperationGroup("old-parent-archive");

      expect(new RelationRepository(database, workspaceId).getParentChild("old-parent"))
        .toMatchObject({ originKind: "explicit", inferredFromMarriageId: null, deletedAt: null, rowVersion: 1 });
    } finally {
      database.close();
    }
  });

  it("round-trips spouse-default provenance", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const now = "2026-10-01T00:00:00.000Z";
    const person = database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, ?, ?, 'unknown', ?, ?)");
    person.run("mother", workspaceId, "母亲", now, now);
    person.run("father", workspaceId, "父亲", now, now);
    person.run("child", workspaceId, "孩子", now, now);
    try {
      const relation = createUnitOfWork(database, workspaceId).run("parent-completion-test", (ctx) => {
        ctx.relations.createMarriage(ctx, { id: "marriage-1", spouseAId: "father", spouseBId: "mother" });
        return ctx.relations.createParentChild(ctx, {
          parentId: "mother", childId: "child", parentRole: "mother",
          originKind: "spouse_default", inferredFromMarriageId: "marriage-1"
        });
      });
      expect(relation).toMatchObject({ originKind: "spouse_default", inferredFromMarriageId: "marriage-1" });
    } finally {
      database.close();
    }
  });

  it("stores spouse-default provenance without a marriage id when no episode is uniquely attributable", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const facts = new FactCommandService(database, workspaceId);
    try {
      for (const [id, name] of [["parent", "补全父母"], ["child", "孩子"]] as const) {
        facts.execute({ type: "person.create", draft: { id, workspaceId, displayName: name, gender: "unknown" }, source: source(`person:${id}`) });
      }
      facts.execute({
        type: "parentChild.add",
        draft: {
          id: "unattributed-parent",
          workspaceId,
          parentId: "parent",
          childId: "child",
          parentRole: "mother",
          originKind: "spouse_default",
          inferredFromMarriageId: null
        },
        source: source("unattributed-parent")
      });
      expect(new RelationRepository(database, workspaceId).getParentChild("unattributed-parent"))
        .toMatchObject({ originKind: "spouse_default", inferredFromMarriageId: null });
    } finally {
      database.close();
    }
  });

  it("rejects a spouse-default parent when its inferred marriage is not active in this workspace", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const facts = new FactCommandService(database, workspaceId);
    try {
      for (const [id, name] of [["parent", "父母"], ["child", "孩子"]] as const) {
        facts.execute({ type: "person.create", draft: { id, workspaceId, displayName: name, gender: "unknown" }, source: source(`person:${id}`) });
      }
      expect(() => facts.execute({
        type: "parentChild.add",
        draft: {
          id: "unproven-parent", workspaceId, parentId: "parent", childId: "child", parentRole: "father",
          originKind: "spouse_default", inferredFromMarriageId: "missing-marriage"
        },
        source: source("unproven-parent")
      })).toThrowError(expect.objectContaining<Partial<FactCommandError>>({
        issues: expect.arrayContaining([expect.objectContaining({ code: "NOT_FOUND" })])
      }));
    } finally {
      database.close();
    }
  });

  it.each([
    ["another workspace", "foreign", "WORKSPACE_MISMATCH"],
    ["archived", "archived", "NOT_FOUND"]
  ] as const)("rejects a spouse-default parent whose inferred marriage is %s", (_label, kind, issueCode) => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const facts = new FactCommandService(database, workspaceId);
    const otherWorkspaceId = "workspace-other";
    const now = "2026-10-01T00:00:00.000Z";
    try {
      for (const [id, name] of [["parent", "父母"], ["spouse", "配偶"], ["child", "孩子"]] as const) {
        facts.execute({ type: "person.create", draft: { id, workspaceId, displayName: name, gender: "unknown" }, source: source(`person:${id}`) });
      }
      if (kind === "foreign") {
        database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES ('foreign-a', ?, '外部甲', 'unknown', ?, ?), ('foreign-b', ?, '外部乙', 'unknown', ?, ?)")
          .run(otherWorkspaceId, now, now, otherWorkspaceId, now, now);
        database.prepare("INSERT INTO marriage (id, workspace_id, spouse_a_id, spouse_b_id, marriage_status, created_at, updated_at) VALUES ('source-marriage', ?, 'foreign-a', 'foreign-b', 'active', ?, ?)")
          .run(otherWorkspaceId, now, now);
      } else {
        facts.execute({ type: "marriage.add", draft: { id: "source-marriage", workspaceId, spouseAId: "parent", spouseBId: "spouse" }, source: source("marriage") });
        createUnitOfWork(database, workspaceId).run("archive-marriage", (ctx) => ctx.relations.archiveMarriage(ctx, "source-marriage"));
      }

      expect(() => facts.execute({
        type: "parentChild.add",
        draft: {
          id: `rejected-${kind}`,
          workspaceId,
          parentId: "parent",
          childId: "child",
          parentRole: "father",
          originKind: "spouse_default",
          inferredFromMarriageId: "source-marriage"
        },
        source: source(`rejected-${kind}`)
      })).toThrowError(expect.objectContaining<Partial<FactCommandError>>({
        issues: expect.arrayContaining([expect.objectContaining({ code: issueCode })])
      }));
    } finally {
      database.close();
    }
  });

  it("accepts a divorced inferred marriage from the same workspace", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const facts = new FactCommandService(database, workspaceId);
    try {
      for (const [id, name] of [["parent", "父母"], ["spouse", "前配偶"], ["child", "孩子"]] as const) {
        facts.execute({ type: "person.create", draft: { id, workspaceId, displayName: name, gender: "unknown" }, source: source(`person:${id}`) });
      }
      facts.execute({
        type: "marriage.add",
        draft: {
          id: "divorced-marriage",
          workspaceId,
          spouseAId: "parent",
          spouseBId: "spouse",
          status: "divorced",
          end: { calendar: "solar", year: 2001, month: 3, day: null, leapMonth: false, precision: "month" }
        },
        source: source("divorced-marriage")
      });
      facts.execute({
        type: "parentChild.add",
        draft: {
          id: "divorced-provenance",
          workspaceId,
          parentId: "parent",
          childId: "child",
          parentRole: "father",
          originKind: "spouse_default",
          inferredFromMarriageId: "divorced-marriage"
        },
        source: source("divorced-provenance")
      });
      expect(new RelationRepository(database, workspaceId).getParentChild("divorced-provenance"))
        .toMatchObject({ originKind: "spouse_default", inferredFromMarriageId: "divorced-marriage" });
    } finally {
      database.close();
    }
  });

  it("stores explicit facts without an inferred marriage even when a caller supplies one", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const facts = new FactCommandService(database, workspaceId);
    try {
      for (const [id, name] of [["parent", "父母"], ["child", "孩子"]] as const) {
        facts.execute({ type: "person.create", draft: { id, workspaceId, displayName: name, gender: "unknown" }, source: source(`person:${id}`) });
      }
      facts.execute({
        type: "parentChild.add",
        draft: {
          id: "manual-parent", workspaceId, parentId: "parent", childId: "child", parentRole: "father",
          originKind: "explicit", inferredFromMarriageId: "ignored-marriage"
        },
        source: source("manual-parent")
      });
      expect(new RelationRepository(database, workspaceId).getParentChild("manual-parent"))
        .toMatchObject({ originKind: "explicit", inferredFromMarriageId: null });
    } finally {
      database.close();
    }
  });
});
