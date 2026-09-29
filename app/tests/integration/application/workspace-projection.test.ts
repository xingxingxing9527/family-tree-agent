import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";
import { WorkspaceQueryGateway } from "../../../src/main/ipc/query-ipc";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("workspace snapshot and tree projection", () => {
  it("returns one workspace-scoped snapshot and a real marriage FamilyUnion projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-projection-"));
    roots.push(root);
    const databasePath = join(root, "genealogy.sqlite");
    const workspaceId = "workspace-a";
    const database = openDatabase(databasePath);
    applyMigrations(database);
    const service = new FactCommandService(database, workspaceId);
    let sourceSequence = 0;
    const source = () => ({ sourceKey: `fixture-${++sourceSequence}`, title: "测试来源" });
    for (const person of [
      { id: "father", displayName: "张国强", gender: "male" as const },
      { id: "mother", displayName: "李秀兰", gender: "female" as const },
      { id: "child", displayName: "张敏", gender: "female" as const }
    ]) service.execute({ type: "person.create", draft: { ...person, workspaceId }, source: source() });
    service.execute({ type: "marriage.add", draft: { id: "marriage", workspaceId, spouseAId: "father", spouseBId: "mother", start: null }, source: source() });
    service.execute({ type: "parentChild.add", draft: { id: "father-child", workspaceId, parentId: "father", childId: "child", parentRole: "father" }, source: source() });
    service.execute({ type: "parentChild.add", draft: { id: "mother-child", workspaceId, parentId: "mother", childId: "child", parentRole: "mother" }, source: source() });
    database.close();

    const gateway = new WorkspaceQueryGateway({ getOpenWorkspaceContext: () => ({ workspaceId, databasePath }) });
    const snapshot = await gateway.workspaceSnapshot();
    expect(snapshot).toMatchObject({ ok: true, value: { workspaceId } });
    if (!snapshot.ok) throw new Error("snapshot failed");
    expect(new Set(snapshot.value.people.map((person) => person.id))).toEqual(new Set(["mother", "father", "child"]));
    expect(snapshot.value.sources).toEqual(expect.arrayContaining([expect.objectContaining({ title: "测试来源" })]));
    const projected = await gateway.projectTree({ view: "full", viewpointId: "father", collapseDepth: 8 });
    expect(projected).toMatchObject({ ok: true, value: { viewpointId: "father" } });
    if (!projected.ok) throw new Error("projection failed");
    expect(projected.value.topology.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "union", unionId: "marriage:marriage", display: expect.objectContaining({ marriageStatus: "active" }) }),
      expect.objectContaining({ kind: "person", personId: "child" })
    ]));
    expect(projected.value.labels.child).toBe("女儿");
    expect(projected.value.topology.edges).toHaveLength(3);
  });
});
