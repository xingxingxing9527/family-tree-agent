import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuplicateCandidateService } from "../../../src/main/application/merge/duplicate-candidate-service";
import { MergePreviewService } from "../../../src/main/application/merge/merge-preview-service";
import { PersonMergeService } from "../../../src/main/application/merge/person-merge-service";
import { MergeRepository } from "../../../src/main/database/repositories/merge-repository";
import { SqliteUnitOfWork } from "../../../src/main/database/unit-of-work";
import type { WorkspaceDatabase } from "../../../src/main/database/open-database";
import { createMergeFixture, ids, workspaceId } from "./merge-test-support";

describe("person merge", () => {
  let root: string;
  let database: WorkspaceDatabase;

  beforeEach(async () => {
    ({ root, database } = await createMergeFixture());
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("previews every scalar conflict and each migrated reference category", () => {
    const preview = new MergePreviewService(database, workspaceId).previewMerge(ids.primary, ids.secondary);

    expect(preview.primary.id).toBe(ids.primary);
    expect(preview.secondary.id).toBe(ids.secondary);
    expect(preview.scalarConflicts.map((conflict) => conflict.field)).toEqual([
      "displayName", "gender", "birth", "death", "notes"
    ]);
    expect(preview.aliases.map((entry) => entry.id)).toContain(ids.alias);
    expect(preview.parents.map((entry) => entry.id)).toContain(ids.parent);
    expect(preview.children.map((entry) => entry.id)).toContain(ids.childRelation);
    expect(preview.spouses.map((entry) => entry.id)).toContain(ids.marriage);
    expect(preview.lineages.map((entry) => entry.membershipId)).toEqual(expect.arrayContaining([
      ids.lineageOneSecondary,
      ids.lineageTwoSecondary
    ]));
    expect(preview.media.map((entry) => entry.linkId)).toContain(ids.mediaPerson);
    expect(preview.sources.map((entry) => entry.id)).toContain(ids.source);
    expect(preview.wikiLinks.map((entry) => entry.id)).toContain(ids.wikiPerson);
    expect(preview.importIdentities.map((entry) => entry.id)).toContain(ids.importIdentity);
    expect(preview.workspaceOrigins.map((entry) => entry.workspace_id)).toContain(workspaceId);
    expect(preview.expectedVersions).toMatchObject({
      [ids.primary]: 1,
      [ids.secondary]: 2,
      [ids.alias]: 1,
      [ids.parent]: 1,
      [ids.childRelation]: 1,
      [ids.marriage]: 1,
      [ids.lineageOneSecondary]: 1,
      [ids.lineageTwoSecondary]: 1,
      [ids.mediaPerson]: 1,
      [ids.wikiPerson]: 1,
      [ids.importIdentity]: 1,
      [workspaceId]: 1
    });
  });

  it("atomically migrates references, archives the secondary, resolves redirects, and records complete snapshots", () => {
    const preview = new MergePreviewService(database, workspaceId).previewMerge(ids.primary, ids.secondary);
    const merged = new PersonMergeService(database, workspaceId).mergePeople({
      primaryPersonId: ids.primary,
      secondaryPersonId: ids.secondary,
      scalarChoices: { displayName: "primary", gender: "primary", birth: "secondary", death: "secondary", notes: "secondary" },
      expectedVersions: preview.expectedVersions
    });

    expect(merged.status).toBe("active");
    expect(new PersonMergeService(database, workspaceId).resolveRedirect(ids.secondary)).toBe(ids.primary);
    expect(database.prepare("SELECT deleted_at, row_version FROM person WHERE id = ?").get(ids.secondary)).toMatchObject({ row_version: 3 });
    expect((database.prepare("SELECT deleted_at FROM person WHERE id = ?").get(ids.secondary) as { deleted_at: string | null }).deleted_at).not.toBeNull();
    expect(database.prepare("SELECT birth_day, death_year, notes FROM person WHERE id = ?").get(ids.primary)).toEqual({
      birth_day: 12,
      death_year: 2025,
      notes: "次记录（有来源）"
    });

    for (const [table, column] of [
      ["person_alias", "person_id"], ["lineage", "founder_person_id"], ["lineage_membership", "person_id"],
      ["parent_child", "parent_id"], ["parent_child", "child_id"], ["marriage", "spouse_a_id"],
      ["marriage", "spouse_b_id"], ["import_identity", "person_id"], ["media_person", "person_id"],
      ["wiki_person", "person_id"], ["workspace_meta", "origin_person_id"]
    ] as const) {
      expect(database.prepare(`SELECT COUNT(*) FROM ${table} WHERE workspace_id = ? AND ${column} = ?`).pluck().get(workspaceId, ids.secondary), `${table}.${column}`).toBe(0);
    }

    const repository = new MergeRepository(database, workspaceId);
    const record = repository.get(merged.id)!;
    const secondarySnapshot = record.snapshot.rows.person.find((row) => row.id === ids.secondary);
    expect(secondarySnapshot).toMatchObject({
      id: ids.secondary,
      workspace_id: workspaceId,
      display_name: "张铭",
      notes: "次记录（有来源）",
      row_version: 2,
      deleted_at: null
    });
    expect(Object.keys(secondarySnapshot!)).toEqual(expect.arrayContaining([
      "birth_calendar", "birth_year", "birth_month", "birth_day", "birth_leap_month", "birth_precision",
      "death_calendar", "death_year", "death_month", "death_day", "death_leap_month", "death_precision",
      "created_at", "updated_at"
    ]));
    expect(record.postVersions).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "person", entityId: ids.primary, rowVersion: 2 }),
      expect.objectContaining({ entityType: "person", entityId: ids.secondary, rowVersion: 3 }),
      expect.objectContaining({ entityType: "merge_record", entityId: merged.id, rowVersion: 1 }),
      expect.objectContaining({ entityType: "id_redirect", rowVersion: 1 })
    ]));
    const auditedIds = database.prepare("SELECT entity_id FROM audit_log WHERE operation_group_id = ? ORDER BY entity_id").pluck().all(merged.operationGroupId) as string[];
    expect(new Set(auditedIds)).toEqual(new Set(record.postVersions.map((entry) => entry.entityId)));
  });

  it("archives collisions produced by migration instead of leaving duplicate lineage memberships", () => {
    const preview = new MergePreviewService(database, workspaceId).previewMerge(ids.primary, ids.secondary);
    new PersonMergeService(database, workspaceId).mergePeople({
      primaryPersonId: ids.primary,
      secondaryPersonId: ids.secondary,
      scalarChoices: {},
      expectedVersions: preview.expectedVersions
    });

    const active = database.prepare("SELECT id FROM lineage_membership WHERE workspace_id = ? AND lineage_id = ? AND person_id = ? AND deleted_at IS NULL").pluck().all(workspaceId, ids.lineageTwo, ids.primary);
    expect(active).toHaveLength(1);
    expect(database.prepare("SELECT deleted_at FROM lineage_membership WHERE id = ?").get(ids.lineageTwoSecondary)).toMatchObject({ deleted_at: expect.any(String) });
  });

  it("canonicalizes shared parent/spouse facts and conflicting primary memberships before migration", () => {
    const unit = new SqliteUnitOfWork(database, workspaceId);
    unit.run("fixture.shared-facts", (ctx) => {
      ctx.relations.createParentChild(ctx, { id: "parent-primary", parentId: ids.father, childId: ids.primary, parentRole: "father" });
      ctx.relations.createMarriage(ctx, { id: "marriage-primary", spouseAId: ids.primary, spouseBId: ids.spouse });
    });
    database.prepare("UPDATE lineage_membership SET is_primary = 1 WHERE id = ?").run(ids.lineageTwoPrimary);
    database.prepare("UPDATE lineage_membership SET is_primary = 1 WHERE id = ?").run(ids.lineageOneSecondary);
    const preview = new MergePreviewService(database, workspaceId).previewMerge(ids.primary, ids.secondary);

    const merged = new PersonMergeService(database, workspaceId).mergePeople({ primaryPersonId: ids.primary, secondaryPersonId: ids.secondary, scalarChoices: {}, expectedVersions: preview.expectedVersions });

    expect(database.prepare("SELECT deleted_at FROM parent_child WHERE id = ?").get(ids.parent)).toMatchObject({ deleted_at: expect.any(String) });
    expect(database.prepare("SELECT deleted_at FROM marriage WHERE id = ?").get(ids.marriage)).toMatchObject({ deleted_at: expect.any(String) });
    expect(database.prepare("SELECT person_id, is_primary, deleted_at FROM lineage_membership WHERE id = ?").get(ids.lineageOneSecondary)).toEqual({ person_id: ids.primary, is_primary: 0, deleted_at: null });
    expect(database.prepare("SELECT COUNT(*) FROM lineage_membership WHERE workspace_id = ? AND person_id = ? AND is_primary = 1 AND deleted_at IS NULL").pluck().get(workspaceId, ids.primary)).toBe(1);
    const record = new MergeRepository(database, workspaceId).get(merged.id)!;
    expect(record.postVersions.map((entry) => entry.entityId)).toEqual(expect.arrayContaining([ids.parent, ids.marriage, ids.lineageOneSecondary]));
    expect(database.prepare("SELECT COUNT(*) FROM audit_log WHERE operation_group_id = ? AND entity_id IN (?, ?, ?)").pluck().get(merged.operationGroupId, ids.parent, ids.marriage, ids.lineageOneSecondary)).toBe(3);
  });

  it("preserves active-versus-divorced and distinct divorced marriage episodes while merging IDs", () => {
    const unit = new SqliteUnitOfWork(database, workspaceId);
    unit.run("fixture.marriage-history", (ctx) => {
      ctx.relations.createMarriage(ctx, { id: "primary-active", spouseAId: ids.primary, spouseBId: ids.spouse, status: "active" });
      ctx.relations.createMarriage(ctx, { id: "primary-divorced-one", spouseAId: ids.primary, spouseBId: ids.spouse, status: "divorced", start: { calendar: "solar", year: 1990, month: 1, day: null, leapMonth: false, precision: "month" }, end: { calendar: "solar", year: 2000, month: 1, day: null, leapMonth: false, precision: "month" } });
      ctx.relations.createMarriage(ctx, { id: "secondary-divorced-two", spouseAId: ids.secondary, spouseBId: ids.spouse, status: "divorced", start: { calendar: "solar", year: 2001, month: 1, day: null, leapMonth: false, precision: "month" }, end: { calendar: "solar", year: 2010, month: 1, day: null, leapMonth: false, precision: "month" } });
    });
    database.prepare("UPDATE marriage SET marriage_status = 'divorced', start_calendar = 'solar', start_year = 1980, start_month = 1, start_precision = 'month', end_calendar = 'solar', end_year = 1989, end_month = 1, end_precision = 'month' WHERE id = ?").run(ids.marriage);
    const preview = new MergePreviewService(database, workspaceId).previewMerge(ids.primary, ids.secondary);
    new PersonMergeService(database, workspaceId).mergePeople({ primaryPersonId: ids.primary, secondaryPersonId: ids.secondary, scalarChoices: {}, expectedVersions: preview.expectedVersions });
    expect(database.prepare("SELECT COUNT(*) FROM marriage WHERE workspace_id = ? AND deleted_at IS NULL AND spouse_a_id = ? AND spouse_b_id = ?").pluck().get(workspaceId, ids.primary < ids.spouse ? ids.primary : ids.spouse, ids.primary < ids.spouse ? ids.spouse : ids.primary)).toBe(4);
    expect(database.prepare("SELECT COUNT(*) FROM marriage WHERE workspace_id = ? AND deleted_at IS NULL AND marriage_status = 'divorced'").pluck().get(workspaceId)).toBe(3);
  });

  it("rejects stale previews and rolls back every merge write", () => {
    const preview = new MergePreviewService(database, workspaceId).previewMerge(ids.primary, ids.secondary);
    database.prepare("UPDATE media_person SET caption = '已修改', row_version = row_version + 1 WHERE id = ?").run(ids.mediaPerson);

    expect(() => new PersonMergeService(database, workspaceId).mergePeople({
      primaryPersonId: ids.primary,
      secondaryPersonId: ids.secondary,
      scalarChoices: {},
      expectedVersions: preview.expectedVersions
    })).toThrow(/changed since preview/i);
    expect(database.prepare("SELECT COUNT(*) FROM merge_record").pluck().get()).toBe(0);
    expect(database.prepare("SELECT deleted_at FROM person WHERE id = ?").get(ids.secondary)).toEqual({ deleted_at: null });
  });

  it("rejects self-parenting, self-marriage, parent cycles, and a second biological parent", () => {
    const cases: Array<{ setup: () => void; message: RegExp }> = [
      {
        setup: () => database.prepare("UPDATE parent_child SET parent_id = ? WHERE id = ?").run(ids.primary, ids.parent),
        message: /own parent/i
      },
      {
        setup: () => database.prepare("UPDATE marriage SET spouse_a_id = ?, spouse_b_id = ? WHERE id = ?").run(...[ids.primary, ids.secondary].sort(), ids.marriage),
        message: /marry themselves/i
      },
      {
        setup: () => database.prepare(`INSERT INTO parent_child
          (id, workspace_id, parent_id, child_id, parent_role, relationship_type, created_at, updated_at)
          VALUES ('cycle-edge', ?, ?, ?, 'mother', 'biological', '2026-01-01', '2026-01-01')`).run(workspaceId, ids.child, ids.primary),
        message: /cycle/i
      },
      {
        setup: () => database.prepare(`INSERT INTO parent_child
          (id, workspace_id, parent_id, child_id, parent_role, relationship_type, created_at, updated_at)
          VALUES ('second-father', ?, ?, ?, 'father', 'biological', '2026-01-01', '2026-01-01')`).run(workspaceId, ids.spouse, ids.primary),
        message: /biological father/i
      }
    ];

    for (const example of cases) {
      const savepoint = `case_${cases.indexOf(example)}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      example.setup();
      const preview = new MergePreviewService(database, workspaceId).previewMerge(ids.primary, ids.secondary);
      expect(() => new PersonMergeService(database, workspaceId).mergePeople({
        primaryPersonId: ids.primary,
        secondaryPersonId: ids.secondary,
        scalarChoices: {},
        expectedVersions: preview.expectedVersions
      })).toThrow(example.message);
      database.exec(`ROLLBACK TO ${savepoint}`);
      database.exec(`RELEASE ${savepoint}`);
    }
  });

  it("returns only strongly supported duplicate candidates with explainable allowed reasons", () => {
    const unit = new SqliteUnitOfWork(database, workspaceId);
    unit.run("fixture.duplicates", (ctx: import("../../../src/main/database/unit-of-work").TransactionContext) => {
      ctx.people.create(ctx, { id: "same-name-unrelated", displayName: "张明", gender: "male" });
      ctx.people.create(ctx, {
        id: "strong-match",
        displayName: "张铭",
        gender: "male",
        birth: { calendar: "solar", year: 1980, month: 3, day: 2, leapMonth: false, precision: "day" }
      });
      ctx.people.addAlias(ctx, { personId: "strong-match", name: "张明" });
      ctx.relations.createParentChild(ctx, { parentId: ids.father, childId: ids.primary, parentRole: "father" });
      ctx.relations.createParentChild(ctx, { parentId: ids.father, childId: "strong-match", parentRole: "father" });
    });

    const candidates = new DuplicateCandidateService(database, workspaceId).findDuplicateCandidates(ids.primary);

    expect(candidates.map((candidate) => candidate.person.id)).not.toContain("same-name-unrelated");
    const strong = candidates.find((candidate) => candidate.person.id === "strong-match");
    expect(strong?.score).toBeGreaterThanOrEqual(60);
    expect(strong?.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["NAME_OVERLAP", "BIRTH_COMPATIBLE", "SHARED_PARENT"]));
    expect(strong?.reasons.every((reason) => ["NAME_OVERLAP", "BIRTH_COMPATIBLE", "SHARED_PARENT", "SHARED_SPOUSE", "SHARED_CHILD"].includes(reason.code))).toBe(true);
    expect(database.prepare("SELECT COUNT(*) FROM merge_record").pluck().get()).toBe(0);
  });
});
