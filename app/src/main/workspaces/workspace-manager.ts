import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ZodError } from "zod";
import type { AppResult, WorkspacePaths, WorkspaceSummary } from "../../shared/contracts.js";
import type { BackupManifest } from "../application/backup/backup-manifest.js";
import type { RestoreTarget } from "../application/backup/restore-service.js";
import { applyMigrations, LATEST_SCHEMA_VERSION } from "../database/migrations/index.js";
import { openDatabase, type WorkspaceDatabase } from "../database/open-database.js";
import { WorkspaceIndex } from "./workspace-index.js";
import { resolveWorkspacePaths } from "./workspace-paths.js";
import { workspaceSummarySchema } from "./workspace-schema.js";

const failure = <T>(code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "PATH_DENIED" | "INTERNAL", message: string, details?: unknown): AppResult<T> => ({ ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } });

interface WorkspaceIndexStore {
  read(): Promise<WorkspaceSummary[]>;
  write(workspaces: WorkspaceSummary[]): Promise<void>;
}

export interface WorkspaceManagerOptions {
  index?: WorkspaceIndexStore;
  publishManifest?: (path: string, summary: WorkspaceSummary) => Promise<void>;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolveTail) => { release = resolveTail; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}

const lifecycleMutexes = new Map<string, AsyncMutex>();
const lifecycleMutex = (root: string): AsyncMutex => {
  const key = resolve(root).toLocaleLowerCase("en-US");
  const existing = lifecycleMutexes.get(key);
  if (existing) return existing;
  const created = new AsyncMutex();
  lifecycleMutexes.set(key, created);
  return created;
};

async function publishManifestAtomically(path: string, summary: WorkspaceSummary): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(workspaceSummarySchema.parse(summary), null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporaryPath, path);
  } finally { await rm(temporaryPath, { force: true }); }
}

class WorkspaceIdentityError extends Error {}

function sameWorkspaceExceptOrigin(left: WorkspaceSummary, right: WorkspaceSummary): boolean {
  const { originPersonId: _leftOrigin, ...leftStable } = left;
  const { originPersonId: _rightOrigin, ...rightStable } = right;
  return JSON.stringify(leftStable) === JSON.stringify(rightStable);
}

export interface OpenWorkspaceContext {
  workspaceId: string;
  databasePath: string;
  mediaPath: string;
}

export interface OpenWorkspaceDetails extends OpenWorkspaceContext {
  workspaceName: string;
  directory: string;
  originPersonId: string | null;
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
  private readonly index: WorkspaceIndexStore;
  private readonly publishManifest: (path: string, summary: WorkspaceSummary) => Promise<void>;
  private readonly lifecycle: AsyncMutex;
  private openWorkspaceContext: OpenWorkspaceDetails | null = null;

  constructor(private readonly root: string, options: WorkspaceManagerOptions = {}) {
    this.index = options.index ?? new WorkspaceIndex(root);
    this.publishManifest = options.publishManifest ?? publishManifestAtomically;
    this.lifecycle = lifecycleMutex(root);
  }

  async list(): Promise<AppResult<WorkspaceSummary[]>> {
    return this.lifecycle.run(async () => {
      try { return { ok: true, value: await this.index.read() }; }
      catch { return failure("INTERNAL", "Unable to list workspaces"); }
    });
  }

  async create(input: { name: string }): Promise<AppResult<WorkspaceSummary>> {
    const name = input.name.trim();
    if (!name) return failure("VALIDATION", "Workspace name is required", { field: "name" });
    const id = randomUUID();
    const directory = randomUUID();
    const paths = resolveWorkspacePaths(this.root, directory);
    if (!paths) return failure("PATH_DENIED", "Workspace directory was denied", { id });
    const parsedSummary = workspaceSummarySchema.safeParse({ id, name, directory, originPersonId: null, lastOpenedAt: null, schemaVersion: LATEST_SCHEMA_VERSION });
    if (!parsedSummary.success) return failure("VALIDATION", "Workspace name is invalid", { field: "name" });
    const summary = parsedSummary.data;
    return this.lifecycle.run(async () => {
      let createdDirectory = false;
      try {
        await mkdir(this.root, { recursive: true });
        const previous = await this.index.read();
        await this.createFiles(paths, summary);
        createdDirectory = true;
        const next = [...previous, summary];
        try { await this.index.write(next); }
        catch (error) {
          if (await this.indexMatches(next)) return { ok: true, value: summary };
          if (!await this.recoverIndex(previous)) throw error;
          await rm(paths.root, { recursive: true, force: true });
          createdDirectory = false;
          throw error;
        }
        return { ok: true, value: summary };
      } catch {
        if (createdDirectory) await rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
        return failure("INTERNAL", "Unable to create workspace", { id });
      }
    });
  }

