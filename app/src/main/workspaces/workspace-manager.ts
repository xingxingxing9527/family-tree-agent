import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { AppResult, WorkspacePaths, WorkspaceSummary } from "../../shared/contracts.js";
import type { BackupManifest } from "../application/backup/backup-manifest.js";
import type { RestoreTarget } from "../application/backup/restore-service.js";
import { applyMigrations, LATEST_SCHEMA_VERSION } from "../database/migrations/index.js";
import { openDatabase } from "../database/open-database.js";
import { WorkspaceIndex } from "./workspace-index.js";
import { resolveWorkspacePaths } from "./workspace-paths.js";

const failure = <T>(code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "PATH_DENIED" | "INTERNAL", message: string, details?: unknown): AppResult<T> => ({ ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } });

export interface OpenWorkspaceContext {
  workspaceId: string;
  databasePath: string;
  mediaPath: string;
}

export interface OpenWorkspaceDetails extends OpenWorkspaceContext {
  workspaceName: string;
  directory: string;
  workspaceRoot: string;
  manifestPath: string;
  backupsPath: string;
  appDataRoot: string;
}

export interface WorkspaceManagerState {
  workspaces: WorkspaceSummary[];
  openWorkspaceContext: OpenWorkspaceDetails | null;
}

export class WorkspaceManager {
  private readonly index: WorkspaceIndex;
  private openWorkspaceContext: OpenWorkspaceDetails | null = null;
  constructor(private readonly root: string) { this.index = new WorkspaceIndex(root); }
  async list(): Promise<AppResult<WorkspaceSummary[]>> { try { return { ok: true, value: await this.index.read() }; } catch { return failure("INTERNAL", "Unable to list workspaces"); } }
  async create(input: { name: string }): Promise<AppResult<WorkspaceSummary>> {
    const name = input.name.trim();
    if (!name) return failure("VALIDATION", "Workspace name is required", { field: "name" });
    const id = randomUUID(); const directory = randomUUID(); const paths = resolveWorkspacePaths(this.root, directory);
    if (!paths) return failure("PATH_DENIED", "Workspace directory was denied", { id });
    const summary: WorkspaceSummary = { id, name, directory, originPersonId: null, lastOpenedAt: null, schemaVersion: LATEST_SCHEMA_VERSION };
    try {
      await mkdir(this.root, { recursive: true });
      await this.createFiles(paths, summary);
      const workspaces = await this.index.read(); workspaces.push(summary); await this.index.write(workspaces);
      return { ok: true, value: summary };
    } catch { return failure("INTERNAL", "Unable to create workspace", { id }); }
  }
  async open(input: { id: string }): Promise<AppResult<WorkspaceSummary>> {
    try {
      const workspaces = await this.index.read(); const workspace = workspaces.find((entry) => entry.id === input.id);
      if (!workspace) return failure("NOT_FOUND", "Workspace was not found", { id: input.id });
      const paths = resolveWorkspacePaths(this.root, workspace.directory);
      if (!paths) return failure("PATH_DENIED", "Workspace directory was denied", { id: input.id });
      if (!await this.hasRequiredFiles(paths)) return failure("NOT_FOUND", "Workspace files were not found", { id: input.id });
      const database = openDatabase(paths.database);
      let migratedVersion: number;
      try {
        migratedVersion = applyMigrations(database);
        const now = new Date().toISOString();
        database.prepare(`
          INSERT INTO workspace_meta (workspace_id, name, origin_person_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET
            name = excluded.name,
            origin_person_id = excluded.origin_person_id,
            updated_at = excluded.updated_at,
            row_version = workspace_meta.row_version + 1
        `).run(workspace.id, workspace.name, workspace.originPersonId, now, now);
      } finally {
        database.close();
      }
      const updated = { ...workspace, schemaVersion: migratedVersion, lastOpenedAt: new Date().toISOString() }; await this.index.write(workspaces.map((entry) => entry.id === updated.id ? updated : entry));
      this.openWorkspaceContext = this.context(updated, paths); return { ok: true, value: updated };
    } catch { return failure("INTERNAL", "Unable to open workspace", { id: input.id }); }
  }
  async close(): Promise<AppResult<null>> { this.openWorkspaceContext = null; return { ok: true, value: null }; }
  getOpenWorkspaceContext(): OpenWorkspaceContext | null {
    return this.openWorkspaceContext ? {
      workspaceId: this.openWorkspaceContext.workspaceId,
      databasePath: this.openWorkspaceContext.databasePath,
      mediaPath: this.openWorkspaceContext.mediaPath
    } : null;
  }
  getOpenWorkspaceDetails(): OpenWorkspaceDetails | null {
    return this.openWorkspaceContext ? { ...this.openWorkspaceContext } : null;
  }
  async resolveRestoreTarget(workspaceId: string): Promise<RestoreTarget | null> {
    const workspace = (await this.index.read()).find((entry) => entry.id === workspaceId);
    if (!workspace) return null;
    const paths = resolveWorkspacePaths(this.root, workspace.directory);
    if (!paths || !await this.hasRequiredFiles(paths)) return null;
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      rootPath: paths.root,
      databasePath: paths.database,
      mediaPath: paths.media,
      manifestPath: paths.manifest,
      backupsPath: paths.backups
    };
  }
  async captureRestoreState(): Promise<WorkspaceManagerState> {
    return { workspaces: await this.index.read(), openWorkspaceContext: this.getOpenWorkspaceDetails() };
  }
  deactivateForRestore(workspaceId: string): void {
    if (this.openWorkspaceContext?.workspaceId === workspaceId) this.openWorkspaceContext = null;
  }
  async commitRestoredWorkspace(workspaceId: string, manifest: BackupManifest, schemaVersion: number, reopen: boolean): Promise<void> {
    const workspaces = await this.index.read();
    const previous = workspaces.find((entry) => entry.id === workspaceId);
    if (!previous) throw new Error("Restore target disappeared");
    const paths = resolveWorkspacePaths(this.root, previous.directory);
    if (!paths) throw new Error("Restore target path was denied");
    const restoredManifest = JSON.parse(await readFile(paths.manifest, "utf8")) as { originPersonId?: unknown };
    const originPersonId = restoredManifest.originPersonId === null || typeof restoredManifest.originPersonId === "string" ? restoredManifest.originPersonId : previous.originPersonId;
    const updated: WorkspaceSummary = {
      id: previous.id,
      name: manifest.workspaceName,
      directory: previous.directory,
      originPersonId,
      lastOpenedAt: reopen ? new Date().toISOString() : previous.lastOpenedAt,
      schemaVersion
    };
    await writeFile(paths.manifest, JSON.stringify(updated, null, 2));
    await this.index.write(workspaces.map((entry) => entry.id === workspaceId ? updated : entry));
    if (reopen) this.openWorkspaceContext = this.context(updated, paths);
  }
  async restoreManagerState(state: WorkspaceManagerState): Promise<void> {
    await this.index.write(state.workspaces);
    this.openWorkspaceContext = state.openWorkspaceContext ? { ...state.openWorkspaceContext } : null;
  }
  getAutomaticSnapshotRoot(): string { return join(this.root, ".restore-snapshots"); }
  private async createFiles(paths: WorkspacePaths, summary: WorkspaceSummary): Promise<void> {
    await mkdir(paths.root, { recursive: false }); await mkdir(paths.media); await mkdir(paths.backups);
    await writeFile(paths.manifest, JSON.stringify(summary, null, 2)); await writeFile(paths.database, "");
  }
  private async hasRequiredFiles(paths: WorkspacePaths): Promise<boolean> {
    try {
      const [root, manifest, database, media, backups] = await Promise.all([stat(paths.root), stat(paths.manifest), stat(paths.database), stat(paths.media), stat(paths.backups)]);
      return root.isDirectory() && manifest.isFile() && database.isFile() && media.isDirectory() && backups.isDirectory();
    } catch { return false; }
  }
  private context(summary: WorkspaceSummary, paths: WorkspacePaths): OpenWorkspaceDetails {
    return {
      workspaceId: summary.id,
      workspaceName: summary.name,
      directory: summary.directory,
      workspaceRoot: paths.root,
      databasePath: paths.database,
      mediaPath: paths.media,
      manifestPath: paths.manifest,
      backupsPath: paths.backups,
      appDataRoot: dirname(this.root)
    };
  }
}
