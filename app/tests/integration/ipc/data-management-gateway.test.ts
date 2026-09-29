import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupService } from "../../../src/main/application/backup/backup-service";
import { openDatabase } from "../../../src/main/database/open-database";
import { WorkspaceDataManagementGateway } from "../../../src/main/ipc/data-management-ipc";
import { WorkspaceMediaGateway } from "../../../src/main/ipc/media-ipc";
import { openSelectedMediaFile } from "../../../src/main/media/media-service";
import { WorkspaceManager } from "../../../src/main/workspaces/workspace-manager";

const roots: string[] = [];
const originPersonId = "33333333-3333-4333-8333-333333333333";
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
    database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, ?, '原始姓名', 'unknown', ?, ?)").run(originPersonId, context.workspaceId, now, now);
    database.prepare("UPDATE workspace_meta SET origin_person_id=? WHERE workspace_id=?").run(originPersonId, context.workspaceId);
    database.close();
    const manifest = JSON.parse(await readFile(context.manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(context.manifestPath, JSON.stringify({ ...manifest, originPersonId }));
    const indexPath = join(workspaceRoot, "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as { workspaces: Array<Record<string, unknown>> };
    await writeFile(indexPath, JSON.stringify({ workspaces: index.workspaces.map((entry) => entry.id === context.workspaceId ? { ...entry, originPersonId } : entry) }));
    const archivePath = join(archives, "private-family-backup.zip");
    await new BackupService({
      workspaceId: context.workspaceId,
      workspaceName: context.workspaceName,
      originPersonId,
      workspaceRoot: context.workspaceRoot,
      databasePath: context.databasePath,
      mediaRoot: context.mediaPath,
      manifestPath: context.manifestPath,
      backupsRoot: context.backupsPath
    }).createBackup(archivePath);
    const changed = openDatabase(context.databasePath);
    changed.prepare("UPDATE person SET display_name='恢复前修改', row_version=row_version+1 WHERE id=?").run(originPersonId);
    changed.close();

    const showOpenDialog = vi.fn().mockResolvedValue({ canceled: false, filePaths: [archivePath] });
    const retainedPath = join(context.backupsPath, "retained.jpg");
    await writeFile(retainedPath, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const retained = await openSelectedMediaFile(retainedPath, context.workspaceId);
    const closeHandle = retained.handle.close.bind(retained.handle);
    let closeStarted!: () => void;
    let allowClose!: () => void;
    const closing = new Promise<void>((resolve) => { closeStarted = resolve; });
    const closeGate = new Promise<void>((resolve) => { allowClose = resolve; });
    retained.handle.close = async () => { closeStarted(); await closeGate; await closeHandle(); };
    const media = new WorkspaceMediaGateway(manager, {
      showOpenDialog: async () => ({ canceled: false, filePaths: [retainedPath] })
    }, 300_000, { open: async () => retained, close: async (selection) => selection.handle.close() });
    expect((await media.select()).ok).toBe(true);
    const disposed = vi.fn(async () => media.dispose());
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
      originPersonId,
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

    const restore = gateway.restoreBackup({ restoreToken: inspected.value.restoreToken, targetWorkspaceId: context.workspaceId, confirmReplace: true });
    await closing;
    await expect(stat(manager.getAutomaticSnapshotRoot())).rejects.toMatchObject({ code: "ENOENT" });
    allowClose();
    await expect(restore).resolves.toEqual({ ok: true, value: { restored: true, automaticSnapshotVerified: true, cleanupPending: false } });
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(manager.getOpenWorkspaceContext()?.workspaceId).toBe(context.workspaceId);
    const restored = openDatabase(context.databasePath);
    expect(restored.prepare("SELECT display_name FROM person WHERE id=?").pluck().get(originPersonId)).toBe("原始姓名");
    restored.close();
    const snapshots = await readdir(manager.getAutomaticSnapshotRoot());
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatch(/\.zip$/u);
    await gateway.dispose();
  });

  it("rejects a linked automatic-snapshot root without writing through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-data-gateway-"));
    roots.push(root);
    const workspaceRoot = join(root, "app-data", "workspaces");
    const archives = join(root, "archives");
    const outside = join(root, "outside-snapshots");
    await Promise.all([mkdir(archives, { recursive: true }), mkdir(outside)]);
    const manager = new WorkspaceManager(workspaceRoot);
    const created = await manager.create({ name: "王氏家谱" });
    if (!created.ok) throw new Error("workspace fixture failed");
    const opened = await manager.open({ id: created.value.id });
    if (!opened.ok) throw new Error("workspace open failed");
    const context = manager.getOpenWorkspaceDetails()!;
    const database = openDatabase(context.databasePath);
    const now = "2026-09-16T00:00:00.000Z";
    database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, ?, '原始姓名', 'unknown', ?, ?)").run(originPersonId, context.workspaceId, now, now);
    database.prepare("UPDATE workspace_meta SET origin_person_id=? WHERE workspace_id=?").run(originPersonId, context.workspaceId);
    database.close();
    const manifest = JSON.parse(await readFile(context.manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(context.manifestPath, JSON.stringify({ ...manifest, originPersonId }));
    const indexPath = join(workspaceRoot, "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as { workspaces: Array<Record<string, unknown>> };
    await writeFile(indexPath, JSON.stringify({ workspaces: index.workspaces.map((entry) => entry.id === context.workspaceId ? { ...entry, originPersonId } : entry) }));
    const archivePath = join(archives, "valid.zip");
    await new BackupService({
      workspaceId: context.workspaceId, workspaceName: context.workspaceName, originPersonId, workspaceRoot: context.workspaceRoot,
      databasePath: context.databasePath, mediaRoot: context.mediaPath, manifestPath: context.manifestPath, backupsRoot: context.backupsPath
    }).createBackup(archivePath);
    await symlink(outside, manager.getAutomaticSnapshotRoot(), process.platform === "win32" ? "junction" : "dir");
    const gateway = new WorkspaceDataManagementGateway(manager, {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: [archivePath] }),
      showSaveDialog: vi.fn()
    });
    const selected = await gateway.selectRestoreFile();
    if (!selected.ok || !selected.value.fileToken) throw new Error("selection failed");
    const inspected = await gateway.inspectBackup({ fileToken: selected.value.fileToken, targetWorkspaceId: context.workspaceId });
    if (!inspected.ok) throw new Error("inspection failed");

    await expect(gateway.restoreBackup({ restoreToken: inspected.value.restoreToken, targetWorkspaceId: context.workspaceId, confirmReplace: true }))
      .resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await readdir(outside)).toEqual([]);
    await gateway.dispose();
  });
});