  async open(input: { id: string }): Promise<AppResult<WorkspaceSummary>> {
    return this.lifecycle.run(async () => {
      try {
        const workspaces = await this.index.read();
        const workspace = workspaces.find((entry) => entry.id === input.id);
        if (!workspace) return failure("NOT_FOUND", "Workspace was not found", { id: input.id });
        const paths = resolveWorkspacePaths(this.root, workspace.directory);
        if (!paths) return failure("PATH_DENIED", "Workspace directory was denied", { id: input.id });
        if (!await this.hasRequiredFiles(paths)) return failure("NOT_FOUND", "Workspace files were not found", { id: input.id });
        const persisted = await this.readManifest(paths.manifest);
        if (!persisted || !sameWorkspaceExceptOrigin(persisted, workspace)) {
          return failure("PATH_DENIED", "Workspace manifest did not match its index entry", { id: input.id });
        }
        const database = openDatabase(paths.database);
        let migratedVersion: number;
        let originPersonId: string | null;
        try {
          migratedVersion = applyMigrations(database);
          originPersonId = this.validateOrInitializeDatabaseIdentity(database, workspace, persisted);
        } finally { database.close(); }
        let publishedWorkspace = workspace;
        let publishedWorkspaces = workspaces;
        if (workspace.originPersonId !== originPersonId || persisted.originPersonId !== originPersonId) {
          publishedWorkspace = workspaceSummarySchema.parse({ ...workspace, originPersonId });
          publishedWorkspaces = workspaces.map((entry) => entry.id === publishedWorkspace.id ? publishedWorkspace : entry);
          if (!await this.publishAuthoritativeOriginPair(paths.manifest, publishedWorkspace, publishedWorkspaces)) {
            throw new Error("Workspace origin metadata publication is pending");
          }
        }
        const updated = workspaceSummarySchema.parse({ ...publishedWorkspace, schemaVersion: migratedVersion, lastOpenedAt: new Date().toISOString() });
        const next = publishedWorkspaces.map((entry) => entry.id === updated.id ? updated : entry);
        await this.publishExistingPair(paths.manifest, publishedWorkspace, publishedWorkspaces, updated, next);
        this.openWorkspaceContext = this.context(updated, paths);
        return { ok: true, value: updated };
      } catch (error) {
        return failure(error instanceof ZodError || error instanceof WorkspaceIdentityError ? "PATH_DENIED" : "INTERNAL", "Unable to open workspace", { id: input.id });
      }
    });
  }

  async close(): Promise<AppResult<null>> {
    return this.lifecycle.run(async () => { this.openWorkspaceContext = null; return { ok: true, value: null }; });
  }

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

  async synchronizeOriginPerson(): Promise<void> {
    await this.lifecycle.run(async () => {
      const context = this.openWorkspaceContext;
      if (!context) return;
      const database = openDatabase(context.databasePath);
      let originPersonId: string | null;
      try {
        const identity = this.readDatabaseIdentity(database, context.workspaceId);
        if (!identity || identity.name !== context.workspaceName) throw new WorkspaceIdentityError("Workspace database identity is inconsistent");
        originPersonId = identity.originPersonId;
        this.validateOrigin(database, context.workspaceId, originPersonId);
      } finally { database.close(); }
      this.openWorkspaceContext = { ...context, originPersonId };
      try {
        const workspaces = await this.index.read();
        const workspace = workspaces.find((entry) => entry.id === context.workspaceId);
        if (!workspace) throw new WorkspaceIdentityError("Open workspace is missing from the index");
        const paths = resolveWorkspacePaths(this.root, workspace.directory);
        if (!paths) throw new WorkspaceIdentityError("Open workspace path is invalid");
        const persisted = await this.readManifest(paths.manifest);
        if (!persisted || !sameWorkspaceExceptOrigin(persisted, workspace)) throw new WorkspaceIdentityError("Workspace metadata is inconsistent");
        if (workspace.originPersonId === originPersonId && persisted.originPersonId === originPersonId) return;
        const updated = workspaceSummarySchema.parse({ ...workspace, originPersonId });
        const next = workspaces.map((entry) => entry.id === updated.id ? updated : entry);
        await this.publishAuthoritativeOriginPair(paths.manifest, updated, next);
      } catch (error) {
        if (error instanceof WorkspaceIdentityError || error instanceof ZodError) throw error;
        // The committed database value is the durable recovery intent. A later sync/open retries publication.
      }
    });
  }

