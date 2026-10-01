import { describe, expect, it } from "vitest";
import { FactCommandError, FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { CompletenessRepository } from "../../../src/main/database/repositories/completeness-repository";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";
import { UndoService } from "../../../src/main/application/audit/undo-service";

const workspaceId = "workspace-1";
const source = { sourceKey: "completeness-test", title: "管理员确认", kind: "form" };

describe("children completeness facts", () => {
  it("distinguishes partial zero from administrator-confirmed zero", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({ type: "person.create", draft: { id: "parent", workspaceId, displayName: "家长", gender: "unknown" }, source: { ...source, sourceKey: "parent" } });
    const completeness = new CompletenessRepository(database, workspaceId);

    expect(completeness.getChildrenCountStatus("parent")).toEqual({ count: 0, completeness: "partial" });
    const result = facts.execute({
      type: "person.childrenCompleteness.set",
      personId: "parent",
      complete: true,
      expectedVersion: 1,
      source
    });
    expect(result.changedEntityIds).toEqual(["parent"]);
    expect(completeness.getChildrenCountStatus("parent")).toEqual({ count: 0, completeness: "complete" });
    expect(database.prepare("SELECT entity_type, action FROM audit_log WHERE entity_type='person_completeness'").all())
      .toEqual([{ entity_type: "person_completeness", action: "update" }]);

    expect(() => facts.execute({
      type: "person.childrenCompleteness.set",
      personId: "parent",
      complete: false,
      expectedVersion: 1,
      source: { ...source, sourceKey: "stale" }
    })).toThrowError(expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code: "CONFLICT" })]) }));
    database.close();
  });

  it("counts active children without silently claiming completeness", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({ type: "person.create", draft: { id: "parent", workspaceId, displayName: "家长", gender: "unknown" }, source: { ...source, sourceKey: "parent" } });
    facts.execute({ type: "person.create", draft: { id: "child", workspaceId, displayName: "孩子", gender: "unknown" }, source: { ...source, sourceKey: "child" } });
    facts.execute({ type: "parentChild.add", draft: { workspaceId, parentId: "parent", childId: "child", parentRole: "father" }, source: { ...source, sourceKey: "edge" } });

    expect(new CompletenessRepository(database, workspaceId).getChildrenCountStatus("parent"))
      .toEqual({ count: 1, completeness: "partial" });
    database.close();
  });

  it("rejects completeness changes for missing people", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const facts = new FactCommandService(database, workspaceId);
    expect(() => facts.execute({
      type: "person.childrenCompleteness.set",
      personId: "missing",
      complete: true,
      expectedVersion: 1,
      source
    })).toThrow(FactCommandError);
    database.close();
  });

  it("undoes a completeness confirmation without changing the child facts", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({ type: "person.create", draft: { id: "parent", workspaceId, displayName: "家长", gender: "unknown" }, source: { ...source, sourceKey: "parent" } });
    const confirmed = facts.execute({ type: "person.childrenCompleteness.set", personId: "parent", complete: true, expectedVersion: 1, source });
    new UndoService(database, workspaceId).undoOperationGroup(confirmed.operationGroupId);
    expect(new CompletenessRepository(database, workspaceId).getChildrenCountStatus("parent"))
      .toEqual({ count: 0, completeness: "partial" });
    database.close();
  });
});
