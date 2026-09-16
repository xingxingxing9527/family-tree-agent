import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../../../src/main/workspaces/workspace-manager";

describe("WorkspaceManager", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  async function createManager(): Promise<{ root: string; manager: WorkspaceManager }> {
    const root = await mkdtemp(join(tmpdir(), "family-agent-workspaces-"));
    roots.push(root);
    return { root, manager: new WorkspaceManager(root) };
  }

  it("creates isolated UUID workspace directories with their required resources", async () => {
    const { root, manager } = await createManager();
    const first = await manager.create({ name: "First family" });
    const second = await manager.create({ name: "Second family" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.directory).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second.value.directory).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.value.directory).not.toBe(second.value.directory);
    for (const summary of [first.value, second.value]) {
      const workspaceRoot = join(root, summary.directory);
      await expect(readFile(join(workspaceRoot, "workspace.json"), "utf8")).resolves.toContain(summary.id);
      await expect(readFile(join(workspaceRoot, "genealogy.sqlite"))).resolves.toBeInstanceOf(Buffer);
      expect((await stat(join(workspaceRoot, "media"))).isDirectory()).toBe(true);
      expect((await stat(join(workspaceRoot, "backups"))).isDirectory()).toBe(true);
      expect(relative(root, workspaceRoot).startsWith("..")).toBe(false);
    }
  });

  it("rejects an indexed directory that escapes the configured root", async () => {
    const { root, manager } = await createManager();
    await writeFile(join(root, "index.json"), JSON.stringify({ workspaces: [{
      id: "11111111-1111-4111-8111-111111111111", name: "Unsafe", directory: "..", originPersonId: null, lastOpenedAt: null, schemaVersion: 1
    }] }));
    await expect(manager.open({ id: "11111111-1111-4111-8111-111111111111" })).resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
  });
});
