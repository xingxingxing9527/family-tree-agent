import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { dialog, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type {
  AppErrorCode, AppResult, AuditOperationGroupDto, BackupInspectionDto, BackupSummaryDto, DataManagementApi, WorkspaceSummary
} from "../../shared/contracts.js";
import { UndoError, UndoService } from "../application/audit/undo-service.js";
import { BackupService, type BackupWorkspace } from "../application/backup/backup-service.js";
import { BackupValidationError, RestoreService, type RestoreController, type RestoreTarget } from "../application/backup/restore-service.js";
import { ExportService, ExportValidationError } from "../application/export/export-service.js";
import { applyMigrations } from "../database/migrations/index.js";
import { openDatabase } from "../database/open-database.js";
import type { WorkspaceManager, WorkspaceManagerState } from "../workspaces/workspace-manager.js";
import { canonicalPlainDirectory, normalizePathIdentity, pathContains, pathsOverlap } from "../workspaces/workspace-path-security.js";
import { WorkspaceMutationGate } from "../workspaces/workspace-mutation-gate.js";

export const DATA_MANAGEMENT_CHANNELS = {
  auditList: "data-management:audit-list",
  auditUndo: "data-management:audit-undo",
  backupCreate: "data-management:backup-create",
  restoreTargets: "data-management:restore-targets",
  restoreSelect: "data-management:restore-select",
  restoreInspect: "data-management:restore-inspect",
  restoreActivate: "data-management:restore-activate",
  exportCreate: "data-management:export-create"
} as const;

export interface DataManagementGateway extends DataManagementApi {}

export interface DataManagementDialogs {
  showOpenDialog(options: { title: string; properties: string[]; filters?: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(options: { title: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePath?: string }>;
}

const nativeDialogs: DataManagementDialogs = {
  showOpenDialog: (options) => dialog.showOpenDialog(options as Parameters<typeof dialog.showOpenDialog>[0]),
  showSaveDialog: (options) => dialog.showSaveDialog(options as Parameters<typeof dialog.showSaveDialog>[0])
};

const failure = <T>(code: AppErrorCode, message: string): AppResult<T> => ({ ok: false, error: { code, message } });
const backupSummary = (manifest: { formatVersion: 1; workspaceId: string; workspaceName: string; schemaVersion: number; createdAt: string; counts: BackupSummaryDto["counts"] }): BackupSummaryDto => ({
  formatVersion: manifest.formatVersion,
  workspaceId: manifest.workspaceId,
  workspaceName: manifest.workspaceName,
  schemaVersion: manifest.schemaVersion,
  createdAt: manifest.createdAt,
  counts: manifest.counts
});

function safeError<T>(error: unknown, fallback: string): AppResult<T> {
  if (error instanceof UndoError) {
    if (error.code === "NOT_FOUND") return failure("NOT_FOUND", "Operation group was not found");
    if (error.code === "NOT_UNDOABLE") return failure("CONFLICT", "Operation group cannot be safely undone");
    return failure("CONFLICT", "Operation group changed and cannot be safely undone");
  }
  if (error instanceof BackupValidationError) {
    if (error.code === "TOKEN_INVALID") return failure("PATH_DENIED", "Backup selection expired or was already used");
    if (error.code === "TARGET_INVALID") return failure("NOT_FOUND", "Restore target is unavailable");
    if (error.code === "CONFIRMATION_REQUIRED") return failure("VALIDATION", "Replacement confirmation is required");
    if (error.code === "ROLLBACK_FAILED") return failure("CONFLICT", "Restore failed and automatic rollback could not be confirmed");
    if (error.code === "ACTIVATION_FAILED") return failure("CONFLICT", "Restore activation failed; the original workspace was preserved");
    return failure("VALIDATION", "Backup could not be verified");
  }
  if (error instanceof ExportValidationError) {
    if (error.code === "TARGET_NOT_EMPTY" || error.code === "TARGET_INVALID") return failure("VALIDATION", "Export destination must be an empty folder outside application data");
    if (error.code === "MEDIA_INVALID") return failure("CONFLICT", "Managed media changed; export was not created");
    return failure("INTERNAL", "Unable to export workspace");
  }
  return failure("INTERNAL", fallback);
}

class WorkspaceRestoreController implements RestoreController {
  private readonly states = new Map<string, WorkspaceManagerState>();
  constructor(
    private readonly workspaces: WorkspaceManager,
    private readonly disposeWorkspaceServices: () => void | Promise<void>,
    private readonly mutations: WorkspaceMutationGate
  ) {}

  resolveTarget(workspaceId: string): Promise<RestoreTarget | null> { return this.workspaces.resolveRestoreTarget(workspaceId); }
  acquireExclusive(): ReturnType<WorkspaceMutationGate["acquireExclusive"]> { return this.mutations.acquireExclusive(); }

  async createVerifiedSnapshot(target: RestoreTarget): Promise<void> {
    try {
      const snapshotRoot = this.workspaces.getAutomaticSnapshotRoot();
      await mkdir(snapshotRoot, { recursive: true });
      const [canonicalSnapshotRoot, canonicalTargetRoot] = await Promise.all([
        canonicalPlainDirectory(snapshotRoot), canonicalPlainDirectory(target.rootPath)
      ]).catch(() => { throw new BackupValidationError("ACTIVATION_FAILED", "Automatic snapshot root is linked or unavailable"); });
      if (pathsOverlap(normalizePathIdentity(canonicalSnapshotRoot), normalizePathIdentity(canonicalTargetRoot))) {
        throw new BackupValidationError("ACTIVATION_FAILED", "Automatic snapshot root overlaps the restore target");
      }
      const stamp = new Date().toISOString().replaceAll(":", "-");
      const destination = join(canonicalSnapshotRoot, `${target.workspaceId}-${stamp}-${randomUUID()}.zip`);
      await new BackupService({
        workspaceId: target.workspaceId,
        workspaceName: target.workspaceName,
        originPersonId: target.originPersonId,
        workspaceRoot: target.rootPath,
        databasePath: target.databasePath,
        mediaRoot: target.mediaPath,
        manifestPath: target.manifestPath,
        backupsRoot: target.backupsPath
      }).createBackup(destination);
      const archiveInfo = await lstat(destination);
      const canonicalArchive = await realpath(destination);
      if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || !pathContains(canonicalSnapshotRoot, canonicalArchive)) {
        throw new BackupValidationError("ACTIVATION_FAILED", "Automatic snapshot escaped its managed root");
      }
    } catch (error) { throw error; }
  }

  async deactivate(target: RestoreTarget): Promise<void> {
    const state = await this.workspaces.captureRestoreState();
    this.states.set(target.workspaceId, state);
    await this.workspaces.deactivateForRestore(target.workspaceId);
    await this.disposeWorkspaceServices();
  }

  async commitActivation(target: RestoreTarget, manifest: Parameters<RestoreController["commitActivation"]>[1], schemaVersion: number): Promise<void> {
    const state = this.states.get(target.workspaceId);
    if (!state) throw new Error("Restore state is unavailable");
    const reopen = state.openWorkspaceContext?.workspaceId === target.workspaceId;
    await this.workspaces.commitRestoredWorkspace(target.workspaceId, manifest, schemaVersion, reopen);
  }

  async rollbackActivation(target: RestoreTarget): Promise<void> {
    const state = this.states.get(target.workspaceId);
    if (!state) throw new Error("Restore rollback state is unavailable");
    await this.workspaces.restoreManagerState(state);
    this.states.delete(target.workspaceId);
  }

  completeActivation(target: RestoreTarget): void {
    this.states.delete(target.workspaceId);
  }
}

interface SelectedArchive { path: string; ownerRoot: string; expiresAt: number; timer: ReturnType<typeof setTimeout>; }

export class WorkspaceDataManagementGateway implements DataManagementGateway {
  private readonly restore: RestoreService;
  private readonly selectedArchives = new Map<string, SelectedArchive>();

  constructor(
    private readonly workspaces: WorkspaceManager,
    private readonly dialogs: DataManagementDialogs = nativeDialogs,
    options: { selectionTtlMs?: number; disposeWorkspaceServices?: () => void | Promise<void>; mutationGate?: WorkspaceMutationGate } = {}
  ) {
    this.selectionTtlMs = options.selectionTtlMs ?? 5 * 60_000;
    this.mutationGate = options.mutationGate ?? new WorkspaceMutationGate();
    this.restore = new RestoreService(new WorkspaceRestoreController(workspaces, options.disposeWorkspaceServices ?? (() => undefined), this.mutationGate));
  }

  private readonly selectionTtlMs: number;
  private readonly mutationGate: WorkspaceMutationGate;

  async listAudit(): Promise<AppResult<AuditOperationGroupDto[]>> {
    const context = this.workspaces.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    let database;
    try {
      database = openDatabase(context.databasePath);
      applyMigrations(database);
      return { ok: true, value: new UndoService(database, context.workspaceId).listOperationGroups() };
    } catch (error) { return safeError(error, "Unable to read operation history"); }
    finally { database?.close(); }
  }

  async undoOperationGroup(input: { operationGroupId: string }): Promise<AppResult<{ operationGroupId: string; undoneAt: string; restoredEntities: number }>> {
    const context = this.workspaces.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    let database;
    let value: { operationGroupId: string; undoneAt: string; restoredEntities: number };
    try {
      database = openDatabase(context.databasePath);
      applyMigrations(database);
      value = new UndoService(database, context.workspaceId).undoOperationGroup(input.operationGroupId);
    } catch (error) { return safeError(error, "Unable to undo operation group"); }
    finally { database?.close(); }
    try { await this.workspaces.synchronizeOriginPerson(); }
    catch { return failure("INTERNAL", "Unable to publish workspace origin person"); }
    return { ok: true, value };
  }

  async createBackup(): Promise<AppResult<{ saved: boolean; verified?: true; createdAt?: string; schemaVersion?: number; counts?: BackupSummaryDto["counts"] }>> {
    const context = this.workspaces.getOpenWorkspaceDetails();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    const selected = await this.dialogs.showSaveDialog({ title: "创建谱册备份", defaultPath: `family-backup-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: "Verified backup", extensions: ["zip"] }] });
    if (selected.canceled || !selected.filePath) return { ok: true, value: { saved: false } };
    if (extname(selected.filePath).toLocaleLowerCase("en-US") !== ".zip") return failure("VALIDATION", "Backup file must use the .zip extension");
    try {
      const result = await new BackupService(this.backupWorkspace(context)).createBackup(selected.filePath);
      return { ok: true, value: { saved: true, verified: true, createdAt: result.manifest.createdAt, schemaVersion: result.manifest.schemaVersion, counts: result.manifest.counts } };
    } catch (error) { return safeError(error, "Unable to create backup"); }
  }

  listRestoreTargets(): Promise<AppResult<WorkspaceSummary[]>> { return this.workspaces.list(); }

  async selectRestoreFile(): Promise<AppResult<{ selected: boolean; fileToken?: string; fileName?: string }>> {
    const selected = await this.dialogs.showOpenDialog({ title: "选择谱册备份", properties: ["openFile"], filters: [{ name: "Verified backup", extensions: ["zip"] }] });
    if (selected.canceled || selected.filePaths.length === 0) return { ok: true, value: { selected: false } };
    if (selected.filePaths.length !== 1) return failure("VALIDATION", "Select one backup file");
    let ownerRoot: string | null = null;
    try {
      const path = await realpath(selected.filePaths[0]!);
      const before = await stat(path);
      if (!before.isFile() || extname(path).toLocaleLowerCase("en-US") !== ".zip") return failure("VALIDATION", "Selected backup file is invalid");
      ownerRoot = await mkdtemp(join(tmpdir(), "family-agent-restore-selection-"));
      const privatePath = join(ownerRoot, "selected.zip");
      await copyFile(path, privatePath, constants.COPYFILE_EXCL);
      const [after, copied] = await Promise.all([stat(path), stat(privatePath)]);
      if (
        !copied.isFile() || copied.size !== before.size ||
        after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      ) throw new Error("Selected backup changed while creating its private snapshot");
      while (this.selectedArchives.size >= 8) await this.releaseSelection(this.selectedArchives.keys().next().value as string);
      const fileToken = randomUUID();
      const expiresAt = Date.now() + this.selectionTtlMs;
      const timer = setTimeout(() => { void this.releaseSelection(fileToken); }, this.selectionTtlMs);
      timer.unref();
      this.selectedArchives.set(fileToken, { path: privatePath, ownerRoot, expiresAt, timer });
      ownerRoot = null;
      return { ok: true, value: { selected: true, fileToken, fileName: basename(path) } };
    } catch {
      if (ownerRoot) await rm(ownerRoot, { recursive: true, force: true });
      return failure("VALIDATION", "Selected backup file is unavailable");
    }
  }

  async inspectBackup(input: { fileToken: string; targetWorkspaceId: string }): Promise<AppResult<BackupInspectionDto>> {
    const selection = this.takeSelection(input.fileToken);
    if (!selection || selection.expiresAt < Date.now()) {
      if (selection) await rm(selection.ownerRoot, { recursive: true, force: true });
      return failure("PATH_DENIED", "Backup selection expired; select it again");
    }
    try {
      const inspected = await this.restore.inspectBackup({ archivePath: selection.path, targetWorkspaceId: input.targetWorkspaceId });
      return { ok: true, value: {
        restoreToken: inspected.restoreToken,
        targetWorkspaceId: inspected.targetWorkspaceId,
        verified: true,
        expiresAt: inspected.expiresAt,
        manifest: backupSummary(inspected.manifest)
      } };
    } catch (error) { return safeError(error, "Unable to inspect backup"); }
    finally { await rm(selection.ownerRoot, { recursive: true, force: true }); }
  }

  async restoreBackup(input: { restoreToken: string; targetWorkspaceId: string; confirmReplace: true }): Promise<AppResult<{ restored: true; automaticSnapshotVerified: true; cleanupPending: boolean }>> {
    try { return { ok: true, value: await this.restore.restoreBackup(input) }; }
    catch (error) { return safeError(error, "Unable to restore backup"); }
  }

  async exportWorkspace(): Promise<AppResult<{ saved: boolean; files?: number; mediaAssets?: number }>> {
    const context = this.workspaces.getOpenWorkspaceDetails();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    const selected = await this.dialogs.showOpenDialog({ title: "选择空文件夹导出资料", properties: ["openDirectory", "createDirectory"] });
    if (selected.canceled || selected.filePaths.length === 0) return { ok: true, value: { saved: false } };
    if (selected.filePaths.length !== 1) return failure("VALIDATION", "Select one export folder");
    try {
      const result = await new ExportService({
        workspaceId: context.workspaceId,
        workspaceRoot: context.workspaceRoot,
        appDataRoot: context.appDataRoot,
        databasePath: context.databasePath,
        mediaRoot: context.mediaPath
      }).exportWorkspace(selected.filePaths[0]!);
      return { ok: true, value: { saved: true, ...result } };
    } catch (error) { return safeError(error, "Unable to export workspace"); }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.selectedArchives.keys()].map((token) => this.releaseSelection(token)));
    await this.restore.dispose();
  }

  private backupWorkspace(context: NonNullable<ReturnType<WorkspaceManager["getOpenWorkspaceDetails"]>>): BackupWorkspace {
    return {
      workspaceId: context.workspaceId,
      workspaceName: context.workspaceName,
      originPersonId: context.originPersonId,
      workspaceRoot: context.workspaceRoot,
      databasePath: context.databasePath,
      mediaRoot: context.mediaPath,
      manifestPath: context.manifestPath,
      backupsRoot: context.backupsPath
    };
  }

  private takeSelection(token: string): SelectedArchive | null {
    const selected = this.selectedArchives.get(token);
    if (!selected) return null;
    clearTimeout(selected.timer);
    this.selectedArchives.delete(token);
    return selected;
  }

  private async releaseSelection(token: string): Promise<void> {
    const selected = this.takeSelection(token);
    if (!selected) return;
    await rm(selected.ownerRoot, { recursive: true, force: true });
  }
}

type IpcMainLike = Pick<IpcMain, "handle">;
const emptySchema = z.object({}).strict();
const identifier = z.string().uuid();
const undoSchema = z.object({ operationGroupId: identifier }).strict();
const inspectSchema = z.object({ fileToken: identifier, targetWorkspaceId: identifier }).strict();
const activateSchema = z.object({ restoreToken: identifier, targetWorkspaceId: identifier, confirmReplace: z.literal(true) }).strict();

export function registerDataManagementIpc(ipc: IpcMainLike, mainWindowId: () => number | undefined, data: DataManagementGateway, mutations?: WorkspaceMutationGate): void {
  const register = <T>(channel: string, schema: z.ZodType<T>, operation: (input: T) => Promise<AppResult<unknown>>, gated = true): void => {
    ipc.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown) => {
      if (event.sender.id !== mainWindowId()) return failure("PATH_DENIED", "IPC sender was denied");
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return failure("VALIDATION", "Invalid request");
      try { return await (gated && mutations ? mutations.runOperation(() => operation(parsed.data)) : operation(parsed.data)); }
      catch { return failure("INTERNAL", "Unable to complete data-management request"); }
    });
  };
  register(DATA_MANAGEMENT_CHANNELS.auditList, emptySchema, () => data.listAudit());
  register(DATA_MANAGEMENT_CHANNELS.auditUndo, undoSchema, (input) => data.undoOperationGroup(input), true);
  register(DATA_MANAGEMENT_CHANNELS.backupCreate, emptySchema, () => data.createBackup(), true);
  register(DATA_MANAGEMENT_CHANNELS.restoreTargets, emptySchema, () => data.listRestoreTargets());
  register(DATA_MANAGEMENT_CHANNELS.restoreSelect, emptySchema, () => data.selectRestoreFile(), false);
  register(DATA_MANAGEMENT_CHANNELS.restoreInspect, inspectSchema, (input) => data.inspectBackup(input));
  register(DATA_MANAGEMENT_CHANNELS.restoreActivate, activateSchema, (input) => data.restoreBackup(input), false);
  register(DATA_MANAGEMENT_CHANNELS.exportCreate, emptySchema, () => data.exportWorkspace(), true);
}