  async resolveRestoreTarget(workspaceId: string): Promise<RestoreTarget | null> {
    return this.lifecycle.run(async () => {
      const workspace = (await this.index.read()).find((entry) => entry.id === workspaceId);
      if (!workspace) return null;
      const paths = resolveWorkspacePaths(this.root, workspace.directory);
      if (!paths || !await this.hasRequiredFiles(paths)) return null;
      return {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        directory: workspace.directory,
        originPersonId: workspace.originPersonId,
        rootPath: paths.root,
        databasePath: paths.database,
        mediaPath: paths.media,
        manifestPath: paths.manifest,
        backupsPath: paths.backups
      };
    });
  }

  async captureRestoreState(): Promise<WorkspaceManagerState> {
    return this.lifecycle.run(async () => ({ workspaces: await this.index.read(), openWorkspaceContext: this.getOpenWorkspaceDetails() }));
  }

  async deactivateForRestore(workspaceId: string): Promise<void> {
    await this.lifecycle.run(async () => {
      if (this.openWorkspaceContext?.workspaceId === workspaceId) this.openWorkspaceContext = null;
    });
  }

  async commitRestoredWorkspace(workspaceId: string, manifest: BackupManifest, schemaVersion: number, reopen: boolean): Promise<void> {
    await this.lifecycle.run(async () => {
      const workspaces = await this.index.read();
      const previous = workspaces.find((entry) => entry.id === workspaceId);
      if (!previous) throw new Error("Restore target disappeared");
      const paths = resolveWorkspacePaths(this.root, previous.directory);
      if (!paths) throw new Error("Restore target path was denied");
      const restoredManifest = await this.readManifest(paths.manifest);
      if (
        !restoredManifest || restoredManifest.id !== workspaceId || restoredManifest.directory !== previous.directory || restoredManifest.name !== manifest.workspaceName ||
        restoredManifest.schemaVersion !== schemaVersion || restoredManifest.originPersonId === null
      ) throw new Error("Restored workspace manifest is inconsistent");
      const database = openDatabase(paths.database);
      try {
        const identity = this.readDatabaseIdentity(database, workspaceId);
        if (!identity || identity.name !== restoredManifest.name || identity.originPersonId !== restoredManifest.originPersonId) throw new Error("Restored workspace identity is inconsistent");
        this.validateOrigin(database, workspaceId, restoredManifest.originPersonId);
      } finally { database.close(); }
      const updated: WorkspaceSummary = workspaceSummarySchema.parse({
        id: previous.id,
        name: manifest.workspaceName,
        directory: previous.directory,
        originPersonId: restoredManifest.originPersonId,
        lastOpenedAt: reopen ? new Date().toISOString() : previous.lastOpenedAt,
        schemaVersion
      });
      const next = workspaces.map((entry) => entry.id === workspaceId ? updated : entry);
      await this.publishExistingPair(paths.manifest, restoredManifest, workspaces, updated, next);
      if (reopen) this.openWorkspaceContext = this.context(updated, paths);
    });
  }

  async restoreManagerState(state: WorkspaceManagerState): Promise<void> {
    await this.lifecycle.run(async () => {
      await this.index.write(state.workspaces);
      this.openWorkspaceContext = state.openWorkspaceContext ? { ...state.openWorkspaceContext } : null;
    });
  }

  getAutomaticSnapshotRoot(): string { return join(this.root, ".restore-snapshots"); }

