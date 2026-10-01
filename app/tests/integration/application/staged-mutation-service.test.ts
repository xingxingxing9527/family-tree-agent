import { beforeEach, describe, expect, it } from "vitest";
import { UndoService } from "../../../src/main/application/audit/undo-service";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { MutationValidationError, StagedMutationService } from "../../../src/main/application/mutations/staged-mutation-service";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";

const workspaceId = "workspace-1";
const source = (key: string) => ({ sourceKey: key, title: "测试录入", kind: "form" });
const draft = (displayName: string) => ({ displayName, aliases: [], gender: "unknown" as const, birth: null, death: null, notes: null, sourceDescription: "表单录入" });

describe("StagedMutationService", () => {
  let database: WorkspaceDatabase;
  let service: StagedMutationService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    applyMigrations(database);
    service = new StagedMutationService(database, workspaceId);
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
