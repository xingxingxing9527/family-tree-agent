import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppResult, BackupInspectionDto, BackupSummaryDto } from "../../shared/contracts.js";
import { BackupService } from "../../main/application/backup/backup-service.js";
import {
  BackupValidationError,
  RestoreService,
  type RestoreController,
  type RestoreTarget
} from "../../main/application/backup/restore-service.js";
import type { WorkspaceManagerState } from "../../main/workspaces/workspace-manager.js";
import {
  canonicalPlainDirectory,
  normalizePathIdentity,
  pathContains,
  pathsOverlap
} from "../../main/workspaces/workspace-path-security.js";
import type { UploadStore } from "../http/upload-store.js";
import type { FamilyRuntime } from "./family-runtime.js";

const failure = <T>(code: "PATH_DENIED" | "NOT_FOUND" | "VALIDATION" | "CONFLICT" | "INTERNAL", message: string): AppResult<T> => ({
  ok: false,
  error: { code, message }
});

const backupSummary = (manifest: {
  formatVersion: 1;
  workspaceId: string;
  workspaceName: string;
  schemaVersion: number;
  createdAt: string;
  counts: BackupSummaryDto["counts"];
}): BackupSummaryDto => ({
  formatVersion: manifest.formatVersion,
  workspaceId: manifest.workspaceId,
  workspaceName: manifest.workspaceName,
  schemaVersion: manifest.schemaVersion,
  createdAt: manifest.createdAt,
  counts: manifest.counts
});

function safeRestoreError<T>(error: unknown, fallback: string): AppResult<T> {
  if (!(error instanceof BackupValidationError)) return failure("INTERNAL", fallback);
  if (error.code === "TOKEN_INVALID") return failure("PATH_DENIED", "Backup selection expired or was already used");
  if (error.code === "TARGET_INVALID") return failure("NOT_FOUND", "Restore target is unavailable");
  if (error.code === "CONFIRMATION_REQUIRED") return failure("VALIDATION", "Replacement confirmation is required");
  if (error.code === "PEOPLE_LIMIT_EXCEEDED") return failure("VALIDATION", "Backup exceeds the 1,000-person limit");
  if (error.code === "ROLLBACK_FAILED") return failure("CONFLICT", "Restore failed and automatic rollback could not be confirmed");
  if (error.code === "ACTIVATION_FAILED") return failure("CONFLICT", "Restore activation failed; the original family was preserved");
  return failure("VALIDATION", "Backup could not be verified");
}

class BrowserRestoreController implements RestoreController {
  private readonly states = new Map<string, WorkspaceManagerState>();

  constructor(private readonly runtime: FamilyRuntime) {}

  resolveTarget(workspaceId: string): Promise<RestoreTarget | null> {
    return this.runtime.workspaceManager.resolveRestoreTarget(workspaceId);
  }

  acquireExclusive(): ReturnType<FamilyRuntime["mutationGate"]["acquireExclusive"]> {
    return this.runtime.mutationGate.acquireExclusive();
  }

  async createVerifiedSnapshot(target: RestoreTarget): Promise<void> {
    const snapshotRoot = this.runtime.workspaceManager.getAutomaticSnapshotRoot();
    await mkdir(snapshotRoot, { recursive: true });
    const [canonicalSnapshotRoot, canonicalTargetRoot] = await Promise.all([
      canonicalPlainDirectory(snapshotRoot),
      canonicalPlainDirectory(target.rootPath)
    ]).catch(() => {
      throw new BackupValidationError("ACTIVATION_FAILED", "Automatic snapshot root is linked or unavailable");
    });
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
  }

  async deactivate(target: RestoreTarget): Promise<void> {
    this.states.set(target.workspaceId, await this.runtime.workspaceManager.captureRestoreState());
    await this.runtime.workspaceManager.deactivateForRestore(target.workspaceId);
  }

  async commitActivation(target: RestoreTarget, manifest: Parameters<RestoreController["commitActivation"]>[1], schemaVersion: number): Promise<void> {
    const state = this.states.get(target.workspaceId);
    if (!state) throw new Error("Restore state is unavailable");
    await this.runtime.workspaceManager.commitRestoredWorkspace(
      target.workspaceId,
      manifest,
      schemaVersion,
      state.openWorkspaceContext?.workspaceId === target.workspaceId
    );
  }

  async rollbackActivation(target: RestoreTarget): Promise<void> {
    const state = this.states.get(target.workspaceId);
    if (!state) throw new Error("Restore rollback state is unavailable");
    await this.runtime.workspaceManager.restoreManagerState(state);
    this.states.delete(target.workspaceId);
  }

  completeActivation(target: RestoreTarget): void {
    this.states.delete(target.workspaceId);
  }
}

export class BrowserRestoreManager {
  private readonly restore: RestoreService;

  constructor(private readonly runtime: FamilyRuntime, private readonly uploads: UploadStore) {
    this.restore = new RestoreService(new BrowserRestoreController(runtime));
  }

  async inspectBackup(input: { fileToken: string; targetWorkspaceId: string }): Promise<AppResult<BackupInspectionDto>> {
    const claimed = await this.uploads.claim(input.fileToken, "backup");
    if (!claimed.ok) return failure("PATH_DENIED", "Backup upload expired, was already used, or has the wrong purpose");
    try {
      const inspected = await this.restore.inspectBackup({ archivePath: claimed.path, targetWorkspaceId: input.targetWorkspaceId });
      return {
        ok: true,
        value: {
          restoreToken: inspected.restoreToken,
          targetWorkspaceId: inspected.targetWorkspaceId,
          verified: true,
          expiresAt: inspected.expiresAt,
          manifest: backupSummary(inspected.manifest)
        }
      };
    } catch (error) {
      return safeRestoreError(error, "Unable to inspect backup");
    } finally {
      await rm(claimed.path, { force: true });
    }
  }

  async restoreBackup(input: { restoreToken: string; targetWorkspaceId: string; confirmReplace: true }): Promise<AppResult<{ restored: true; automaticSnapshotVerified: true; cleanupPending: boolean }>> {
    try {
      return { ok: true, value: await this.restore.restoreBackup(input) };
    } catch (error) {
      return safeRestoreError(error, "Unable to restore backup");
    }
  }

  dispose(): Promise<void> {
    return this.restore.dispose();
  }
}
