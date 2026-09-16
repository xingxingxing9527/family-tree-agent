import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { WorkspaceSummary } from "../../shared/contracts.js";

const summarySchema = z.object({ id: z.string().uuid(), name: z.string(), directory: z.string(), originPersonId: z.string().uuid().nullable(), lastOpenedAt: z.string().datetime().nullable(), schemaVersion: z.number().int().positive() });
const indexSchema = z.object({ workspaces: z.array(summarySchema) });

export class WorkspaceIndex {
  readonly filePath: string;
  private readonly temporaryPath: string;
  constructor(private readonly root: string) { this.filePath = join(root, "index.json"); this.temporaryPath = join(root, "index.json.tmp"); }
  async read(): Promise<WorkspaceSummary[]> {
    try { return indexSchema.parse(JSON.parse(await readFile(this.filePath, "utf8"))).workspaces; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async write(workspaces: WorkspaceSummary[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const handle = await open(this.temporaryPath, "w");
    try { await handle.writeFile(JSON.stringify({ workspaces }, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(this.temporaryPath, this.filePath);
  }
}
