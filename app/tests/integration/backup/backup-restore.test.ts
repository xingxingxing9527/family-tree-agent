import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupService } from "../../../src/main/application/backup/backup-service";
import { BackupValidationError, RestoreService } from "../../../src/main/application/backup/restore-service";
import { openDatabase } from "../../../src/main/database/open-database";
import { createBackupFixture, mediaBytes, workspaceId } from "./backup-fixture";
import { readZipEntries } from "./backup-test-support";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("verified backup and staged restore", () => {
  it("creates a deterministic manifest from a SQLite snapshot and restores every payload", async () => {
    const value = await createBackupFixture(roots);
    const backup = await new BackupService(value.workspace).createBackup(value.archivePath);

    expect(backup.manifest).toMatchObject({
      formatVersion: 1,
      workspaceId,
      workspaceName: "王氏家谱",
      schemaVersion: 4,
      counts: { people: 1, parentChild: 0, marriages: 0, wikiEntries: 1, mediaAssets: 1 }
    });
    expect(backup.manifest.files.map((entry) => entry.path)).toEqual([...backup.manifest.files.map((entry) => entry.path)].sort());
    expect(backup.manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "genealogy.sqlite" }),
      expect.objectContaining({ path: "workspace.json" }),
      expect.objectContaining({ path: expect.stringMatching(/^media\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/) })
    ]));
    const archived = await readZipEntries(value.archivePath);
    expect([...archived.keys()].sort()).toEqual(["backup-manifest.json", ...backup.manifest.files.map((entry) => entry.path)].sort());
    expect(Buffer.concat([...archived.values()]).toString("utf8")).not.toContain(value.root);
    expect(Buffer.concat([...archived.values()]).toString("utf8")).not.toContain("model-api-key");

    const changed = openDatabase(value.workspace.databasePath);
    changed.prepare("UPDATE person SET display_name='被修改', row_version=row_version+1 WHERE id='person-one'").run();
    changed.close();
    await writeFile(join(value.workspace.workspaceRoot, "unrelated-active-marker.txt"), "original");
    const snapshots = join(value.root, "restore-snapshots");
    await mkdir(snapshots);
    let committed = false;
    let completed = false;
    const restore = new RestoreService({
      resolveTarget: async (id) => id === workspaceId ? value.target : null,
      createVerifiedSnapshot: async () => { await new BackupService(value.workspace).createBackup(join(snapshots, "automatic.zip")); },
      deactivate: async () => undefined,
      commitActivation: async () => { committed = true; },
      rollbackActivation: async () => undefined,
      completeActivation: () => { completed = true; }
    });
    const inspection = await restore.inspectBackup({ archivePath: value.archivePath, targetWorkspaceId: workspaceId });
    expect(inspection).toMatchObject({ verified: true, targetWorkspaceId: workspaceId, manifest: { schemaVersion: 4, counts: backup.manifest.counts } });
    await restore.restoreBackup({ restoreToken: inspection.restoreToken, targetWorkspaceId: workspaceId, confirmReplace: true });

    expect(committed).toBe(true);
    expect(completed).toBe(true);
    const restored = openDatabase(value.workspace.databasePath);
    expect(restored.prepare("SELECT display_name FROM person WHERE id='person-one'").pluck().get()).toBe("王小明");
    expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
    restored.close();
    expect(await readFile(join(value.workspace.workspaceRoot, backup.manifest.files.find((entry) => entry.path.startsWith("media/"))!.path))).toEqual(mediaBytes);
    await expect(readFile(join(value.workspace.workspaceRoot, "unrelated-active-marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(snapshots, "automatic.zip"))).isFile()).toBe(true);
    await expect(restore.restoreBackup({ restoreToken: inspection.restoreToken, targetWorkspaceId: workspaceId, confirmReplace: true }))
      .rejects.toThrowError(expect.objectContaining<Partial<BackupValidationError>>({ code: "TOKEN_INVALID" }));
  });

  it("refuses backup when a declared media object is missing or hash-mismatched", async () => {
    const value = await createBackupFixture(roots);
    const database = openDatabase(value.workspace.databasePath);
    const path = database.prepare("SELECT relative_path FROM media_asset WHERE id='media-one'").pluck().get() as string;
    database.close();
    await writeFile(join(value.workspace.workspaceRoot, path), Buffer.from("tampered"));

    await expect(new BackupService(value.workspace).createBackup(value.archivePath))
      .rejects.toThrowError(expect.objectContaining<Partial<BackupValidationError>>({ code: "MEDIA_INVALID" }));
    await expect(stat(value.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a declared media object reached through an intermediate link outside the media root", async () => {
    const value = await createBackupFixture(roots);
    const database = openDatabase(value.workspace.databasePath);
    const relativePath = database.prepare("SELECT relative_path FROM media_asset WHERE id='media-one'").pluck().get() as string;
    database.close();
    const managedPath = join(value.workspace.workspaceRoot, relativePath);
    const managedDirectory = dirname(managedPath);
    const outside = join(value.root, "outside-media");
    await mkdir(outside);
    await writeFile(join(outside, basename(managedPath)), mediaBytes);
    await rm(managedDirectory, { recursive: true });
    await symlink(outside, managedDirectory, process.platform === "win32" ? "junction" : "dir");

    await expect(new BackupService(value.workspace).createBackup(value.archivePath))
      .rejects.toThrowError(expect.objectContaining<Partial<BackupValidationError>>({ code: "MEDIA_INVALID" }));
  });

  it("rolls directory and controller state back when post-rename activation fails", async () => {
    const value = await createBackupFixture(roots);
    await new BackupService(value.workspace).createBackup(value.archivePath);
    const changed = openDatabase(value.workspace.databasePath);
    changed.prepare("UPDATE person SET display_name='必须保留', row_version=row_version+1 WHERE id='person-one'").run();
    changed.close();
    const snapshots = join(value.root, "restore-snapshots");
    await mkdir(snapshots);
    let rollbackCalls = 0;
    let completionCalls = 0;
    const restore = new RestoreService({
      resolveTarget: async () => value.target,
      createVerifiedSnapshot: async () => { await new BackupService(value.workspace).createBackup(join(snapshots, "automatic.zip")); },
      deactivate: async () => undefined,
      commitActivation: async () => { throw new Error("injected post-rename failure"); },
      rollbackActivation: async () => { rollbackCalls += 1; },
      completeActivation: () => { completionCalls += 1; }
    });
    const inspection = await restore.inspectBackup({ archivePath: value.archivePath, targetWorkspaceId: workspaceId });

    await expect(restore.restoreBackup({ restoreToken: inspection.restoreToken, targetWorkspaceId: workspaceId, confirmReplace: true })).rejects.toThrow(/activation/i);

    const original = openDatabase(value.workspace.databasePath);
    expect(original.prepare("SELECT display_name FROM person WHERE id='person-one'").pluck().get()).toBe("必须保留");
    original.close();
    expect(rollbackCalls).toBe(1);
    expect(completionCalls).toBe(0);
    expect((await stat(join(snapshots, "automatic.zip"))).isFile()).toBe(true);
    expect((await readdir(join(value.root, "workspaces"))).filter((name) => name.includes("restore"))).toEqual([]);
  });

  it("rejects activation when the resolved target directory changed after inspection", async () => {
    const value = await createBackupFixture(roots);
    await new BackupService(value.workspace).createBackup(value.archivePath);
    let snapshotCalls = 0;
    const restore = new RestoreService({
      resolveTarget: async () => value.target,
      createVerifiedSnapshot: async () => { snapshotCalls += 1; },
      deactivate: async () => undefined,
      commitActivation: async () => undefined,
      rollbackActivation: async () => undefined
    });
    const inspection = await restore.inspectBackup({ archivePath: value.archivePath, targetWorkspaceId: workspaceId });
    const movedOriginal = join(dirname(value.target.rootPath), "moved-original");
    const differentTarget = join(dirname(value.target.rootPath), "different-target");
    await rename(value.target.rootPath, movedOriginal);
    await mkdir(differentTarget);
    await symlink(differentTarget, value.target.rootPath, process.platform === "win32" ? "junction" : "dir");

    await expect(restore.restoreBackup({ restoreToken: inspection.restoreToken, targetWorkspaceId: workspaceId, confirmReplace: true }))
      .rejects.toThrowError(expect.objectContaining<Partial<BackupValidationError>>({ code: "TARGET_INVALID" }));
    expect(snapshotCalls).toBe(0);
  });
});
