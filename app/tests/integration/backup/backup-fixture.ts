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

export const workspaceId = "11111111-1111-4111-8111-111111111111";
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
  const workspaceRoot = join(root, "workspaces", "family-one");
  const mediaRoot = join(workspaceRoot, "media");
  const backupsRoot = join(workspaceRoot, "backups");
  const databasePath = join(workspaceRoot, "genealogy.sqlite");
  const manifestPath = join(workspaceRoot, "workspace.json");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(backupsRoot);
  await mkdir(join(root, "archives"));
  const workspaceManifest = { id: workspaceId, name: "王氏家谱", directory: "family-one", originPersonId: null, lastOpenedAt: "2026-09-16T00:00:00.000Z", schemaVersion: 4 };
  await writeFile(manifestPath, JSON.stringify(workspaceManifest));
  const database = openDatabase(databasePath);
  applyMigrations(database);
  const now = new Date().toISOString();
  database.prepare("INSERT INTO workspace_meta (workspace_id, name, origin_person_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)").run(workspaceId, workspaceManifest.name, now, now);
  const facts = new FactCommandService(database, workspaceId);
  facts.execute({
    type: "person.create",
    draft: { id: "person-one", workspaceId, displayName: "王小明", gender: "male", birth: { calendar: "lunar", year: 1980, month: 4, day: 2, leapMonth: true, precision: "day" } },
    source: { sourceKey: "seed", title: "seed", kind: "test" }
  });
  new WikiService(database, workspaceId).create({ title: "家训", body: "正文", personIds: ["person-one"], sourceIds: [] });
  const hash = createHash("sha256").update(mediaBytes).digest("hex");
  const relativePath = `media/${hash.slice(0, 2)}/${hash}.jpg`;
  await mkdir(dirname(join(workspaceRoot, relativePath)), { recursive: true });
  await writeFile(join(workspaceRoot, relativePath), mediaBytes);
  database.prepare("INSERT INTO media_asset (id, workspace_id, sha256, original_name, mime_type, byte_size, relative_path, created_at, updated_at) VALUES ('media-one', ?, ?, 'portrait.jpg', 'image/jpeg', ?, ?, ?, ?)")
    .run(workspaceId, hash, mediaBytes.length, relativePath.replaceAll("/", "\\"), now, now);
  database.close();
  const workspace: BackupWorkspace = { workspaceId, workspaceName: workspaceManifest.name, workspaceRoot, databasePath, mediaRoot, manifestPath, backupsRoot };
  return {
    root,
    workspace,
    target: { workspaceId, workspaceName: workspaceManifest.name, rootPath: workspaceRoot, databasePath, mediaPath: mediaRoot, manifestPath, backupsPath: backupsRoot },
    archivePath: join(root, "archives", "family-backup.zip")
  };
}
