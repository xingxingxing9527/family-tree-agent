import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkspaceSummary } from "../../shared/contracts.js";
import { workspaceIndexSchema } from "./workspace-schema.js";

class AsyncWriteMutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}

const writeMutexes = new Map<string, AsyncWriteMutex>();
const mutexFor = (root: string): AsyncWriteMutex => {
  const key = resolve(root).toLocaleLowerCase("en-US");
  const current = writeMutexes.get(key);
  if (current) return current;
  const created = new AsyncWriteMutex();
  writeMutexes.set(key, created);
  return created;
};

export class WorkspaceIndex {
  readonly filePath: string;
  constructor(private readonly root: string) { this.filePath = join(root, "index.json"); }
  async read(): Promise<WorkspaceSummary[]> {
    try { return workspaceIndexSchema.parse(JSON.parse(await readFile(this.filePath, "utf8"))).workspaces; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async write(workspaces: WorkspaceSummary[]): Promise<void> {
    await mutexFor(this.root).run(async () => {
      const validated = workspaceIndexSchema.parse({ workspaces });
      await mkdir(this.root, { recursive: true });
      const temporaryPath = join(this.root, `.index.${randomUUID()}.tmp`);
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(validated, null, 2)); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporaryPath, this.filePath);
      } finally { await rm(temporaryPath, { force: true }); }
    });
  }
}
