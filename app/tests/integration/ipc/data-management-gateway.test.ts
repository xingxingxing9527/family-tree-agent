import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupService } from "../../../src/main/application/backup/backup-service";
import { openDatabase } from "../../../src/main/database/open-database";
import { WorkspaceDataManagementGateway } from "../../../src/main/ipc/data-management-ipc";
import { WorkspaceManager } from "../../../src/main/workspaces/workspace-manager";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("data-management native capabilities", () => {
  it("keeps the selected archive path opaque, consumes the selection, and preserves an automatic snapshot through activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-data-gateway-"));
    roots.push(root);
    const workspaceRoot = join(root, "app-data", "workspaces");
    const archives = join(root, "archives");
    await mkdir(archives, { recursive: true });
    const manager = new WorkspaceManager(workspaceRoot);
    const created = await manager.create({ name: "王氏家谱" });
    if (!created.ok) throw new Error("workspace fixture failed");
    const opened = await manager.open({ id: created.value.id });
    if (!opened.ok) throw new Error("workspace open failed");
    const context = manager.getOpenWorkspaceDetails()!;
    const database = openDatabase(context.databasePath);
    const now = "2026-09-16T00:00:00.000Z";
    database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES ('person-one', ?, '原始姓名', 'unknown', ?, ?)").run(context.workspaceId, now, now);
    database.close();
    const archivePath = join(archives, "private-family-backup.zip");
    await new BackupService({
      workspaceId: context.workspaceId,
      workspaceName: context.workspaceName,
      workspaceRoot: context.workspaceRoot,
      databasePath: context.databasePath,
      mediaRoot: context.mediaPath,
      manifestPath: context.manifestPath,
      backupsRoot: context.backupsPath
    }).createBackup(archivePath);
    const changed = openDatabase(context.databasePath);
    changed.prepare("UPDATE person SET display_name='恢复前修改', row_version=row_version+1 WHERE id='person-one'").run();
    changed.close();

    const showOpenDialog = vi.fn().mockResolvedValue({ canceled: false, filePaths: [archivePath] });
    const disposed = vi.fn();
    const gateway = new WorkspaceDataManagementGateway(manager, {
      showOpenDialog,
      showSaveDialog: vi.fn()
    }, { disposeWorkspaceServices: disposed });

    const selected = await gateway.selectRestoreFile();
    expect(selected).toMatchObject({ ok: true, value: { selected: true, fileToken: expect.any(String), fileName: "private-family-backup.zip" } });
    expect(JSON.stringify(selected)).not.toContain(root);
    if (!selected.ok || !selected.value.fileToken) throw new Error("selection failed");
    await rename(archivePath, join(archives, "selected-original.zip"));
    await new BackupService({
      workspaceId: context.workspaceId,
      workspaceName: context.workspaceName,
      workspaceRoot: context.workspaceRoot,
      databasePath: context.databasePath,
      mediaRoot: context.mediaPath,
      manifestPath: context.manifestPath,
      backupsRoot: context.backupsPath
    }).createBackup(archivePath);
    const request = { fileToken: selected.value.fileToken, targetWorkspaceId: context.workspaceId };
    const inspected = await gateway.inspectBackup(request);
    expect(inspected).toMatchObject({ ok: true, value: { verified: true, targetWorkspaceId: context.workspaceId, manifest: { schemaVersion: 4 } } });
    expect(JSON.stringify(inspected)).not.toContain(root);
    await expect(gateway.inspectBackup(request)).resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
    if (!inspected.ok) throw new Error("inspection failed");

    await expect(gateway.restoreBackup({ restoreToken: inspected.value.restoreToken, targetWorkspaceId: context.workspaceId, confirmReplace: true })).resolves.toEqual({ ok: true, value: { restored: true, automaticSnapshotVerified: true } });
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(manager.getOpenWorkspaceContext()?.workspaceId).toBe(context.workspaceId);
    const restored = openDatabase(context.databasePath);
    expect(restored.prepare("SELECT display_name FROM person WHERE id='person-one'").pluck().get()).toBe("原始姓名");
    restored.close();
    const snapshots = await readdir(manager.getAutomaticSnapshotRoot());
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatch(/\.zip$/u);
    await gateway.dispose();
  });
});
