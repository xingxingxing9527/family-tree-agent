import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MergePreviewService } from "../../../src/main/application/merge/merge-preview-service";
import { PersonMergeService } from "../../../src/main/application/merge/person-merge-service";
import { UnmergeService } from "../../../src/main/application/merge/unmerge-service";
import type { WorkspaceDatabase } from "../../../src/main/database/open-database";
import { MergeRepository } from "../../../src/main/database/repositories/merge-repository";
import { createMergeFixture, ids, workspaceId } from "./merge-test-support";

describe("safe person unmerge", () => {
  let root: string;
  let database: WorkspaceDatabase;
  let mergeId: string;

  beforeEach(async () => {
    ({ root, database } = await createMergeFixture());
    const preview = new MergePreviewService(database, workspaceId).previewMerge(ids.primary, ids.secondary);
    mergeId = new PersonMergeService(database, workspaceId).mergePeople({
      primaryPersonId: ids.primary,
      secondaryPersonId: ids.secondary,
      scalarChoices: { birth: "secondary", death: "secondary", notes: "secondary" },
      expectedVersions: preview.expectedVersions
    }).id;
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("reports exact blocking entity IDs and restores nothing when any affected row changed", () => {
    database.prepare("UPDATE media_person SET caption = '合并后修改', row_version = row_version + 1 WHERE id = ?").run(ids.mediaPerson);
    database.prepare("UPDATE person SET notes = '合并后修改', row_version = row_version + 1 WHERE id = ?").run(ids.primary);
    const before = database.prepare("SELECT person_id, caption FROM media_person WHERE id = ?").get(ids.mediaPerson);
    const service = new UnmergeService(database, workspaceId);

    expect(service.canUnmerge(mergeId)).toEqual({
      allowed: false,
      blockingEntityIds: [ids.mediaPerson, ids.primary].sort(),
      reasons: expect.arrayContaining([
        expect.objectContaining({ entityId: ids.mediaPerson }),
        expect.objectContaining({ entityId: ids.primary })
      ])
    });
    expect(() => service.unmerge(mergeId)).toThrow(/cannot be reversed/i);
    expect(database.prepare("SELECT person_id, caption FROM media_person WHERE id = ?").get(ids.mediaPerson)).toEqual(before);
    expect(database.prepare("SELECT status FROM merge_record WHERE id = ?").get(mergeId)).toEqual({ status: "active" });
    expect(database.prepare("SELECT COUNT(*) FROM id_redirect WHERE merge_record_id = ?").pluck().get(mergeId)).toBe(1);
  });

  it("restores the complete snapshot, removes the redirect, reverses the record, and audits one transaction", () => {
    const beforeAuditCount = database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get() as number;
    const service = new UnmergeService(database, workspaceId);
    expect(service.canUnmerge(mergeId)).toEqual({ allowed: true, blockingEntityIds: [], reasons: [] });

    const postPrimary = database.prepare("SELECT row_version, updated_at FROM person WHERE id = ?").get(ids.primary) as { row_version: number; updated_at: string };
    const postSecondary = database.prepare("SELECT row_version, updated_at FROM person WHERE id = ?").get(ids.secondary) as { row_version: number; updated_at: string };
    const reversed = service.unmerge(mergeId);

    expect(reversed.status).toBe("reversed");
    expect(database.prepare("SELECT display_name, birth_day, death_year, notes, deleted_at FROM person WHERE id = ?").get(ids.primary)).toEqual({
      display_name: "张明",
      birth_day: null,
      death_year: null,
      notes: "主记录",
      deleted_at: null
    });
    expect(database.prepare("SELECT display_name, notes, deleted_at FROM person WHERE id = ?").get(ids.secondary)).toEqual({
      display_name: "张铭",
      notes: "次记录（有来源）",
      deleted_at: null
    });
    expect(database.prepare("SELECT person_id, generation_marker, declared_generation, deleted_at FROM lineage_membership WHERE id = ?").get(ids.lineageTwoSecondary)).toEqual({
      person_id: ids.secondary,
      generation_marker: "继",
      declared_generation: 4,
      deleted_at: null
    });
    expect(database.prepare("SELECT person_id FROM media_person WHERE id = ?").get(ids.mediaPerson)).toEqual({ person_id: ids.secondary });
    const restoredPrimary = database.prepare("SELECT row_version, updated_at FROM person WHERE id = ?").get(ids.primary) as { row_version: number; updated_at: string };
    const restoredSecondary = database.prepare("SELECT row_version, updated_at FROM person WHERE id = ?").get(ids.secondary) as { row_version: number; updated_at: string };
    expect(restoredPrimary.row_version).toBeGreaterThan(postPrimary.row_version);
    expect(restoredSecondary.row_version).toBeGreaterThan(postSecondary.row_version);
    expect(restoredPrimary.updated_at).not.toBe(postPrimary.updated_at);
    expect(restoredSecondary.updated_at).not.toBe(postSecondary.updated_at);
    expect(database.prepare("SELECT COUNT(*) FROM id_redirect WHERE merge_record_id = ?").pluck().get(mergeId)).toBe(0);
    expect(new PersonMergeService(database, workspaceId).resolveRedirect(ids.secondary)).toBe(ids.secondary);

    const record = new MergeRepository(database, workspaceId).get(mergeId)!;
    expect(record.status).toBe("reversed");
    expect(record.reversedOperationGroupId).toBe(reversed.reversedOperationGroupId);
    const unmergeAudits = database.prepare("SELECT entity_type, entity_id, action FROM audit_log WHERE operation_group_id = ?").all(reversed.reversedOperationGroupId) as Array<{ entity_type: string; entity_id: string; action: string }>;
    expect(unmergeAudits.length).toBeGreaterThan(3);
    expect(unmergeAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_type: "person", entity_id: ids.secondary, action: "unmerge-restore" }),
      expect.objectContaining({ entity_type: "id_redirect", action: "unmerge-delete" }),
      expect.objectContaining({ entity_type: "merge_record", entity_id: mergeId, action: "unmerge" })
    ]));
    expect(database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()).toBe(beforeAuditCount + unmergeAudits.length);
    expect(() => service.unmerge(mergeId)).toThrow(/already reversed/i);
  });
});
