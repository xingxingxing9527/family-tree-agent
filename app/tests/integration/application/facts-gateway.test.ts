import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";
import { WorkspaceFactsGateway } from "../../../src/main/application/facts/facts-gateway";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import type { PersonDraft } from "../../../src/shared/contracts";

describe("WorkspaceFactsGateway", () => {
  let directory: string;
  let databasePath: string;
  let gateway: WorkspaceFactsGateway;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "facts-gateway-"));
    databasePath = join(directory, "genealogy.sqlite");
    const database = openDatabase(databasePath);
    applyMigrations(database);
    database.close();
    gateway = new WorkspaceFactsGateway({
      getOpenWorkspaceContext: () => ({ workspaceId: "workspace-1", databasePath })
    });
  });

  afterEach(async () => rm(directory, { recursive: true, force: true }));

  const draft = (displayName: string, gender: PersonDraft["gender"], alias = ""): PersonDraft => ({
    displayName,
    aliases: alias ? [alias] : [],
    gender,
    birth: null,
    death: null,
    notes: null,
    sourceDescription: "族谱手录"
  });

  it("persists searchable aliases, relationships, corrections, and divorce history", async () => {
    const father = await gateway.savePerson({ draft: draft("张国强", "male", "国强"), confirmWarnings: false });
    const mother = await gateway.savePerson({ draft: draft("李秀兰", "female"), confirmWarnings: false });
    const child = await gateway.savePerson({ draft: { ...draft("张敏", "female", "敏敏"), birth: { calendar: "solar", year: 1988, month: 5, day: null, leapMonth: false, precision: "month" } }, confirmWarnings: false });
    expect(father.ok && father.value.saved).toBe(true);
    expect(mother.ok && mother.value.saved).toBe(true);
    expect(child.ok && child.value.saved).toBe(true);
    if (!father.ok || !mother.ok || !child.ok || !father.value.entityId || !mother.value.entityId || !child.value.entityId) throw new Error("fixtures failed");

    const aliasSearch = await gateway.listPeople({ query: "敏敏", limit: 20, offset: 0 });
    expect(aliasSearch).toMatchObject({ ok: true, value: [{ displayName: "张敏", aliases: ["敏敏"] }] });

    const parentLink = await gateway.addParentChild({
      draft: { parentId: father.value.entityId, childId: child.value.entityId, parentRole: "father", sourceDescription: "出生记录" },
      confirmWarnings: false
    });
    expect(parentLink).toMatchObject({ ok: true, value: { saved: true } });

    const marriage = await gateway.addMarriage({
      draft: { spouseAId: father.value.entityId, spouseBId: mother.value.entityId, start: { calendar: "lunar", year: 1986, month: 8, day: null, leapMonth: false, precision: "month" }, sourceDescription: "结婚证" },
      confirmWarnings: false
    });
    expect(marriage).toMatchObject({ ok: true, value: { saved: true } });
    if (!marriage.ok || !marriage.value.entityId) throw new Error("marriage fixture failed");

    const beforeCorrection = await gateway.getPerson({ personId: child.value.entityId });
    expect(beforeCorrection).toMatchObject({ ok: true, value: { parents: [{ person: { displayName: "张国强" } }] } });
    if (!beforeCorrection.ok) throw new Error("detail fixture failed");

    const corrected = await gateway.updatePerson({
      personId: child.value.entityId,
      patch: { birth: { calendar: "solar", year: 1988, month: 6, day: null, leapMonth: false, precision: "month" }, sourceDescription: "核对出生证" },
      expectedVersion: beforeCorrection.value.person.rowVersion,
      confirmWarnings: false
    });
    expect(corrected).toMatchObject({ ok: true, value: { saved: true } });

    const divorced = await gateway.divorce({
      marriageId: marriage.value.entityId,
      endDate: { calendar: "solar", year: 2001, month: 3, day: null, leapMonth: false, precision: "month" },
      expectedVersion: 1
    });
    expect(divorced).toMatchObject({ ok: true, value: { saved: true } });

    const fatherDetail = await gateway.getPerson({ personId: father.value.entityId });
    expect(fatherDetail).toMatchObject({
      ok: true,
      value: {
        marriages: [{ status: "divorced", start: { calendar: "lunar", year: 1986, month: 8 }, end: { calendar: "solar", year: 2001, month: 3 } }]
      }
    });
    const correctedDetail = await gateway.getPerson({ personId: child.value.entityId });
    expect(correctedDetail).toMatchObject({ ok: true, value: { person: { birth: { year: 1988, month: 6 } } } });
  });

  it("returns parent-child row versions and provenance from both sides without adding them to marriages", async () => {
    const database = openDatabase(databasePath);
    const facts = new FactCommandService(database, "workspace-1");
    const source = (key: string) => ({ sourceKey: key, title: key, kind: "test" });
    for (const [id, displayName] of [["father", "父亲"], ["mother", "母亲"], ["child", "孩子"]] as const) {
      facts.execute({
        type: "person.create",
        draft: { id, workspaceId: "workspace-1", displayName, gender: "unknown" },
        source: source(`person:${id}`)
      });
    }
    facts.execute({
      type: "marriage.add",
      draft: { id: "marriage", workspaceId: "workspace-1", spouseAId: "father", spouseBId: "mother" },
      source: source("marriage")
    });
    facts.execute({
      type: "parentChild.add",
      draft: {
        id: "inferred-parent", workspaceId: "workspace-1", parentId: "mother", childId: "child", parentRole: "mother",
        originKind: "spouse_default", inferredFromMarriageId: "marriage"
      },
      source: source("inferred-parent")
    });
    database.close();

    const child = await gateway.getPerson({ personId: "child" });
    const mother = await gateway.getPerson({ personId: "mother" });

    expect(child).toMatchObject({
      ok: true,
      value: {
        parents: [{
          relationId: "inferred-parent",
          rowVersion: 1,
          originKind: "spouse_default",
          inferredFromMarriageId: "marriage",
          role: "mother"
        }]
      }
    });
    expect(mother).toMatchObject({
      ok: true,
      value: {
        children: [{
          relationId: "inferred-parent",
          rowVersion: 1,
          originKind: "spouse_default",
          inferredFromMarriageId: "marriage",
          role: "child"
        }],
        marriages: [{ id: "marriage" }]
      }
    });
    if (!mother.ok) throw new Error("mother detail fixture failed");
    expect(mother.value.marriages[0]).not.toHaveProperty("originKind");
    expect(mother.value.marriages[0]).not.toHaveProperty("inferredFromMarriageId");
  });

  it("returns a sanitized not-found result when no workspace is open", async () => {
    const closedGateway = new WorkspaceFactsGateway({ getOpenWorkspaceContext: () => null });
    await expect(closedGateway.listPeople({ limit: 20, offset: 0 })).resolves.toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "No workspace is open" }
    });
  });

  it("serializes concurrent creation requests at the 1,000-person boundary", async () => {
    const database = openDatabase(databasePath);
    const now = new Date().toISOString();
    const insert = database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, 'workspace-1', ?, 'unknown', ?, ?)");
    database.transaction(() => {
      for (let index = 0; index < 999; index += 1) insert.run(`seed-${index}`, `成员 ${index}`, now, now);
    })();
    database.close();

    const outcomes = await Promise.all([
      gateway.savePerson({ draft: draft("边界甲", "unknown"), confirmWarnings: false }),
      gateway.savePerson({ draft: draft("边界乙", "unknown"), confirmWarnings: false })
    ]);
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "VALIDATION", message: expect.stringMatching(/1,?000/u) }) })
    ]);
    const verified = openDatabase(databasePath);
    expect(verified.prepare("SELECT COUNT(*) FROM person WHERE workspace_id = 'workspace-1' AND deleted_at IS NULL").pluck().get()).toBe(1_000);
    verified.close();
  });

  it("returns a sanitized internal result when the open database becomes unavailable", async () => {
    await rm(databasePath, { force: true });
    await expect(gateway.listPeople({ limit: 20, offset: 0 })).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Unable to complete facts request" }
    });
  });
});
