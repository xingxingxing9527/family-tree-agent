import { mkdir, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AppResult, WorkspacePaths, WorkspaceSummary } from "../../shared/contracts.js";
import { WorkspaceIndex } from "./workspace-index.js";
import { resolveWorkspacePaths } from "./workspace-paths.js";

const schemaVersion = 1;
const failure = <T>(code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "PATH_DENIED" | "INTERNAL", message: string, details?: unknown): AppResult<T> => ({ ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } });

export class WorkspaceManager {
  private readonly index: WorkspaceIndex;
  private openWorkspaceId: string | null = null;
  constructor(private readonly root: string) { this.index = new WorkspaceIndex(root); }
  async list(): Promise<AppResult<WorkspaceSummary[]>> { try { return { ok: true, value: await this.index.read() }; } catch { return failure("INTERNAL", "Unable to list workspaces"); } }
  async create(input: { name: string }): Promise<AppResult<WorkspaceSummary>> {
    const name = input.name.trim();
    if (!name) return failure("VALIDATION", "Workspace name is required", { field: "name" });
    const id = randomUUID(); const directory = randomUUID(); const paths = resolveWorkspacePaths(this.root, directory);
    if (!paths) return failure("PATH_DENIED", "Workspace directory was denied", { id });
    const summary: WorkspaceSummary = { id, name, directory, originPersonId: null, lastOpenedAt: null, schemaVersion };
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
      const updated = { ...workspace, lastOpenedAt: new Date().toISOString() }; await this.index.write(workspaces.map((entry) => entry.id === updated.id ? updated : entry));
      this.openWorkspaceId = updated.id; return { ok: true, value: updated };
    } catch { return failure("INTERNAL", "Unable to open workspace", { id: input.id }); }
  }
  async close(): Promise<AppResult<null>> { this.openWorkspaceId = null; return { ok: true, value: null }; }
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
}
