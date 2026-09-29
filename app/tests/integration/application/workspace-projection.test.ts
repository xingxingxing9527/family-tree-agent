import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { projectWorkspaceTree } from "../../../src/main/application/query/workspace-projection";
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
    service.execute({
      type: "marriage.add",
      draft: {
        id: "marriage",
        workspaceId,
        spouseAId: "father",
        spouseBId: "mother",
        start: { calendar: "solar", year: 1980, month: 1, day: null, leapMonth: false, precision: "month" }
      },
      source: source()
    });
    service.execute({
      type: "marriage.divorce",
      marriageId: "marriage",
      endDate: { calendar: "lunar", year: 1990, month: 2, day: 3, leapMonth: true, precision: "day" },
      expectedVersion: 1,
      source: source()
    });
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
      expect.objectContaining({
        kind: "union",
        unionId: "marriage:marriage",
        display: expect.objectContaining({
          marriageStatus: "divorced",
          marriageStart: { calendar: "solar", year: 1980, month: 1, day: null, leapMonth: false, precision: "month" },
          marriageEnd: { calendar: "lunar", year: 1990, month: 2, day: 3, leapMonth: true, precision: "day" }
        })
      }),
      expect.objectContaining({ kind: "person", personId: "child" })
    ]));
    expect(projected.value.labels.child).toBe("女儿");
    expect(projected.value.topology.edges).toHaveLength(3);
  });

  it("returns every person at exactly 1,000 and rejects an over-cap workspace without truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-projection-limit-"));
    roots.push(root);
    const databasePath = join(root, "genealogy.sqlite");
    const workspaceId = "workspace-limit";
    const database = openDatabase(databasePath);
    applyMigrations(database);
    const now = new Date().toISOString();
    const insert = database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, ?, ?, 'unknown', ?, ?)");
    database.transaction(() => {
      for (let index = 0; index < 1_000; index += 1) insert.run(`person-${index.toString().padStart(4, "0")}`, workspaceId, `成员 ${index}`, now, now);
    })();
    database.close();

    const gateway = new WorkspaceQueryGateway({ getOpenWorkspaceContext: () => ({ workspaceId, databasePath }) });
    const snapshot = await gateway.workspaceSnapshot();
    expect(snapshot).toMatchObject({ ok: true, value: { people: expect.any(Array) } });
    if (!snapshot.ok) throw new Error("snapshot failed at the supported limit");
    expect(snapshot.value.people).toHaveLength(1_000);
    expect(snapshot.value.people[0]?.id).toBe("person-0000");
    expect(snapshot.value.people.at(-1)?.id).toBe("person-0999");

    const tree = await gateway.projectTree({ view: "full", collapseDepth: 20 });
    expect(tree).toMatchObject({ ok: true });
    if (!tree.ok) throw new Error("tree failed at the supported limit");
    expect(tree.value.topology.nodes.filter((node) => node.kind === "person")).toHaveLength(1_000);

    const overCap = openDatabase(databasePath);
    overCap.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES ('person-1000', ?, '超限成员', 'unknown', ?, ?)")
      .run(workspaceId, now, now);
    overCap.close();

    await expect(gateway.workspaceSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION", message: expect.stringMatching(/1,?000|上限/u) }
    });
    await expect(gateway.projectTree({ view: "full", collapseDepth: 20 })).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION", message: expect.stringMatching(/1,?000|上限/u) }
    });
  });

  it("loads every lineage generation input in one bounded batch without changing declared-generation semantics", () => {
    let statements = 0;
    const database = new Database(":memory:", { verbose: () => { statements += 1; } });
    applyMigrations(database);
    const workspaceId = "workspace-lineages";
    const now = new Date().toISOString();
    const insertPerson = database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, ?, ?, 'unknown', ?, ?)");
    for (const [id, name] of [["founder-a", "甲祖"], ["child-a", "甲子"], ["founder-b", "乙祖"], ["child-b", "乙子"]]) {
      insertPerson.run(id, workspaceId, name, now, now);
    }
    const insertParent = database.prepare("INSERT INTO parent_child (id, workspace_id, parent_id, child_id, parent_role, created_at, updated_at) VALUES (?, ?, ?, ?, 'father', ?, ?)");
    insertParent.run("parent-a", workspaceId, "founder-a", "child-a", now, now);
    insertParent.run("parent-b", workspaceId, "founder-b", "child-b", now, now);
    const insertLineage = database.prepare("INSERT INTO lineage (id, workspace_id, name, founder_person_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    insertLineage.run("lineage-a", workspaceId, "甲支", "founder-a", now, now);
    insertLineage.run("lineage-b", workspaceId, "乙支", "founder-b", now, now);
    const insertMembership = database.prepare("INSERT INTO lineage_membership (id, workspace_id, lineage_id, person_id, lineage_role, is_primary, declared_generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'blood', 1, ?, ?, ?)");
    insertMembership.run("member-founder-a", workspaceId, "lineage-a", "founder-a", null, now, now);
    insertMembership.run("member-child-a", workspaceId, "lineage-a", "child-a", 3, now, now);
    insertMembership.run("member-founder-b", workspaceId, "lineage-b", "founder-b", null, now, now);
    insertMembership.run("member-child-b", workspaceId, "lineage-b", "child-b", null, now, now);

    statements = 0;
    const tree = projectWorkspaceTree(database, workspaceId, { view: "full", collapseDepth: 20 });
    const personNodes = new Map(tree.topology.nodes
      .filter((node): node is Extract<typeof node, { kind: "person" }> => node.kind === "person")
      .map((node) => [node.personId, node]));
    expect(personNodes.get("founder-a")?.display.generation).toMatchObject({ displayed: 1, computed: 1, source: "computed", conflict: false });
    expect(personNodes.get("child-a")?.display.generation).toMatchObject({ displayed: 3, computed: 2, source: "declared", conflict: true });
    expect(personNodes.get("child-b")?.display.generation).toMatchObject({ displayed: 2, computed: 2, source: "computed", conflict: false });
    expect(statements).toBeLessThanOrEqual(6);
    database.close();
  });
});
