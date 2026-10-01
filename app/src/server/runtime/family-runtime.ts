import { join } from "node:path";
import type { AppResult, WorkspaceSummary } from "../../shared/contracts.js";
import { WorkspaceManager } from "../../main/workspaces/workspace-manager.js";
import { WorkspaceMutationGate } from "../../main/workspaces/workspace-mutation-gate.js";

const conflict = <T>(message: string): AppResult<T> => ({
  ok: false,
  error: { code: "CONFLICT", message }
});

export interface FamilyRuntimeOptions {
  dataRoot: string;
}

export interface FamilyRuntime {
  readonly workspaceManager: WorkspaceManager;
  readonly mutationGate: WorkspaceMutationGate;
  listFamilies(): Promise<AppResult<WorkspaceSummary[]>>;
  createFamily(name: string): Promise<AppResult<WorkspaceSummary>>;
  openFamily(id: string): Promise<AppResult<WorkspaceSummary>>;
  closeFamily(): Promise<AppResult<null>>;
  dispose(): Promise<void>;
}

class SingleFamilyRuntime implements FamilyRuntime {
  readonly workspaceManager: WorkspaceManager;
  readonly mutationGate = new WorkspaceMutationGate();
  private disposed = false;

  constructor(dataRoot: string) {
    this.workspaceManager = new WorkspaceManager(join(dataRoot, "workspaces"));
  }

  async initialize(): Promise<void> {
    const listed = await this.workspaceManager.list();
    if (!listed.ok) throw new Error(listed.error.message);
    if (listed.value.length > 1) throw new Error("Single-family runtime found multiple workspaces");
    const existing = listed.value[0];
    if (!existing) return;
    const opened = await this.workspaceManager.open({ id: existing.id });
    if (!opened.ok) throw new Error(opened.error.message);
  }

  listFamilies(): Promise<AppResult<WorkspaceSummary[]>> {
    return this.workspaceManager.list();
  }

  async createFamily(name: string): Promise<AppResult<WorkspaceSummary>> {
    const lease = await this.mutationGate.acquireExclusive();
    try {
      const listed = await this.workspaceManager.list();
      if (!listed.ok) return listed;
      if (listed.value.length > 0) return conflict("首版仅支持一个家族");
      const created = await this.workspaceManager.create({ name });
      if (!created.ok) return created;
      return this.workspaceManager.open({ id: created.value.id });
    } finally {
      lease.release();
    }
  }

  openFamily(id: string): Promise<AppResult<WorkspaceSummary>> {
    return this.mutationGate.runOperation(() => this.workspaceManager.open({ id }));
  }

  closeFamily(): Promise<AppResult<null>> {
    return this.mutationGate.runOperation(() => this.workspaceManager.close());
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.workspaceManager.close();
  }
}

export async function createFamilyRuntime(options: FamilyRuntimeOptions): Promise<FamilyRuntime> {
  const runtime = new SingleFamilyRuntime(options.dataRoot);
  await runtime.initialize();
  return runtime;
}
