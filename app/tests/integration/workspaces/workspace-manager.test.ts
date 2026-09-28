import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
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

  it("creates the configured root before its first workspace", async () => {
    const { root, manager } = await createManager();
    await rm(root, { recursive: true });
    const created = await manager.create({ name: "First family" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceRoot = join(root, created.value.directory);
    await expect(readFile(join(workspaceRoot, "workspace.json"), "utf8")).resolves.toContain(created.value.id);
    await expect(readFile(join(workspaceRoot, "genealogy.sqlite"))).resolves.toBeInstanceOf(Buffer);
    expect((await stat(join(workspaceRoot, "media"))).isDirectory()).toBe(true);
    expect((await stat(join(workspaceRoot, "backups"))).isDirectory()).toBe(true);
  });

  it.each(["workspace.json", "genealogy.sqlite", "media", "backups"])("does not open an indexed workspace with a missing required %s", async (missingPath) => {
    const { root, manager } = await createManager();
    const created = await manager.create({ name: "Incomplete family" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await rm(join(root, created.value.directory, missingPath), { recursive: true, force: true });
    await expect(manager.open({ id: created.value.id })).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND", details: { id: created.value.id } } });
  });

  it("rejects an indexed directory that escapes the configured root", async () => {
    const { root, manager } = await createManager();
    await writeFile(join(root, "index.json"), JSON.stringify({ workspaces: [{
      id: "11111111-1111-4111-8111-111111111111", name: "Unsafe", directory: "..", originPersonId: null, lastOpenedAt: null, schemaVersion: 1
    }] }));
    await expect(manager.open({ id: "11111111-1111-4111-8111-111111111111" })).resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
  });

  it("migrates the workspace database before marking it open", async () => {
    const { root, manager } = await createManager();
    const created = await manager.create({ name: "Migrated family" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const opened = await manager.open({ id: created.value.id });
    expect(opened.ok).toBe(true);
    const database = new Database(join(root, created.value.directory, "genealogy.sqlite"), { readonly: true });
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(2);
      expect(database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get()).toBe(2);
    } finally {
      database.close();
    }
  });

  it("provides main-only open database context until the workspace is closed", async () => {
    const { root, manager } = await createManager();
    const created = await manager.create({ name: "Facts family" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(manager.getOpenWorkspaceContext()).toBeNull();
    await manager.open({ id: created.value.id });
    expect(manager.getOpenWorkspaceContext()).toEqual({
      workspaceId: created.value.id,
      databasePath: join(root, created.value.directory, "genealogy.sqlite")
    });

    await manager.close();
    expect(manager.getOpenWorkspaceContext()).toBeNull();
  });

  it("does not update workspace state when migration fails", async () => {
    const { root, manager } = await createManager();
    const created = await manager.create({ name: "Broken family" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const databasePath = join(root, created.value.directory, "genealogy.sqlite");
    const database = new Database(databasePath);
    database.exec("CREATE TABLE person (id TEXT PRIMARY KEY)");
    database.close();

    await expect(manager.open({ id: created.value.id })).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    const index = JSON.parse(await readFile(join(root, "index.json"), "utf8")) as { workspaces: Array<{ id: string; lastOpenedAt: string | null }> };
    expect(index.workspaces.find((workspace) => workspace.id === created.value.id)?.lastOpenedAt).toBeNull();
  });
});
