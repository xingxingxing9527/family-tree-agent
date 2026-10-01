import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UndoService } from "../../../src/main/application/audit/undo-service";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { FactQueries } from "../../../src/main/application/facts/fact-queries";
import { MutationValidationError, StagedMutationService } from "../../../src/main/application/mutations/staged-mutation-service";
import { ParentCompletionService } from "../../../src/main/application/relations/parent-completion-service";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";
import { RPC_INPUT_SCHEMAS } from "../../../src/shared/api-schemas";
import type { PartialDate } from "../../../src/shared/domain";

const workspaceId = "workspace-1";
const source = (key: string) => ({ sourceKey: key, title: "测试录入", kind: "form" });
const draft = (displayName: string) => ({ displayName, aliases: [], gender: "unknown" as const, birth: null, death: null, notes: null, sourceDescription: "表单录入" });
const solar = (year: number, month = 1, day: number | null = null): PartialDate => ({
  calendar: "solar",
  year,
  month,
  day,
  leapMonth: false,
  precision: day === null ? "month" : "day"
});

describe("StagedMutationService", () => {
  let database: WorkspaceDatabase;
  let service: StagedMutationService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    applyMigrations(database);
    service = new StagedMutationService(database, workspaceId);
  });

  const createPerson = (id: string, displayName: string, gender: "male" | "female" | "unknown" = "unknown") => {
    new FactCommandService(database, workspaceId).execute({
      type: "person.create",
      draft: { id, workspaceId, displayName, gender },
      source: source(`person:${id}`)
    });
  };
  const createMarriage = (id = "marriage") => new FactCommandService(database, workspaceId).execute({
    type: "marriage.add",
    draft: { id, workspaceId, spouseAId: "known", spouseBId: "spouse" },
    source: source(`marriage:${id}`)
  });
  const createParent = (id: string, parentId: string, parentRole: "father" | "mother") => new FactCommandService(database, workspaceId).execute({
    type: "parentChild.add",
    draft: { id, workspaceId, parentId, childId: "child", parentRole },
    source: source(`parent:${id}`)
  });
  const seedFamily = () => {
    createPerson("known", "明确父亲", "male");
    createPerson("spouse", "建议母亲", "female");
    createPerson("child", "孩子");
    createMarriage();
  };
  const parentFamilyIntent = () => ({
    type: "parentFamily.add" as const,
    knownParentId: "known",
    childId: "child",
    parentRole: "father" as const,
    completionPolicy: "spouse-default" as const,
    sourceDescription: "出生证明"
  });

  it("expands one parent family intent into default-selected explicit and spouse-default changes", () => {
    seedFamily();

    const preview = service.stage({ intents: [parentFamilyIntent()] });

    expect(preview.changes).toMatchObject([
      {
        disposition: "create",
        originKind: "explicit",
        selectedByDefault: true,
        dependsOnChangeIds: [],
        summary: expect.stringContaining("明确父亲")
      },
      {
        disposition: "create",
        originKind: "spouse_default",
        selectedByDefault: true,
        dependsOnChangeIds: [preview.changes[0]!.id],
        summary: expect.stringMatching(/建议母亲.*唯一/u)
      }
    ]);

    const receipt = service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: preview.changes.map(({ id }) => id),
      acknowledgedWarningCodes: []
    });
    expect(receipt.changedEntityIds).toHaveLength(2);
    expect(database.prepare("SELECT parent_id, parent_role, origin_kind, inferred_from_marriage_id FROM parent_child ORDER BY parent_role").all()).toEqual([
      { parent_id: "known", parent_role: "father", origin_kind: "explicit", inferred_from_marriage_id: null },
      { parent_id: "spouse", parent_role: "mother", origin_kind: "spouse_default", inferred_from_marriage_id: "marriage" }
    ]);
  });

  it("lets the administrator cancel the inferred change and save only the explicit parent", () => {
    seedFamily();
    const preview = service.stage({ intents: [parentFamilyIntent()] });

    service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: [preview.changes[0]!.id],
      acknowledgedWarningCodes: []
    });

    expect(database.prepare("SELECT parent_id, origin_kind FROM parent_child").all()).toEqual([
      { parent_id: "known", origin_kind: "explicit" }
    ]);
  });

  it("rejects an inferred selection without its new explicit dependency before opening a write transaction", () => {
    seedFamily();
    const preview = service.stage({ intents: [parentFamilyIntent()] });

    expect(() => service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: [preview.changes[1]!.id],
      acknowledgedWarningCodes: []
    })).toThrowError(expect.objectContaining({ code: "VALIDATION" } satisfies Partial<MutationValidationError>));
    expect(database.prepare("SELECT COUNT(*) FROM parent_child").pluck().get()).toBe(0);
    expect(database.prepare("SELECT COUNT(*) FROM operation_group WHERE kind='mutation.confirm'").pluck().get()).toBe(0);
  });

  it("keeps inferred completion actionable when the matching explicit relation already exists", () => {
    seedFamily();
    createParent("existing-explicit", "known", "father");

    const preview = service.stage({ intents: [parentFamilyIntent()] });

    expect(preview.changes).toMatchObject([
      { disposition: "unchanged", originKind: "explicit", selectedByDefault: false },
      { disposition: "create", originKind: "spouse_default", selectedByDefault: true, dependsOnChangeIds: [] }
    ]);
    expect(preview.canConfirm).toBe(true);
    service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: [preview.changes[1]!.id],
      acknowledgedWarningCodes: []
    });
    expect(database.prepare("SELECT parent_id, origin_kind FROM parent_child ORDER BY parent_role").all()).toEqual([
      { parent_id: "known", origin_kind: "explicit" },
      { parent_id: "spouse", origin_kind: "spouse_default" }
    ]);
  });

  it("keeps an explicit relation committable when the inferred role conflicts", () => {
    seedFamily();
    createPerson("occupied", "现有母亲", "female");
    createParent("occupied-mother", "occupied", "mother");

    const preview = service.stage({ intents: [parentFamilyIntent()] });

    expect(preview.changes).toMatchObject([
      { originKind: "explicit", disposition: "create" },
      { originKind: "spouse_default", disposition: "blocked", selectedByDefault: false }
    ]);
    expect(preview.issues).toContainEqual(expect.objectContaining({
      changeId: preview.changes[1]!.id,
      severity: "error",
      code: "PARENT_ROLE_OCCUPIED",
      message: expect.stringMatching(/孩子.*现有母亲.*建议母亲/u)
    }));
    expect(preview.canConfirm).toBe(true);

    service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: [preview.changes[0]!.id],
      acknowledgedWarningCodes: []
    });
    expect(database.prepare("SELECT COUNT(*) FROM parent_child WHERE parent_id='known' AND child_id='child'").pluck().get()).toBe(1);
  });

  it("shows no-candidate completion as non-acknowledged info while keeping the explicit relation committable", () => {
    createPerson("known", "明确父亲", "male");
    createPerson("child", "孩子");

    const preview = service.stage({ intents: [parentFamilyIntent()] });

    expect(preview.changes).toMatchObject([
      { originKind: "explicit", disposition: "create", selectedByDefault: true },
      { originKind: "spouse_default", disposition: "blocked", selectedByDefault: false }
    ]);
    expect(preview.issues).toContainEqual(expect.objectContaining({
      changeId: preview.changes[1]!.id,
      severity: "info",
      code: "PARENT_COMPLETION_NO_CANDIDATE"
    }));
    expect(preview.canConfirm).toBe(true);
  });

  it.each(["marriage", "child-birth", "parent-edge"] as const)("rejects stale %s evidence atomically", (kind) => {
    seedFamily();
    const facts = new FactCommandService(database, workspaceId);
    const preview = service.stage({ intents: [parentFamilyIntent()] });
    if (kind === "marriage") {
      facts.execute({ type: "marriage.divorce", marriageId: "marriage", endDate: solar(2025), expectedVersion: 1, source: source("external-marriage") });
    } else if (kind === "child-birth") {
      facts.execute({ type: "person.update", personId: "child", expectedVersion: 1, patch: { birth: solar(2020) }, source: source("external-birth") });
    } else {
      createParent("external-mother", "spouse", "mother");
    }

    expect(() => service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: preview.changes.filter(({ disposition }) => disposition === "create").map(({ id }) => id),
      acknowledgedWarningCodes: []
    })).toThrowError(expect.objectContaining({
      code: "CONFLICT",
      details: { code: "PARENT_COMPLETION_STALE" }
    } satisfies Partial<MutationValidationError>));
    expect(database.prepare("SELECT COUNT(*) FROM parent_child WHERE parent_id='known' AND child_id='child'").pluck().get()).toBe(0);
    expect(database.prepare("SELECT COUNT(*) FROM operation_group WHERE kind='mutation.confirm'").pluck().get()).toBe(0);
  });

  it.each(["marriage", "parent-edge"] as const)("rejects an entirely selected repair batch when one relevant %s changes", (kind) => {
    seedFamily();
    createParent("known-parent", "known", "father");
    createPerson("known-2", "第二位明确父亲", "male");
    createPerson("spouse-2", "第二位建议母亲", "female");
    createPerson("child-2", "第二个孩子");
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({
      type: "marriage.add",
      draft: { id: "marriage-2", workspaceId, spouseAId: "known-2", spouseBId: "spouse-2" },
      source: source("marriage:2")
    });
    facts.execute({
      type: "parentChild.add",
      draft: { id: "known-parent-2", workspaceId, parentId: "known-2", childId: "child-2", parentRole: "father" },
      source: source("parent:2")
    });
    const intents = [
      parentFamilyIntent(),
      {
        type: "parentFamily.add" as const,
        knownParentId: "known-2",
        childId: "child-2",
        parentRole: "father" as const,
        completionPolicy: "spouse-default" as const,
        sourceDescription: "历史未完整父母关系批量修复"
      }
    ];
    const preview = service.stage({ intents });
    expect(preview.changes).toHaveLength(4);
    expect(preview.changes.filter(({ disposition, originKind }) => disposition === "unchanged" && originKind === "explicit"))
      .toHaveLength(2);
    const selectedChangeIds = preview.changes
      .filter(({ disposition, originKind }) => disposition === "create" && originKind === "spouse_default")
      .map(({ id }) => id);
    expect(selectedChangeIds).toHaveLength(2);

    if (kind === "marriage") {
      facts.execute({
        type: "marriage.divorce",
        marriageId: "marriage-2",
        endDate: solar(2025),
        expectedVersion: 1,
        source: source("external-marriage-2")
      });
    } else {
      facts.execute({
        type: "parentChild.add",
        draft: { id: "external-mother-2", workspaceId, parentId: "spouse-2", childId: "child-2", parentRole: "mother" },
        source: source("external-parent-2")
      });
    }
    const confirmGroupsBefore = database.prepare("SELECT COUNT(*) FROM operation_group WHERE kind='mutation.confirm'").pluck().get();
    const activeParentsBefore = database.prepare("SELECT COUNT(*) FROM parent_child WHERE deleted_at IS NULL").pluck().get();

    expect(() => service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds,
      acknowledgedWarningCodes: []
    })).toThrowError(expect.objectContaining({
      code: "CONFLICT",
      details: { code: "PARENT_COMPLETION_STALE" }
    } satisfies Partial<MutationValidationError>));

    expect(database.prepare("SELECT COUNT(*) FROM parent_child WHERE deleted_at IS NULL").pluck().get()).toBe(activeParentsBefore);
    expect(database.prepare("SELECT COUNT(*) FROM parent_child WHERE origin_kind='spouse_default' AND deleted_at IS NULL").pluck().get()).toBe(0);
    expect(database.prepare("SELECT COUNT(*) FROM operation_group WHERE kind='mutation.confirm'").pluck().get()).toBe(confirmGroupsBefore);
    expect(database.prepare("SELECT COUNT(*) FROM source WHERE source_key LIKE ?").pluck().get(`mutation:${preview.id}:%`)).toBe(0);
  });

  it("confirms all selected repair rows in one operation and a fresh scan omits every repaired child", () => {
    seedFamily();
    createParent("known-parent", "known", "father");
    createPerson("known-2", "第二位明确父亲", "male");
    createPerson("spouse-2", "第二位建议母亲", "female");
    createPerson("child-2", "第二个孩子");
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({
      type: "marriage.add",
      draft: { id: "marriage-2", workspaceId, spouseAId: "known-2", spouseBId: "spouse-2" },
      source: source("marriage:2")
    });
    facts.execute({
      type: "parentChild.add",
      draft: { id: "known-parent-2", workspaceId, parentId: "known-2", childId: "child-2", parentRole: "father" },
      source: source("parent:2")
    });

    const beforeScan = new ParentCompletionService(new FactQueries(database, workspaceId)).scan();
    expect(beforeScan.items.map(({ childId }) => childId).sort()).toEqual(["child", "child-2"]);
    const preview = service.stage({ intents: beforeScan.items.map(({ knownParentId, childId, parentRole }) => ({
      type: "parentFamily.add" as const,
      knownParentId,
      childId,
      parentRole,
      completionPolicy: "spouse-default" as const,
      sourceDescription: "历史未完整父母关系批量修复"
    })) });
    const selectedChangeIds = preview.changes
      .filter(({ disposition, originKind }) => disposition === "create" && originKind === "spouse_default")
      .map(({ id }) => id);

    const receipt = service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds,
      acknowledgedWarningCodes: []
    });

    expect(selectedChangeIds).toHaveLength(2);
    expect(database.prepare("SELECT COUNT(*) FROM operation_group WHERE id=? AND kind='mutation.confirm'").pluck().get(receipt.operationGroupId)).toBe(1);
    expect(database.prepare("SELECT COUNT(*) FROM parent_child WHERE origin_kind='spouse_default' AND deleted_at IS NULL").pluck().get()).toBe(2);
    expect(new ParentCompletionService(new FactQueries(database, workspaceId)).scan().items).toEqual([]);
  });

  it("rejects evidence changed by another connection immediately before the confirmation transaction", () => {
    database.close();
    const root = mkdtempSync(join(tmpdir(), "staged-parent-race-"));
    const databasePath = join(root, "family.sqlite");
    database = openDatabase(databasePath);
    applyMigrations(database);
    service = new StagedMutationService(database, workspaceId);
    seedFamily();
    const preview = service.stage({ intents: [parentFamilyIntent()] });
    const externalDatabase = openDatabase(databasePath);
    const externalFacts = new FactCommandService(externalDatabase, workspaceId);
    const originalExec = database.exec.bind(database);
    let injected = false;
    const execSpy = vi.spyOn(database, "exec").mockImplementation((sql: string) => {
      if (!injected && sql === "BEGIN IMMEDIATE") {
        injected = true;
        externalFacts.execute({
          type: "person.update",
          personId: "child",
          expectedVersion: 1,
          patch: { birth: solar(2020) },
          source: source("concurrent-birth")
        });
      }
      return originalExec(sql);
    });

    try {
      expect(() => service.confirm({
        draftId: preview.id,
        draftVersion: preview.version,
        selectedChangeIds: preview.changes.map(({ id }) => id),
        acknowledgedWarningCodes: []
      })).toThrowError(expect.objectContaining({
        code: "CONFLICT",
        details: { code: "PARENT_COMPLETION_STALE" }
      } satisfies Partial<MutationValidationError>));
      expect(injected).toBe(true);
      expect(database.prepare("SELECT COUNT(*) FROM parent_child").pluck().get()).toBe(0);
      expect(database.prepare("SELECT COUNT(*) FROM operation_group WHERE kind='mutation.confirm'").pluck().get()).toBe(0);
      expect(database.prepare("SELECT COUNT(*) FROM audit_log WHERE entity_type='parent_child'").pluck().get()).toBe(0);
      expect(database.prepare("SELECT COUNT(*) FROM source WHERE source_key LIKE ?").pluck().get(`mutation:${preview.id}:%`)).toBe(0);
    } finally {
      execSpy.mockRestore();
      externalDatabase.close();
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears default selection when preview validation blocks an actionable change", () => {
    createPerson("known", "新父亲", "male");
    createPerson("occupied", "现有父亲", "male");
    createPerson("child", "孩子");
    createParent("occupied-father", "occupied", "father");

    const preview = service.stage({ intents: [{
      type: "parentChild.add",
      draft: { parentId: "known", childId: "child", parentRole: "father", sourceDescription: "重复父亲" }
    }] });

    expect(preview.changes).toMatchObject([{
      disposition: "blocked",
      selectedByDefault: false
    }]);
  });

  it("strictly validates parent relation removal intents at the public boundary", () => {
    const schema = RPC_INPUT_SCHEMAS.mutations.stage;
    expect(schema.safeParse({ intents: [{ type: "parentChild.remove", relationId: "relation", expectedVersion: 1 }] }).success).toBe(true);
    for (const input of [
      { intents: [{ type: "parentChild.remove", relationId: "", expectedVersion: 1 }] },
      { intents: [{ type: "parentChild.remove", relationId: "relation", expectedVersion: 0 }] },
      { intents: [{ type: "parentChild.remove", relationId: "relation", expectedVersion: 1.5 }] },
      { intents: [{ type: "parentChild.remove", relationId: "relation", expectedVersion: 1, cascade: true }] },
      { intents: [{ type: "parentChild.remove", relationId: "relation", expectedVersion: 1 }], extra: true }
    ]) expect(schema.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it("previews removal as a relation update with before and after fields", () => {
    seedFamily();
    new FactCommandService(database, workspaceId).execute({
      type: "parentChild.add",
      draft: {
        id: "inferred", workspaceId, parentId: "spouse", childId: "child", parentRole: "mother",
        originKind: "spouse_default", inferredFromMarriageId: "marriage"
      },
      source: source("inferred")
    });

    const preview = service.stage({ intents: [{ type: "parentChild.remove", relationId: "inferred", expectedVersion: 1 }] });

    expect(preview.changes).toEqual([expect.objectContaining({
      disposition: "update",
      entityType: "parentChild",
      entityId: "inferred",
      summary: expect.stringMatching(/移除.*亲子关系/u),
      fieldChanges: [{
        field: "relation",
        before: {
          parentId: "spouse",
          childId: "child",
          parentRole: "mother",
          originKind: "spouse_default",
          inferredFromMarriageId: "marriage"
        },
        after: null
      }]
    })]);
  });

  it("requires the exact parent relation row version when confirming removal", () => {
    seedFamily();
    createParent("stale-parent", "known", "father");
    const preview = service.stage({ intents: [{ type: "parentChild.remove", relationId: "stale-parent", expectedVersion: 1 }] });
    database.prepare("UPDATE parent_child SET row_version = 2 WHERE id = 'stale-parent'").run();

    expect(() => service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: [preview.changes[0]!.id],
      acknowledgedWarningCodes: []
    })).toThrowError(expect.objectContaining({ code: "CONFLICT" } satisfies Partial<MutationValidationError>));
    expect(database.prepare("SELECT deleted_at, row_version FROM parent_child WHERE id='stale-parent'").get())
      .toEqual({ deleted_at: null, row_version: 2 });
    expect(database.prepare("SELECT COUNT(*) FROM operation_group WHERE kind='mutation.confirm'").pluck().get()).toBe(0);
  });

  it("removes an inferred parent without cascading to its marriage or people", () => {
    seedFamily();
    new FactCommandService(database, workspaceId).execute({
      type: "parentChild.add",
      draft: {
        id: "inferred", workspaceId, parentId: "spouse", childId: "child", parentRole: "mother",
        originKind: "spouse_default", inferredFromMarriageId: "marriage"
      },
      source: source("inferred")
    });
    const peopleBefore = database.prepare("SELECT id, row_version, deleted_at FROM person ORDER BY id").all();
    const marriageBefore = database.prepare("SELECT id, row_version, deleted_at FROM marriage").all();
    const preview = service.stage({ intents: [{ type: "parentChild.remove", relationId: "inferred", expectedVersion: 1 }] });

    const receipt = service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: [preview.changes[0]!.id],
      acknowledgedWarningCodes: []
    });

    expect(database.prepare("SELECT deleted_at, row_version FROM parent_child WHERE id='inferred'").get())
      .toEqual({ deleted_at: expect.stringMatching(/T/u), row_version: 2 });
    expect(database.prepare("SELECT id, row_version, deleted_at FROM person ORDER BY id").all()).toEqual(peopleBefore);
    expect(database.prepare("SELECT id, row_version, deleted_at FROM marriage").all()).toEqual(marriageBefore);
    expect(database.prepare("SELECT entity_type, entity_id, action FROM audit_log WHERE operation_group_id=?").all(receipt.operationGroupId))
      .toEqual([{ entity_type: "parent_child", entity_id: "inferred", action: "archive" }]);
  });

  it("supports remove plus parentFamily.add in one atomic correction draft", () => {
    createPerson("old", "错误父亲", "male");
    createPerson("known", "正确父亲", "male");
    createPerson("child", "孩子");
    new FactCommandService(database, workspaceId).execute({
      type: "parentChild.add",
      draft: { id: "old-edge", workspaceId, parentId: "old", childId: "child", parentRole: "father" },
      source: source("old-edge")
    });

    const preview = service.stage({ intents: [
      { type: "parentChild.remove", relationId: "old-edge", expectedVersion: 1 },
      {
        type: "parentFamily.add", knownParentId: "known", childId: "child", parentRole: "father",
        completionPolicy: "spouse-default", skipCompletion: true, sourceDescription: "更正父亲"
      }
    ] });
    expect(preview.changes).toMatchObject([
      { disposition: "update", entityId: "old-edge" },
      { disposition: "create", entityType: "parentChild", originKind: "explicit" }
    ]);

    const receipt = service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: preview.changes.map(({ id }) => id),
      acknowledgedWarningCodes: []
    });
    expect(database.prepare("SELECT parent_id FROM parent_child WHERE child_id='child' AND deleted_at IS NULL").pluck().all()).toEqual(["known"]);
    expect(database.prepare("SELECT COUNT(*) FROM operation_group WHERE id=? AND kind='mutation.confirm'").pluck().get(receipt.operationGroupId)).toBe(1);
  });

  it("accepts more than the legacy one-hundred intent limit up to the bounded batch limit", () => {
    const preview = service.stage({
      intents: Array.from({ length: 101 }, (_, index) => ({ type: "person.create" as const, draft: draft(`人物${index}`) }))
    });
    expect(preview.changes).toHaveLength(101);
  });

  it("commits selected changes in one operation group", () => {
    const preview = service.stage({ intents: [
      { type: "person.create", draft: draft("王建国") },
      { type: "person.create", draft: draft("赵秀兰") }
    ] });
    expect(database.prepare("SELECT COUNT(*) FROM person").pluck().get()).toBe(0);
    expect(preview.changes.map((change) => change.disposition)).toEqual(["create", "create"]);

    const receipt = service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: preview.changes.map((change) => change.id),
      acknowledgedWarningCodes: []
    });

    expect(receipt.operationGroupId).toBeTruthy();
    expect(receipt.changedEntityIds).toHaveLength(2);
    expect(database.prepare("SELECT COUNT(*) FROM person").pluck().get()).toBe(2);
    expect(database.prepare("SELECT COUNT(*) FROM operation_group WHERE kind='mutation.confirm'").pluck().get()).toBe(1);
    database.close();
  });

  it("rolls back every selected change when one expected version is stale", () => {
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({ type: "person.create", draft: { id: "p1", workspaceId, displayName: "甲", gender: "unknown" }, source: source("p1") });
    facts.execute({ type: "person.create", draft: { id: "p2", workspaceId, displayName: "乙", gender: "unknown" }, source: source("p2") });
    const preview = service.stage({ intents: [
      { type: "person.update", personId: "p1", expectedVersion: 1, patch: { displayName: "甲改", sourceDescription: "表单修订" } },
      { type: "person.update", personId: "p2", expectedVersion: 1, patch: { displayName: "乙改", sourceDescription: "表单修订" } }
    ] });
    facts.execute({ type: "person.update", personId: "p2", expectedVersion: 1, patch: { displayName: "外部修改" }, source: source("external") });

    expect(() => service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: preview.changes.map((change) => change.id),
      acknowledgedWarningCodes: []
    })).toThrowError(expect.objectContaining({ code: "CONFLICT" } satisfies Partial<MutationValidationError>));

    expect(database.prepare("SELECT id, display_name FROM person ORDER BY id").all()).toEqual([
      { id: "p1", display_name: "甲" },
      { id: "p2", display_name: "外部修改" }
    ]);
    database.close();
  });

  it("classifies a repeated person update as unchanged and does not allow confirmation", () => {
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({ type: "person.create", draft: { id: "p1", workspaceId, displayName: "甲", gender: "unknown" }, source: source("p1") });

    const preview = service.stage({ intents: [{
      type: "person.update",
      personId: "p1",
      expectedVersion: 1,
      patch: { displayName: "甲", sourceDescription: "重复提交" }
    }] });

    expect(preview.changes).toMatchObject([{ disposition: "unchanged", entityId: "p1" }]);
    expect(preview.canConfirm).toBe(false);
    expect(database.prepare("SELECT row_version FROM person WHERE id='p1'").pluck().get()).toBe(1);
    database.close();
  });

  it("compiles and persists multiple completed marriage events with their status and end", () => {
    createPerson("center", "中心人物");
    createPerson("former", "前配偶");
    createPerson("current-spouse", "现配偶");
    const ended = solar(2018, 6);
    const preview = service.stage({ intents: [
      {
        type: "marriage.add",
        draft: {
          spouseAId: "center",
          spouseBId: "former",
          status: "divorced",
          start: solar(2010, 1),
          end: ended,
          sourceDescription: "旧婚姻记录"
        }
      },
      {
        type: "marriage.add",
        draft: {
          spouseAId: "center",
          spouseBId: "current-spouse",
          status: "active",
          start: solar(2020, 2),
          end: null,
          sourceDescription: "当前婚姻记录"
        }
      }
    ] });

    expect(preview.changes).toMatchObject([{ disposition: "create" }, { disposition: "create" }]);
    service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: preview.changes.map(({ id }) => id),
      acknowledgedWarningCodes: []
    });
    expect(database.prepare("SELECT marriage_status, start_year, end_year FROM marriage ORDER BY start_year").all()).toEqual([
      { marriage_status: "divorced", start_year: 2010, end_year: 2018 },
      { marriage_status: "active", start_year: 2020, end_year: null }
    ]);
  });

  it("blocks a divorced marriage draft without an end and a second new active event for the same person", () => {
    createPerson("center", "中心人物");
    createPerson("spouse-a", "配偶甲");
    createPerson("spouse-b", "配偶乙");
    const missingEnd = service.stage({ intents: [{
      type: "marriage.add",
      draft: {
        spouseAId: "center",
        spouseBId: "spouse-a",
        status: "divorced",
        start: null,
        end: null,
        sourceDescription: "缺少结束日期"
      }
    }] });
    expect(missingEnd.changes).toMatchObject([{ disposition: "blocked" }]);
    expect(missingEnd.issues).toContainEqual(expect.objectContaining({ code: "DIVORCED_MARRIAGE_END_REQUIRED" }));

    const duplicateActive = service.stage({ intents: [
      { type: "marriage.add", draft: { spouseAId: "center", spouseBId: "spouse-a", status: "active", start: null, end: null, sourceDescription: "当前婚姻一" } },
      { type: "marriage.add", draft: { spouseAId: "center", spouseBId: "spouse-b", status: "active", start: null, end: null, sourceDescription: "当前婚姻二" } }
    ] });
    expect(duplicateActive.changes).toMatchObject([
      { disposition: "create" },
      { disposition: "blocked" }
    ]);
    expect(duplicateActive.issues).toContainEqual(expect.objectContaining({ code: "ACTIVE_MARRIAGE_EXISTS" }));
  });

  it("commits lineage side effects in the same undoable operation group", () => {
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({ type: "person.create", draft: { id: "founder", workspaceId, displayName: "始祖", gender: "male" }, source: source("founder") });
    const preview = service.stage({ intents: [{ type: "lineage.create", name: "长房", founderPersonId: "founder", description: null }] });

    const receipt = service.confirm({
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: [preview.changes[0]!.id],
      acknowledgedWarningCodes: []
    });
    expect(database.prepare("SELECT COUNT(*) FROM lineage").pluck().get()).toBe(1);
    expect(database.prepare("SELECT COUNT(*) FROM lineage_membership").pluck().get()).toBe(1);

    new UndoService(database, workspaceId).undoOperationGroup(receipt.operationGroupId);
    expect(database.prepare("SELECT COUNT(*) FROM lineage WHERE deleted_at IS NULL").pluck().get()).toBe(0);
    expect(database.prepare("SELECT COUNT(*) FROM lineage_membership WHERE deleted_at IS NULL").pluck().get()).toBe(0);
    database.close();
  });
});
