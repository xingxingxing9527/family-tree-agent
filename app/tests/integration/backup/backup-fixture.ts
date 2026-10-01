import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BackupWorkspace } from "../../../src/main/application/backup/backup-service";
import type { RestoreTarget } from "../../../src/main/application/backup/restore-service";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { WikiService } from "../../../src/main/application/wiki/wiki-service";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";
import { createUnitOfWork } from "../../../src/main/database/unit-of-work";

export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const workspaceDirectory = "22222222-2222-4222-8222-222222222222";
export const originPersonId = "33333333-3333-4333-8333-333333333333";
export const mediaBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);

export interface BackupFixture {
  root: string;
  workspace: BackupWorkspace;
  target: RestoreTarget;
  archivePath: string;
}

export async function createBackupFixture(roots: string[]): Promise<BackupFixture> {
  const root = await mkdtemp(join(tmpdir(), "family-agent-backup-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspaces", workspaceDirectory);
  const mediaRoot = join(workspaceRoot, "media");
  const backupsRoot = join(workspaceRoot, "backups");
  const databasePath = join(workspaceRoot, "genealogy.sqlite");
  const manifestPath = join(workspaceRoot, "workspace.json");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(backupsRoot);
  await mkdir(join(root, "archives"));
  const workspaceManifest = { id: workspaceId, name: "王氏家谱", directory: workspaceDirectory, originPersonId, lastOpenedAt: "2026-09-16T00:00:00.000Z", schemaVersion: 8 };
  await writeFile(manifestPath, JSON.stringify(workspaceManifest));
  await writeFile(join(root, "workspaces", "index.json"), JSON.stringify({ workspaces: [workspaceManifest] }));
  const database = openDatabase(databasePath);
  applyMigrations(database);
  const now = new Date().toISOString();
  database.prepare("INSERT INTO workspace_meta (workspace_id, name, origin_person_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)").run(workspaceId, workspaceManifest.name, now, now);
  const facts = new FactCommandService(database, workspaceId);
  facts.execute({
    type: "person.create",
    draft: { id: originPersonId, workspaceId, displayName: "王小明", gender: "male", birth: { calendar: "lunar", year: 1980, month: 4, day: 2, leapMonth: true, precision: "day" } },
    source: { sourceKey: "seed", title: "seed", kind: "test" }
  });
  createUnitOfWork(database, workspaceId).run("fixture.lineage", (ctx) => {
    ctx.lineages.create(ctx, { id: "backup-lineage", name: "长房", founderPersonId: originPersonId });
    const founderMembership = ctx.lineages.listMemberships("backup-lineage")[0]!;
    ctx.lineages.updateMembership(ctx, founderMembership.id, { declaredGeneration: 1, generationMarker: "承", isPrimary: true });
  });
  new WikiService(database, workspaceId).create({ title: "家训", body: "正文", personIds: [originPersonId], sourceIds: [] });
  const hash = createHash("sha256").update(mediaBytes).digest("hex");
  const relativePath = `media/${hash.slice(0, 2)}/${hash}.jpg`;
  await mkdir(dirname(join(workspaceRoot, relativePath)), { recursive: true });
  await writeFile(join(workspaceRoot, relativePath), mediaBytes);
  database.prepare("INSERT INTO media_asset (id, workspace_id, sha256, original_name, mime_type, byte_size, relative_path, created_at, updated_at) VALUES ('media-one', ?, ?, 'portrait.jpg', 'image/jpeg', ?, ?, ?, ?)")
    .run(workspaceId, hash, mediaBytes.length, relativePath.replaceAll("/", "\\"), now, now);
  database.close();
  const workspace: BackupWorkspace = { workspaceId, workspaceName: workspaceManifest.name, workspaceRoot, databasePath, mediaRoot, manifestPath, backupsRoot, originPersonId } as BackupWorkspace;
  return {
    root,
    workspace,
    target: { workspaceId, workspaceName: workspaceManifest.name, directory: workspaceDirectory, rootPath: workspaceRoot, databasePath, mediaPath: mediaRoot, manifestPath, backupsPath: backupsRoot, originPersonId } as RestoreTarget,
    archivePath: join(root, "archives", "family-backup.zip")
  };
}
