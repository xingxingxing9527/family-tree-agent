import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UndoError, UndoService } from "../../../src/main/application/audit/undo-service";
import { DraftService } from "../../../src/main/application/chat/draft-service";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { ImportCommitter } from "../../../src/main/application/import/import-committer";
import { ImportPlanner, ImportPlanStore } from "../../../src/main/application/import/import-planner";
import type { ParsedImport } from "../../../src/main/application/import/import-types";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";
import { RelationRepository } from "../../../src/main/database/repositories/relation-repository";
import { createUnitOfWork } from "../../../src/main/database/unit-of-work";
import type { ConversationMutationDraft } from "../../../src/shared/chat";

const workspaceId = "workspace-undo";
const source = (key: string) => ({ sourceKey: key, title: key, kind: "test" });

describe("conservative operation-group undo", () => {
  let root: string;
  let database: WorkspaceDatabase;
  let facts: FactCommandService;
  let undo: UndoService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agent-undo-"));
    database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
    facts = new FactCommandService(database, workspaceId);
    undo = new UndoService(database, workspaceId);
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("restores an exact manual edit and marks its operation group undone", () => {
    facts.execute({
      type: "person.create",
      draft: { id: "person-manual", workspaceId, displayName: "原名", gender: "unknown", notes: "旧备注" },
      source: source("manual:create")
    });
    const changed = facts.execute({
      type: "person.update",
      personId: "person-manual",
      expectedVersion: 1,
      patch: { displayName: "新名", notes: "新备注" },
      source: source("manual:update")
    });

    const receipt = undo.undoOperationGroup(changed.operationGroupId);

    expect(receipt).toMatchObject({ operationGroupId: changed.operationGroupId, restoredEntities: 2 });
    expect(database.prepare("SELECT display_name, notes, row_version FROM person WHERE id = ?").get("person-manual"))
      .toEqual({ display_name: "原名", notes: "旧备注", row_version: 1 });
    expect(database.prepare("SELECT COUNT(*) FROM source WHERE source_key = ?").pluck().get("manual:update")).toBe(0);
    expect(database.prepare("SELECT undone_at FROM operation_group WHERE id = ?").pluck().get(changed.operationGroupId)).toMatch(/T/);
    expect(undo.listOperationGroups().find((group) => group.id === changed.operationGroupId)).toMatchObject({ status: "undone", undoable: false });
  });

  it("undoes a confirmed conversation draft as one group", () => {
    facts.execute({
      type: "person.create",
      draft: { id: "conversation-person", workspaceId, displayName: "对话人物", gender: "unknown", notes: "之前" },
      source: source("conversation:seed")
    });
    const draft: ConversationMutationDraft = {
      candidatePeople: [{
        referenceId: "person",
        statedFields: ["notes"],
        displayName: "对话人物",
        aliases: [],
        gender: "unknown",
        birth: null,
        death: null,
        notes: "对话修改",
        matchedPersonId: "conversation-person"
      }],
      parentChildFacts: [],
      marriages: [],
      sources: [],
      fieldConfidence: [],
      unresolvedReferences: []
    };
    const service = new DraftService(database, workspaceId);
    const preview = service.stage(draft);
    const confirmed = service.confirm(preview.id, preview.version, preview.changes.map((change) => change.id), { "conversation-person": 1 }, []);

    undo.undoOperationGroup(confirmed.operationGroupId);

    expect(database.prepare("SELECT notes, row_version FROM person WHERE id = ?").get("conversation-person"))
      .toEqual({ notes: "之前", row_version: 1 });
    expect(database.prepare("SELECT source_key FROM source ORDER BY source_key").pluck().all()).toEqual(["conversation:seed"]);
  });

  it("removes a spreadsheet import in reverse dependency order without partial rows", () => {
    const store = new ImportPlanStore();
    const planner = new ImportPlanner(database, workspaceId, store);
    const committer = new ImportCommitter(database, workspaceId, store);
    const parsed: ParsedImport = {
      sourceKey: "archive:undo",
      fileName: "undo.csv",
      rows: [
        { sheet: "People", row: 2, raw: { person_external_id: "P", name: "父", gender: "male", birth_calendar: "", birth_year: "", birth_month: "", birth_day: "", birth_leap_month: "", notes: "" } },
        { sheet: "People", row: 3, raw: { person_external_id: "C", name: "子", gender: "unknown", birth_calendar: "", birth_year: "", birth_month: "", birth_day: "", birth_leap_month: "", notes: "" } },
        { sheet: "ParentChild", row: 2, raw: { parent_external_id: "P", child_external_id: "C", parent_role: "father" } }
      ]
    };
    const plan = planner.plan(parsed);
    const report = committer.commitImport(plan.id, plan.actions.filter((action) => action.kind === "create" || action.kind === "update").map((action) => action.id));
    expect(report.operationGroupId).not.toBeNull();

    undo.undoOperationGroup(report.operationGroupId!);

    for (const table of ["parent_child", "import_identity", "person", "source"] as const) {
      expect(database.prepare(`SELECT COUNT(*) FROM ${table} WHERE workspace_id = ?`).pluck().get(workspaceId), table).toBe(0);
    }
    expect(database.prepare("SELECT COUNT(*) FROM audit_log WHERE operation_group_id = ?").pluck().get(report.operationGroupId)).toBeGreaterThan(0);
  });

  it("restores archived inferred parent provenance without mutating its marriage", () => {
    for (const [id, name] of [["undo-father", "父"], ["undo-mother", "母"], ["undo-child", "子"]] as const) {
      facts.execute({ type: "person.create", draft: { id, workspaceId, displayName: name, gender: "unknown" }, source: source(`undo:${id}`) });
    }
    const marriage = facts.execute({
      type: "marriage.add",
      draft: { id: "undo-marriage", workspaceId, spouseAId: "undo-father", spouseBId: "undo-mother" },
      source: source("undo:marriage")
    });
    facts.execute({
      type: "parentChild.add",
      draft: {
        id: "undo-inferred", workspaceId, parentId: "undo-mother", childId: "undo-child", parentRole: "mother",
        originKind: "spouse_default", inferredFromMarriageId: "undo-marriage"
      },
      source: source("undo:inferred")
    });
    const archived = facts.execute({ type: "fact.softDelete", entityType: "parent_child", entityId: "undo-inferred", expectedVersion: 1 });
    const marriageBeforeUndo = database.prepare("SELECT row_version, deleted_at FROM marriage WHERE id = 'undo-marriage'").get();

    undo.undoOperationGroup(archived.operationGroupId);

    expect(database.prepare("SELECT row_version, deleted_at FROM marriage WHERE id = 'undo-marriage'").get()).toEqual(marriageBeforeUndo);
    expect(new RelationRepository(database, workspaceId).getParentChild("undo-inferred"))
      .toMatchObject({ originKind: "spouse_default", inferredFromMarriageId: "undo-marriage", deletedAt: null });
    expect(marriage.operationGroupId).not.toBe(archived.operationGroupId);
  });

  it("preflights the entire group so a later row-version mismatch changes nothing", () => {
    for (const id of ["bulk-a", "bulk-b"]) {
      facts.execute({ type: "person.create", draft: { id, workspaceId, displayName: id, gender: "unknown" }, source: source(`seed:${id}`) });
    }
    const group = createUnitOfWork(database, workspaceId).run("manual.bulk", (ctx) => {
      ctx.people.update(ctx, "bulk-a", { displayName: "bulk-a-group" });
      ctx.people.update(ctx, "bulk-b", { displayName: "bulk-b-group" });
      return ctx.operationGroupId;
    });
    facts.execute({ type: "person.update", personId: "bulk-b", expectedVersion: 2, patch: { displayName: "bulk-b-later" }, source: source("later") });

    expect(() => undo.undoOperationGroup(group)).toThrowError(expect.objectContaining<Partial<UndoError>>({ code: "CONFLICT" }));

    expect(database.prepare("SELECT id, display_name, row_version FROM person WHERE id IN ('bulk-a','bulk-b') ORDER BY id").all()).toEqual([
      { id: "bulk-a", display_name: "bulk-a-group", row_version: 2 },
      { id: "bulk-b", display_name: "bulk-b-later", row_version: 3 }
    ]);
    expect(database.prepare("SELECT undone_at FROM operation_group WHERE id = ?").pluck().get(group)).toBeNull();
  });

  it("refuses a create when an unexpected dependent row would violate a foreign key", () => {
    const parent = facts.execute({ type: "person.create", draft: { id: "dependent-parent", workspaceId, displayName: "父", gender: "male" }, source: source("parent") });
    facts.execute({ type: "person.create", draft: { id: "dependent-child", workspaceId, displayName: "子", gender: "unknown" }, source: source("child") });
    facts.execute({
      type: "parentChild.add",
      draft: { id: "later-edge", workspaceId, parentId: "dependent-parent", childId: "dependent-child", parentRole: "father" },
      source: source("edge")
    });

    expect(() => undo.undoOperationGroup(parent.operationGroupId)).toThrowError(expect.objectContaining<Partial<UndoError>>({ code: "NOT_UNDOABLE" }));
    expect(database.prepare("SELECT display_name FROM person WHERE id = ?").pluck().get("dependent-parent")).toBe("父");
    expect(database.prepare("SELECT COUNT(*) FROM parent_child WHERE id = 'later-edge'").pluck().get()).toBe(1);
  });

  it("rejects already-undone, merge, and unsupported audit groups", () => {
    const created = facts.execute({ type: "person.create", draft: { id: "single-use", workspaceId, displayName: "一次", gender: "unknown" }, source: source("single") });
    undo.undoOperationGroup(created.operationGroupId);
    expect(() => undo.undoOperationGroup(created.operationGroupId)).toThrowError(expect.objectContaining<Partial<UndoError>>({ code: "ALREADY_UNDONE" }));

    const now = new Date().toISOString();
    database.prepare("INSERT INTO operation_group (id, workspace_id, kind, created_at, updated_at) VALUES (?, ?, 'person.merge', ?, ?)").run("merge-group", workspaceId, now, now);
    database.prepare("INSERT INTO operation_group (id, workspace_id, kind, created_at, updated_at) VALUES (?, ?, 'unsupported', ?, ?)").run("unsupported-group", workspaceId, now, now);
    database.prepare("INSERT INTO audit_log (id, workspace_id, operation_group_id, entity_type, entity_id, action, before_json, after_json, created_at, updated_at) VALUES (?, ?, ?, 'mystery', 'x', 'update', '{}', '{}', ?, ?)")
      .run("unsupported-audit", workspaceId, "unsupported-group", now, now);

    expect(undo.listOperationGroups()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "merge-group", undoable: false, reason: expect.stringMatching(/merge|反合并/i) }),
      expect.objectContaining({ id: "unsupported-group", undoable: false, reason: expect.stringMatching(/unsupported|不支持/i) })
    ]));
    expect(() => undo.undoOperationGroup("merge-group")).toThrowError(expect.objectContaining<Partial<UndoError>>({ code: "NOT_UNDOABLE" }));
  });
});
