import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UndoService } from "../../../src/main/application/audit/undo-service";
import { LineageCommandError, LineageCommandService } from "../../../src/main/application/lineages/lineage-command-service";
import { readWorkspaceSnapshot } from "../../../src/main/application/query/workspace-projection";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";
import { createUnitOfWork } from "../../../src/main/database/unit-of-work";

const workspaceId = "workspace-lineage-commands";

describe("lineage and membership commands", () => {
  let root: string;
  let database: WorkspaceDatabase;
  let service: LineageCommandService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agent-lineage-commands-"));
    database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
    createUnitOfWork(database, workspaceId).run("fixture.people", (ctx) => {
      ctx.people.create(ctx, { id: "founder", displayName: "始祖", gender: "male" });
      ctx.people.create(ctx, { id: "member", displayName: "成员", gender: "unknown" });
      ctx.relations.createParentChild(ctx, { id: "founder-member", parentId: "founder", childId: "member", parentRole: "father" });
    });
    createUnitOfWork(database, "other-workspace").run("fixture.other", (ctx) => {
      ctx.people.create(ctx, { id: "other-person", displayName: "他谱成员", gender: "unknown" });
    });
    service = new LineageCommandService(database, workspaceId);
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("creates the first two lineages and preserves independent multi-membership values while switching primary", () => {
    const first = service.createLineage({ name: "长房", founderPersonId: "founder", description: "东支" }).value;
    const second = service.createLineage({ name: "二房", founderPersonId: "founder", description: null }).value;
    const firstMembership = service.addMembership({
      lineageId: first.id,
      personId: "member",
      lineageRole: "blood",
      isPrimary: true,
      declaredGeneration: 3,
      generationMarker: "承"
    }).value;
    const secondMembership = service.addMembership({
      lineageId: second.id,
      personId: "member",
      lineageRole: "associated",
      isPrimary: false,
      declaredGeneration: 5,
      generationMarker: "世"
    }).value;

    const switched = service.updateMembership({
      membershipId: secondMembership.id,
      expectedVersion: secondMembership.rowVersion,
      patch: { isPrimary: true }
    }).value;

    expect(switched.isPrimary).toBe(true);
    expect(database.prepare("SELECT COUNT(*) FROM lineage_membership WHERE workspace_id=? AND person_id=? AND is_primary=1 AND deleted_at IS NULL").pluck().get(workspaceId, "member")).toBe(1);
    expect(database.prepare("SELECT lineage_id, lineage_role, is_primary, declared_generation, generation_marker FROM lineage_membership WHERE id=?").get(firstMembership.id)).toEqual(
      { lineage_id: first.id, lineage_role: "blood", is_primary: 0, declared_generation: 3, generation_marker: "承" }
    );
    expect(database.prepare("SELECT lineage_id, lineage_role, is_primary, declared_generation, generation_marker FROM lineage_membership WHERE id=?").get(secondMembership.id)).toEqual(
      { lineage_id: second.id, lineage_role: "associated", is_primary: 1, declared_generation: 5, generation_marker: "世" }
    );

    const snapshot = readWorkspaceSnapshot(database, workspaceId);
    const byId = new Map(snapshot.lineages.map((lineage) => [lineage.id, lineage]));
    expect(byId.get(first.id)?.memberships.find((membership) => membership.personId === "member")).toMatchObject({
      role: "blood",
      isPrimary: false,
      declaredGeneration: 3,
      generationMarker: "承",
      generation: { computed: 2, displayed: 3, source: "declared", conflict: true }
    });
    expect(byId.get(second.id)?.memberships.find((membership) => membership.personId === "member")).toMatchObject({
      role: "associated",
      isPrimary: true,
      declaredGeneration: 5,
      generationMarker: "世"
    });
  });

  it("rejects invalid values, stale versions, cross-workspace references and foreign-workspace mutations", () => {
    expect(() => service.createLineage({ name: " ", founderPersonId: "founder", description: null })).toThrowError(expect.objectContaining<Partial<LineageCommandError>>({ code: "VALIDATION" }));
    expect(() => service.createLineage({ name: "越界", founderPersonId: "other-person", description: null })).toThrowError(expect.objectContaining<Partial<LineageCommandError>>({ code: "NOT_FOUND" }));
    const lineage = service.createLineage({ name: "本谱", founderPersonId: "founder", description: null }).value;
    expect(() => service.addMembership({ lineageId: lineage.id, personId: "member", lineageRole: "blood", isPrimary: false, declaredGeneration: 0, generationMarker: "承" })).toThrowError(expect.objectContaining<Partial<LineageCommandError>>({ code: "VALIDATION" }));
    expect(() => service.addMembership({ lineageId: lineage.id, personId: "member", lineageRole: "blood", isPrimary: false, declaredGeneration: 2, generationMarker: " " })).toThrowError(expect.objectContaining<Partial<LineageCommandError>>({ code: "VALIDATION" }));
    expect(() => service.addMembership({ lineageId: lineage.id, personId: "other-person", lineageRole: "associated", isPrimary: false, declaredGeneration: null, generationMarker: null })).toThrowError(expect.objectContaining<Partial<LineageCommandError>>({ code: "NOT_FOUND" }));

    const membership = service.addMembership({ lineageId: lineage.id, personId: "member", lineageRole: "blood", isPrimary: false, declaredGeneration: 2, generationMarker: "承" }).value;
    service.updateMembership({ membershipId: membership.id, expectedVersion: membership.rowVersion, patch: { generationMarker: "启" } });
    expect(() => service.updateMembership({ membershipId: membership.id, expectedVersion: membership.rowVersion, patch: { generationMarker: "昌" } })).toThrowError(expect.objectContaining<Partial<LineageCommandError>>({ code: "CONFLICT" }));
    expect(() => new LineageCommandService(database, "other-workspace").updateMembership({ membershipId: membership.id, expectedVersion: 2, patch: { generationMarker: "越界" } })).toThrowError(expect.objectContaining<Partial<LineageCommandError>>({ code: "NOT_FOUND" }));
  });

  it("audits and atomically undoes a primary switch together with generation-marker edits", () => {
    const first = service.createLineage({ name: "长房", founderPersonId: "founder", description: null }).value;
    const second = service.createLineage({ name: "二房", founderPersonId: "founder", description: null }).value;
    const firstMembership = service.addMembership({ lineageId: first.id, personId: "member", lineageRole: "blood", isPrimary: true, declaredGeneration: 2, generationMarker: "承" }).value;
    const secondMembership = service.addMembership({ lineageId: second.id, personId: "member", lineageRole: "married_in", isPrimary: false, declaredGeneration: 4, generationMarker: "世" }).value;

    const changed = service.updateMembership({
      membershipId: secondMembership.id,
      expectedVersion: secondMembership.rowVersion,
      patch: { isPrimary: true, lineageRole: "associated", declaredGeneration: 5, generationMarker: "永" }
    });
    expect(database.prepare("SELECT COUNT(*) FROM audit_log WHERE operation_group_id=? AND entity_type='lineage_membership'").pluck().get(changed.operationGroupId)).toBe(2);

    new UndoService(database, workspaceId).undoOperationGroup(changed.operationGroupId);

    expect(database.prepare("SELECT is_primary, lineage_role, declared_generation, generation_marker, row_version FROM lineage_membership WHERE id=?").get(firstMembership.id)).toEqual({ is_primary: 1, lineage_role: "blood", declared_generation: 2, generation_marker: "承", row_version: 1 });
    expect(database.prepare("SELECT is_primary, lineage_role, declared_generation, generation_marker, row_version FROM lineage_membership WHERE id=?").get(secondMembership.id)).toEqual({ is_primary: 0, lineage_role: "married_in", declared_generation: 4, generation_marker: "世", row_version: 1 });
  });

  it("keeps the founder as a blood member when changing a lineage founder and undoes both changes atomically", () => {
    const lineage = service.createLineage({ name: "长房", founderPersonId: "founder", description: null }).value;
    const changed = service.updateLineage({ lineageId: lineage.id, expectedVersion: lineage.rowVersion, patch: { founderPersonId: "member" } });

    expect(database.prepare("SELECT founder_person_id FROM lineage WHERE id=?").pluck().get(lineage.id)).toBe("member");
    expect(database.prepare("SELECT lineage_role FROM lineage_membership WHERE lineage_id=? AND person_id=? AND deleted_at IS NULL").pluck().get(lineage.id, "member")).toBe("blood");
    expect(readWorkspaceSnapshot(database, workspaceId).lineages[0]?.memberships.find((membership) => membership.personId === "member")?.generation).toMatchObject({ computed: 1, displayed: 1 });

    new UndoService(database, workspaceId).undoOperationGroup(changed.operationGroupId);
    expect(database.prepare("SELECT founder_person_id FROM lineage WHERE id=?").pluck().get(lineage.id)).toBe("founder");
    expect(database.prepare("SELECT COUNT(*) FROM lineage_membership WHERE lineage_id=? AND person_id=? AND deleted_at IS NULL").pluck().get(lineage.id, "member")).toBe(0);
  });
});
