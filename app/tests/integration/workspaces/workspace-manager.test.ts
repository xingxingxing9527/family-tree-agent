import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { WorkspaceFactsGateway } from "../../../src/main/application/facts/facts-gateway";
import { WorkspaceManager } from "../../../src/main/workspaces/workspace-manager";
import { WorkspaceIndex } from "../../../src/main/workspaces/workspace-index";

describe("WorkspaceManager", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  async function createManager(): Promise<{ root: string; manager: WorkspaceManager }> {
    const root = await mkdtemp(join(tmpdir(), "family-agent-workspaces-"));
    roots.push(root);
    return { root, manager: new WorkspaceManager(root) };
  }

  function managerWithStorage(root: string, options: {
    index?: Pick<WorkspaceIndex, "read" | "write">;
    publishManifest?: (path: string, summary: unknown) => Promise<void>;
  }): WorkspaceManager {
    const Constructor = WorkspaceManager as unknown as new (workspaceRoot: string, storage: typeof options) => WorkspaceManager;
    return new Constructor(root, options);
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

  it("serializes concurrent creates so every successful workspace remains listed and openable", async () => {
    const { manager } = await createManager();
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) => manager.create({ name: `Family ${index}` })));
    expect(created.every((result) => result.ok)).toBe(true);
    const listed = await manager.list();
    expect(listed.ok && listed.value).toHaveLength(12);
    if (!listed.ok) return;
    for (const workspace of listed.value) await expect(manager.open({ id: workspace.id })).resolves.toMatchObject({ ok: true });
  });

  it("serializes concurrent opens without losing either manifest/index update", async () => {
    const { root, manager } = await createManager();
    const first = await manager.create({ name: "First" });
    const second = await manager.create({ name: "Second" });
    if (!first.ok || !second.ok) throw new Error("workspace fixture failed");
    const opened = await Promise.all([manager.open({ id: first.value.id }), manager.open({ id: second.value.id })]);
    expect(opened.every((result) => result.ok)).toBe(true);
    const index = await new WorkspaceIndex(root).read();
    expect(index.find((entry) => entry.id === first.value.id)?.lastOpenedAt).toEqual(expect.any(String));
    expect(index.find((entry) => entry.id === second.value.id)?.lastOpenedAt).toEqual(expect.any(String));
    for (const workspace of index) {
      expect(JSON.parse(await readFile(join(root, workspace.directory, "workspace.json"), "utf8"))).toEqual(workspace);
    }
  });

  it("removes a newly created directory when index publication fails", async () => {
    const { root } = await createManager();
    const realIndex = new WorkspaceIndex(root);
    const manager = managerWithStorage(root, {
      index: { read: () => realIndex.read(), write: async () => { throw new Error("injected index failure"); } }
    });
    await expect(manager.create({ name: "Must roll back" })).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    await expect(realIndex.read()).resolves.toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("restores the prior manifest when index publication fails after an open update", async () => {
    const { root, manager: setup } = await createManager();
    const created = await setup.create({ name: "Publication family" });
    if (!created.ok) throw new Error("workspace fixture failed");
    const manifestPath = join(root, created.value.directory, "workspace.json");
    const indexPath = join(root, "index.json");
    const beforeManifest = await readFile(manifestPath, "utf8");
    const beforeIndex = await readFile(indexPath, "utf8");
    const realIndex = new WorkspaceIndex(root);
    const manager = managerWithStorage(root, {
      index: { read: () => realIndex.read(), write: async () => { throw new Error("injected index failure"); } }
    });

    await expect(manager.open({ id: created.value.id })).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(await readFile(manifestPath, "utf8")).toBe(beforeManifest);
    expect(await readFile(indexPath, "utf8")).toBe(beforeIndex);
  });

  it("leaves the index and manifest unchanged when manifest publication fails", async () => {
    const { root, manager: setup } = await createManager();
    const created = await setup.create({ name: "Manifest failure family" });
    if (!created.ok) throw new Error("workspace fixture failed");
    const manifestPath = join(root, created.value.directory, "workspace.json");
    const indexPath = join(root, "index.json");
    const beforeManifest = await readFile(manifestPath, "utf8");
    const beforeIndex = await readFile(indexPath, "utf8");
    const manager = managerWithStorage(root, { publishManifest: async () => { throw new Error("injected manifest failure"); } });

    await expect(manager.open({ id: created.value.id })).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(await readFile(manifestPath, "utf8")).toBe(beforeManifest);
    expect(await readFile(indexPath, "utf8")).toBe(beforeIndex);
  });

  it("validates a new workspace with the shared strict schema before creating files", async () => {
    const { root, manager } = await createManager();
    await expect(manager.create({ name: "x".repeat(201) })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(await readdir(root)).toEqual([]);
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
      expect(database.pragma("user_version", { simple: true })).toBe(5);
      expect(database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get()).toBe(5);
    } finally {
      database.close();
    }
  });

  it("refuses to open an existing workspace with more than 1,000 active people", async () => {
    const { root, manager } = await createManager();
    const created = await manager.create({ name: "Over-cap family" });
    if (!created.ok) throw new Error("workspace fixture failed");
    await expect(manager.open({ id: created.value.id })).resolves.toMatchObject({ ok: true });
    await expect(new WorkspaceFactsGateway(manager).savePerson({
      draft: { displayName: "起始人物", aliases: [], gender: "unknown", birth: null, death: null, notes: null, sourceDescription: "test" },
      confirmWarnings: true
    })).resolves.toMatchObject({ ok: true });
    await manager.close();

    const database = new Database(join(root, created.value.directory, "genealogy.sqlite"));
    const now = new Date().toISOString();
    const insert = database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, ?, ?, 'unknown', ?, ?)");
    database.transaction(() => {
      for (let index = 1; index < 1_001; index += 1) insert.run(`person-${index}`, created.value.id, `成员 ${index}`, now, now);
    })();
    database.close();

    await expect(manager.open({ id: created.value.id })).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION", message: expect.stringMatching(/1,?000|上限/u) }
    });
    expect(manager.getOpenWorkspaceContext()).toBeNull();
  });

  it("provides main-only open database context until the workspace is closed", async () => {
    const { root, manager } = await createManager();
    const created = await manager.create({ name: "Facts family" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(manager.getOpenWorkspaceContext()).toBeNull();
    await manager.open({ id: created.value.id });
    const firstContext = manager.getOpenWorkspaceContext();
    expect(firstContext).toEqual({
      workspaceId: created.value.id,
      databasePath: join(root, created.value.directory, "genealogy.sqlite"),
      mediaPath: join(root, created.value.directory, "media"),
      openContextId: expect.stringMatching(/^[0-9a-f-]{36}$/u)
    });

    await manager.close();
    expect(manager.getOpenWorkspaceContext()).toBeNull();
    await manager.open({ id: created.value.id });
    expect(manager.getOpenWorkspaceContext()?.openContextId).not.toBe(firstContext?.openContextId);
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

  it("recovers stale origin metadata from the authoritative database on a fresh open", async () => {
    const { root, manager } = await createManager();
    const created = await manager.create({ name: "Origin family" });
    if (!created.ok) throw new Error("workspace fixture failed");
    await manager.open({ id: created.value.id });
    const databasePath = join(root, created.value.directory, "genealogy.sqlite");
    const database = new Database(databasePath);
    const personId = "33333333-3333-4333-8333-333333333333";
    const now = new Date().toISOString();
    database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, ?, 'Origin', 'unknown', ?, ?)").run(personId, created.value.id, now, now);
    database.prepare("UPDATE workspace_meta SET origin_person_id=? WHERE workspace_id=?").run(personId, created.value.id);
    database.close();
    await manager.close();

    await expect(manager.open({ id: created.value.id })).resolves.toMatchObject({ ok: true, value: { originPersonId: personId } });
    const verified = new Database(databasePath, { readonly: true });
    expect(verified.prepare("SELECT origin_person_id FROM workspace_meta WHERE workspace_id=?").pluck().get(created.value.id)).toBe(personId);
    verified.close();
    const index = await new WorkspaceIndex(root).read();
    expect(index.find((entry) => entry.id === created.value.id)?.originPersonId).toBe(personId);
    expect(JSON.parse(await readFile(join(root, created.value.directory, "workspace.json"), "utf8")).originPersonId).toBe(personId);
  });

  it.each([
    ["one-shot index", "index", 1],
    ["persistent index", "index", Number.POSITIVE_INFINITY],
    ["one-shot manifest", "manifest", 1],
    ["persistent manifest", "manifest", Number.POSITIVE_INFINITY]
  ] as const)("keeps a committed first-person save successful through %s origin publication failure and recovers on open", async (_case, destination, failures) => {
    const { root } = await createManager();
    const realIndex = new WorkspaceIndex(root);
    let remainingFailures = failures;
    const manager = managerWithStorage(root, destination === "index" ? {
      index: {
        read: () => realIndex.read(),
        write: async (workspaces) => {
          if (remainingFailures > 0) {
            remainingFailures -= 1;
            throw new Error("injected origin index publication failure");
          }
          await realIndex.write(workspaces);
        }
      }
    } : {
      publishManifest: async (path, summary) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("injected origin manifest publication failure");
        }
        await writeFile(path, JSON.stringify(summary, null, 2));
      }
    });
    remainingFailures = 0;
    const created = await manager.create({ name: "Recoverable origin" });
    if (!created.ok) throw new Error("workspace fixture failed");
    await manager.open({ id: created.value.id });
    remainingFailures = failures;
    const saved = await new WorkspaceFactsGateway(manager).savePerson({
      draft: { displayName: "Committed origin", aliases: [], gender: "unknown", birth: null, death: null, notes: null, sourceDescription: "test" },
      confirmWarnings: true
    });
    expect(saved).toMatchObject({ ok: true, value: { saved: true, entityId: expect.any(String) } });
    if (!saved.ok || !saved.value.entityId) throw new Error("person save failed");
    const database = new Database(join(root, created.value.directory, "genealogy.sqlite"), { readonly: true });
    expect(database.prepare("SELECT origin_person_id FROM workspace_meta WHERE workspace_id=?").pluck().get(created.value.id)).toBe(saved.value.entityId);
    database.close();

    const reopened = await new WorkspaceManager(root).open({ id: created.value.id });
    expect(reopened).toMatchObject({ ok: true, value: { originPersonId: saved.value.entityId } });
  });

  it("validates the complete workspace index before atomically publishing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-workspaces-"));
    roots.push(root);
    const index = new WorkspaceIndex(root);
    const valid = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Valid family",
      directory: "22222222-2222-4222-8222-222222222222",
      originPersonId: null,
      lastOpenedAt: null,
      schemaVersion: 4
    };
    await index.write([valid]);

    await expect(index.write([{ ...valid, id: "not-a-uuid", directory: "opaque" }])).rejects.toThrow();
    await expect(index.read()).resolves.toEqual([valid]);
  });

  it("serializes cross-instance index publications in invocation order", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-workspaces-"));
    roots.push(root);
    const firstPublisher = new WorkspaceIndex(root);
    const secondPublisher = new WorkspaceIndex(root);
    const summary = (ordinal: number) => ({
      id: `${ordinal}1111111-1111-4111-8111-111111111111`,
      name: `Family ${ordinal}`,
      directory: `${ordinal}2222222-2222-4222-8222-222222222222`,
      originPersonId: null,
      lastOpenedAt: null,
      schemaVersion: 4
    });
    const first = summary(1);
    const second = summary(2);
    await expect(Promise.all([firstPublisher.write([first]), secondPublisher.write([second])])).resolves.toEqual([undefined, undefined]);
    expect(await firstPublisher.read()).toEqual([second]);
    expect((await readdir(root)).filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });

  it("rejects a workspace whose persisted manifest is not the same strict summary as its index entry", async () => {
    const { root, manager } = await createManager();
    const created = await manager.create({ name: "Bound family" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const manifestPath = join(root, created.value.directory, "workspace.json");
    const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, JSON.stringify({
      ...persisted,
      directory: "33333333-3333-4333-8333-333333333333",
      unexpected: true
    }));

    await expect(manager.open({ id: created.value.id })).resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
    expect(manager.getOpenWorkspaceContext()).toBeNull();
  });
});
