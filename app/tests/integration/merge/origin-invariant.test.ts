import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceFactsGateway } from "../../../src/main/application/facts/facts-gateway";
import { openDatabase } from "../../../src/main/database/open-database";
import { WorkspaceMergeGateway } from "../../../src/main/ipc/merge-ipc";
import { WorkspaceManager } from "../../../src/main/workspaces/workspace-manager";

describe("workspace origin-person invariant", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("publishes the database origin through first save, merge, and unmerge", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-origin-"));
    roots.push(root);
    const manager = new WorkspaceManager(join(root, "workspaces"));
    const created = await manager.create({ name: "Origin invariant" });
    if (!created.ok) throw new Error("workspace fixture failed");
    await manager.open({ id: created.value.id });
    const facts = new WorkspaceFactsGateway(manager);
    const save = (displayName: string) => facts.savePerson({
      draft: { displayName, aliases: [], gender: "unknown" as const, birth: null, death: null, notes: null, sourceDescription: "test" },
      confirmWarnings: true
    });
    const first = await save("First");
    const second = await save("Second");
    if (!first.ok || !first.value.entityId || !second.ok || !second.value.entityId) throw new Error("person fixture failed");
    await expectOrigin(manager, created.value.id, first.value.entityId);

    const merges = new WorkspaceMergeGateway(manager);
    const preview = await merges.preview({ primaryPersonId: second.value.entityId, secondaryPersonId: first.value.entityId });
    if (!preview.ok) throw new Error("merge preview failed");
    const merged = await merges.merge({
      primaryPersonId: second.value.entityId,
      secondaryPersonId: first.value.entityId,
      scalarChoices: {},
      expectedVersions: preview.value.expectedVersions
    });
    if (!merged.ok) throw new Error("merge failed");
    await expectOrigin(manager, created.value.id, second.value.entityId);

    await expect(merges.unmerge({ mergeId: merged.value.id })).resolves.toMatchObject({ ok: true });
    await expectOrigin(manager, created.value.id, first.value.entityId);
  });

  async function expectOrigin(manager: WorkspaceManager, workspaceId: string, personId: string): Promise<void> {
    const details = manager.getOpenWorkspaceDetails();
    if (!details) throw new Error("workspace is not open");
    const database = openDatabase(details.databasePath);
    try {
      expect(database.prepare("SELECT origin_person_id FROM workspace_meta WHERE workspace_id=?").pluck().get(workspaceId)).toBe(personId);
    } finally { database.close(); }
    const listed = await manager.list();
    expect(listed.ok && listed.value.find((entry) => entry.id === workspaceId)?.originPersonId).toBe(personId);
    expect(JSON.parse(await readFile(details.manifestPath, "utf8")).originPersonId).toBe(personId);
  }
});
