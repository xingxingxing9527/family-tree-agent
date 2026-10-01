import { beforeEach, describe, expect, it } from "vitest";
import { UndoService } from "../../../src/main/application/audit/undo-service";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { MutationValidationError, StagedMutationService } from "../../../src/main/application/mutations/staged-mutation-service";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";
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
