import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";
import { SqliteUnitOfWork } from "../../../src/main/database/unit-of-work";

export const workspaceId = "workspace-merge-test";
export const ids = {
  primary: "11111111-1111-4111-8111-111111111111",
  secondary: "22222222-2222-4222-8222-222222222222",
  father: "33333333-3333-4333-8333-333333333333",
  child: "44444444-4444-4444-8444-444444444444",
  spouse: "55555555-5555-4555-8555-555555555555",
  founder: "66666666-6666-4666-8666-666666666666",
  alias: "alias-secondary",
  parent: "parent-secondary",
  childRelation: "child-secondary",
  marriage: "marriage-secondary",
  lineageOne: "lineage-one",
  lineageTwo: "lineage-two",
  lineageOneSecondary: "lineage-one-secondary",
  lineageTwoSecondary: "lineage-two-secondary",
  lineageTwoPrimary: "lineage-two-primary",
  mediaAsset: "media-asset",
  mediaPerson: "media-person-secondary",
  wikiEntry: "wiki-entry",
  wikiPerson: "wiki-person-secondary",
  source: "source-secondary",
  importIdentity: "import-identity-secondary"
} as const;

export interface MergeFixture {
  root: string;
  database: WorkspaceDatabase;
}

const now = "2026-09-16T00:00:00.000Z";

export async function createMergeFixture(): Promise<MergeFixture> {
  const root = await mkdtemp(join(tmpdir(), "family-agent-merge-"));
  const database = openDatabase(join(root, "genealogy.sqlite"));
  applyMigrations(database);
  const unit = new SqliteUnitOfWork(database, workspaceId);

  unit.run("fixture.people", (ctx) => {
    ctx.people.create(ctx, {
      id: ids.primary,
      displayName: "张明",
      gender: "male",
      birth: { calendar: "solar", year: 1980, month: 3, day: null, leapMonth: false, precision: "month" },
      notes: "主记录"
    });
    ctx.people.create(ctx, {
      id: ids.secondary,
      displayName: "张铭",
      gender: "unknown",
      birth: { calendar: "solar", year: 1980, month: 3, day: 12, leapMonth: false, precision: "day" },
      death: { calendar: "solar", year: 2025, month: 2, day: null, leapMonth: false, precision: "month" },
      notes: "次记录"
    });
    for (const [id, displayName, gender] of [
      [ids.father, "父亲", "male"],
      [ids.child, "孩子", "female"],
      [ids.spouse, "配偶", "female"],
      [ids.founder, "始祖", "male"]
    ] as const) ctx.people.create(ctx, { id, displayName, gender });
    ctx.people.addAlias(ctx, { id: ids.alias, personId: ids.secondary, name: "阿铭" });
    ctx.relations.createParentChild(ctx, { id: ids.parent, parentId: ids.father, childId: ids.secondary, parentRole: "father" });
    ctx.relations.createParentChild(ctx, { id: ids.childRelation, parentId: ids.secondary, childId: ids.child, parentRole: "father" });
    ctx.relations.createMarriage(ctx, { id: ids.marriage, spouseAId: ids.secondary, spouseBId: ids.spouse });
    ctx.lineages.create(ctx, { id: ids.lineageOne, name: "一支", founderPersonId: ids.secondary });
    ctx.lineages.create(ctx, { id: ids.lineageTwo, name: "二支", founderPersonId: ids.founder });
    ctx.lineages.addMembership(ctx, { id: ids.lineageTwoPrimary, lineageId: ids.lineageTwo, personId: ids.primary, lineageRole: "associated" });
    ctx.lineages.addMembership(ctx, { id: ids.lineageTwoSecondary, lineageId: ids.lineageTwo, personId: ids.secondary, lineageRole: "blood" });
  });

  database.prepare("UPDATE lineage_membership SET id = ? WHERE workspace_id = ? AND lineage_id = ? AND person_id = ?")
    .run(ids.lineageOneSecondary, workspaceId, ids.lineageOne, ids.secondary);

  unit.run("fixture.source", (ctx) => {
    ctx.sources.create(ctx, { id: ids.source, sourceKey: "archive:secondary", title: "次记录来源", kind: "archive" });
    ctx.people.update(ctx, ids.secondary, { notes: "次记录（有来源）" });
  });

  database.prepare(`INSERT INTO media_asset
    (id, workspace_id, sha256, original_name, mime_type, byte_size, relative_path, created_at, updated_at)
    VALUES (?, ?, 'abc123', 'portrait.jpg', 'image/jpeg', 123, 'media/portrait.jpg', ?, ?)`)
    .run(ids.mediaAsset, workspaceId, now, now);
  database.prepare(`INSERT INTO media_person
    (id, workspace_id, media_asset_id, person_id, caption, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, '肖像', 0, ?, ?)`)
    .run(ids.mediaPerson, workspaceId, ids.mediaAsset, ids.secondary, now, now);
  database.prepare(`INSERT INTO wiki_entry
    (id, workspace_id, slug, title, content, created_at, updated_at)
    VALUES (?, ?, 'zhang-ming', '人物小传', '内容', ?, ?)`)
    .run(ids.wikiEntry, workspaceId, now, now);
  database.prepare(`INSERT INTO wiki_person
    (id, workspace_id, wiki_entry_id, person_id, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)`)
    .run(ids.wikiPerson, workspaceId, ids.wikiEntry, ids.secondary, now, now);
  database.prepare(`INSERT INTO import_identity
    (id, workspace_id, source_id, source_key, external_person_id, person_id, raw_json, created_at, updated_at)
    VALUES (?, ?, ?, 'archive:secondary', 'P-002', ?, '{}', ?, ?)`)
    .run(ids.importIdentity, workspaceId, ids.source, ids.secondary, now, now);
  database.prepare(`INSERT INTO workspace_meta
    (workspace_id, name, origin_person_id, created_at, updated_at)
    VALUES (?, '合并测试', ?, ?, ?)`)
    .run(workspaceId, ids.secondary, now, now);

  return { root, database };
}

export function rowVersions(database: WorkspaceDatabase, entityIds: readonly string[]): Record<string, number> {
  const tables = [
    "person", "person_alias", "lineage", "lineage_membership", "parent_child", "marriage",
    "import_identity", "media_person", "wiki_person", "workspace_meta"
  ];
  const result: Record<string, number> = {};
  for (const table of tables) {
    for (const row of database.prepare(`SELECT id, row_version FROM ${table} WHERE workspace_id = ?`).all(workspaceId) as Array<{ id: string; row_version: number }>) {
      if (entityIds.includes(row.id)) result[row.id] = row.row_version;
    }
  }
  const workspace = database.prepare("SELECT workspace_id AS id, row_version FROM workspace_meta WHERE workspace_id = ?").get(workspaceId) as { id: string; row_version: number };
  if (entityIds.includes(workspace.id)) result[workspace.id] = workspace.row_version;
  return result;
}