  private async createFiles(paths: WorkspacePaths, summary: WorkspaceSummary): Promise<void> {
    try {
      await mkdir(paths.root, { recursive: false });
      await mkdir(paths.media);
      await mkdir(paths.backups);
      await this.publishManifest(paths.manifest, summary);
      await writeFile(paths.database, "", { flag: "wx" });
    } catch (error) {
      await rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async publishExistingPair(
    manifestPath: string,
    previousManifest: WorkspaceSummary,
    previousIndex: WorkspaceSummary[],
    nextManifest: WorkspaceSummary,
    nextIndex: WorkspaceSummary[]
  ): Promise<void> {
    try {
      await this.publishManifest(manifestPath, nextManifest);
      await this.index.write(nextIndex);
      return;
    } catch (error) {
      if (await this.pairMatches(manifestPath, nextManifest, nextIndex)) return;
      if (await this.recoverPair(manifestPath, previousManifest, previousIndex)) throw error;
      if (await this.recoverPair(manifestPath, nextManifest, nextIndex)) return;
      throw error;
    }
  }

  private async publishAuthoritativeOriginPair(manifestPath: string, manifest: WorkspaceSummary, workspaces: WorkspaceSummary[]): Promise<boolean> {
    if (await this.recoverPair(manifestPath, manifest, workspaces)) return true;
    return this.recoverPair(manifestPath, manifest, workspaces);
  }

  private async recoverPair(manifestPath: string, manifest: WorkspaceSummary, workspaces: WorkspaceSummary[]): Promise<boolean> {
    if (!await this.manifestMatches(manifestPath, manifest)) await this.publishManifest(manifestPath, manifest).catch(() => undefined);
    if (!await this.indexMatches(workspaces)) await this.index.write(workspaces).catch(() => undefined);
    return this.pairMatches(manifestPath, manifest, workspaces);
  }

  private async pairMatches(manifestPath: string, manifest: WorkspaceSummary, workspaces: WorkspaceSummary[]): Promise<boolean> {
    return await this.manifestMatches(manifestPath, manifest) && await this.indexMatches(workspaces);
  }

  private async manifestMatches(path: string, expected: WorkspaceSummary): Promise<boolean> {
    const actual = await this.readManifest(path).catch(() => null);
    return actual !== null && JSON.stringify(actual) === JSON.stringify(expected);
  }

  private async indexMatches(expected: WorkspaceSummary[]): Promise<boolean> {
    const actual = await this.index.read().catch(() => null);
    return actual !== null && JSON.stringify(actual) === JSON.stringify(expected);
  }

  private async recoverIndex(expected: WorkspaceSummary[]): Promise<boolean> {
    if (await this.indexMatches(expected)) return true;
    await this.index.write(expected).catch(() => undefined);
    return this.indexMatches(expected);
  }

  private async readManifest(path: string): Promise<WorkspaceSummary | null> {
    const parsed = workspaceSummarySchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  }

  private validateOrInitializeDatabaseIdentity(database: WorkspaceDatabase, workspace: WorkspaceSummary, manifest: WorkspaceSummary): string | null {
    const identity = this.readDatabaseIdentity(database, workspace.id);
    if (!identity) {
      if (manifest.originPersonId !== workspace.originPersonId) throw new WorkspaceIdentityError("Workspace origin metadata has no database authority");
      this.validateOrigin(database, workspace.id, workspace.originPersonId);
      const now = new Date().toISOString();
      database.prepare("INSERT INTO workspace_meta (workspace_id, name, origin_person_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(workspace.id, workspace.name, workspace.originPersonId, now, now);
      return workspace.originPersonId;
    }
    if (identity.name !== workspace.name) throw new WorkspaceIdentityError("Workspace database identity does not match its metadata");
    this.validateOrigin(database, workspace.id, identity.originPersonId);
    return identity.originPersonId;
  }

  private readDatabaseIdentity(database: WorkspaceDatabase, workspaceId: string): { name: string; originPersonId: string | null } | null {
    const rows = database.prepare("SELECT workspace_id, name, origin_person_id FROM workspace_meta").all() as Array<{ workspace_id: string; name: string; origin_person_id: string | null }>;
    if (rows.length === 0) return null;
    if (rows.length !== 1 || rows[0]?.workspace_id !== workspaceId) throw new WorkspaceIdentityError("Workspace database identity is invalid");
    return { name: rows[0].name, originPersonId: rows[0].origin_person_id };
  }

  private validateOrigin(database: WorkspaceDatabase, workspaceId: string, originPersonId: string | null): void {
    if (originPersonId === null) {
      const activePeople = Number(database.prepare("SELECT COUNT(*) FROM person WHERE workspace_id=? AND deleted_at IS NULL").pluck().get(workspaceId));
      if (activePeople !== 0) throw new WorkspaceIdentityError("A non-empty workspace must have an origin person");
      return;
    }
    const origin = database.prepare("SELECT 1 FROM person WHERE id=? AND workspace_id=? AND deleted_at IS NULL").get(originPersonId, workspaceId);
    if (!origin) throw new WorkspaceIdentityError("Workspace origin person is missing or archived");
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
      originPersonId: summary.originPersonId,
      workspaceRoot: paths.root,
      databasePath: paths.database,
      mediaPath: paths.media,
      manifestPath: paths.manifest,
      backupsPath: paths.backups,
      appDataRoot: dirname(this.root)
    };
  }
}
