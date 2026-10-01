import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ParentCompletionService,
  type ParentCompletionFacts
} from "../../../src/main/application/relations/parent-completion-service";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { FactQueries } from "../../../src/main/application/facts/fact-queries";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";
import type { PersonRecord } from "../../../src/main/database/repositories/person-repository";
import type { MarriageRecord, ParentChildRecord } from "../../../src/main/database/repositories/relation-repository";
import type { PartialDate } from "../../../src/shared/domain";

const workspaceId = "workspace-1";
const solar = (year: number, month = 1, day: number | null = null): PartialDate => ({
  calendar: "solar",
  year,
  month,
  day,
  leapMonth: false,
  precision: day === null ? "month" : "day"
});

describe("ParentCompletionService", () => {
  let root: string;
  let database: WorkspaceDatabase;
  let commands: FactCommandService;
  let queries: FactQueries;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "parent-completion-service-"));
    database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
    commands = new FactCommandService(database, workspaceId);
    queries = new FactQueries(database, workspaceId);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  const source = (key: string) => ({ sourceKey: key, title: key, kind: "test" });
  const createPerson = (
    id: string,
    displayName: string,
    gender: "male" | "female" | "unknown" = "unknown",
    birth: PartialDate | null = null
  ) => commands.execute({
    type: "person.create",
    draft: { id, workspaceId, displayName, gender, birth },
    source: source(`person-${id}`)
  });
  const createParent = (id: string, parentId: string, childId: string, parentRole: "father" | "mother") => commands.execute({
    type: "parentChild.add",
    draft: { id, workspaceId, parentId, childId, parentRole },
    source: source(`parent-${id}`)
  });
  const createMarriage = (
    id: string,
    spouseAId: string,
    spouseBId: string,
    status: "active" | "divorced" = "active",
    start: PartialDate | null = null,
    end: PartialDate | null = null
  ) => commands.execute({
    type: "marriage.add",
    draft: { id, workspaceId, spouseAId, spouseBId, status, start, end },
    source: source(`marriage-${id}`)
  });
  const tableCounts = () => Object.fromEntries(
    ["person", "parent_child", "marriage", "source", "operation_group", "audit_log"]
      .map((table) => [table, database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()])
  );

  it("returns named marriage evidence from one read pass without writing or exposing the fingerprint", () => {
    createPerson("known", "父亲", "male");
    createPerson("spouse", "母亲", "female");
    createPerson("child", "孩子");
    createMarriage("episode-old", "known", "spouse", "divorced", solar(1990), solar(1995));
    createMarriage("episode-current", "known", "spouse", "active", solar(1999));
    createParent("known-parent", "known", "child", "father");
    const before = tableCounts();
    const peopleRead = vi.spyOn(FactQueries.prototype, "listPeople");
    const parentsRead = vi.spyOn(FactQueries.prototype, "listParentChild");
    const marriagesRead = vi.spyOn(FactQueries.prototype, "listMarriages");

    const result = new ParentCompletionService(queries).plan({
      knownParentId: "known",
      childId: "child",
      parentRole: "father"
    });

    expect(result.plan).toMatchObject({
      status: "suggested",
      basis: "unique_spouse",
      explicit: {
        parentId: "known",
        parentName: "父亲",
        childId: "child",
        childName: "孩子",
        parentRole: "father"
      },
      suggested: {
        parentId: "spouse",
        parentName: "母亲",
        childId: "child",
        childName: "孩子",
        parentRole: "mother",
        inferredFromMarriageId: null
      },
      candidates: [{
        personId: "spouse",
        personName: "母亲",
        marriageEpisodes: [
          { id: "episode-current", status: "active", start: solar(1999), end: null },
          { id: "episode-old", status: "divorced", start: solar(1990), end: solar(1995) }
        ],
        reason: expect.stringMatching(/唯一.*配偶/u)
      }]
    });
    expect(result.planningFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.plan.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "person", id: "known", displayName: "父亲", rowVersion: 1 }),
      expect.objectContaining({ entityType: "person", id: "child", displayName: "孩子", birth: null, rowVersion: 1 }),
      expect.objectContaining({ entityType: "marriage", id: "episode-current", rowVersion: 1 }),
      expect.objectContaining({ entityType: "parent_child", id: "known-parent", rowVersion: 1 })
    ]));
    expect(JSON.stringify(result.plan)).not.toMatch(/planningFingerprint|databasePath|genealogy\.sqlite|parent-completion-service-/u);
    expect(tableCounts()).toEqual(before);
    expect(peopleRead).toHaveBeenCalledTimes(1);
    expect(parentsRead).toHaveBeenCalledTimes(1);
    expect(marriagesRead).toHaveBeenCalledTimes(1);
  });

  it("scans each one-parent child once, classifies results, and orders by child name then id", () => {
    for (const [id, name, gender] of [
      ["safe-parent", "安全父亲", "male"], ["safe-spouse", "安全母亲", "female"],
      ["safe-child-z", "A同名", "unknown"], ["safe-child-a", "A同名", "unknown"],
      ["no-parent", "单亲母亲", "female"], ["no-child", "B无候选", "unknown"],
      ["amb-parent", "多婚父亲", "male"], ["amb-first", "前配偶", "female"],
      ["amb-second", "现配偶", "female"], ["amb-child", "C歧义", "unknown"],
      ["both-father", "双亲父亲", "male"], ["both-mother", "双亲母亲", "female"],
      ["both-child", "D双亲", "unknown"], ["zero-child", "E零亲", "unknown"]
    ] as const) createPerson(id, name, gender);
    createMarriage("safe-marriage", "safe-parent", "safe-spouse");
    createParent("safe-z-parent", "safe-parent", "safe-child-z", "father");
    createParent("safe-a-parent", "safe-parent", "safe-child-a", "father");
    createParent("no-edge", "no-parent", "no-child", "mother");
    createMarriage("amb-old", "amb-parent", "amb-first", "divorced", solar(1980), solar(1990));
    createMarriage("amb-current", "amb-parent", "amb-second", "active", solar(1995));
    createParent("amb-edge", "amb-parent", "amb-child", "father");
    createParent("both-father-edge", "both-father", "both-child", "father");
    createParent("both-mother-edge", "both-mother", "both-child", "mother");
    const before = tableCounts();
    const peopleRead = vi.spyOn(FactQueries.prototype, "listPeople");
    const parentsRead = vi.spyOn(FactQueries.prototype, "listParentChild");
    const marriagesRead = vi.spyOn(FactQueries.prototype, "listMarriages");

    const scan = new ParentCompletionService(queries).scan();

    expect(scan.items.map(({ childId, classification }) => ({ childId, classification }))).toEqual([
      { childId: "safe-child-a", classification: "safe" },
      { childId: "safe-child-z", classification: "safe" },
      { childId: "no-child", classification: "no-candidate" },
      { childId: "amb-child", classification: "ambiguous" }
    ]);
    expect(scan.counts).toEqual({ total: 4, safe: 2, ambiguous: 1, noCandidate: 1, conflict: 0 });
    expect(new Set(scan.items.map(({ childId }) => childId)).size).toBe(scan.items.length);
    expect(scan.items.map(({ childId }) => childId)).not.toContain("both-child");
    expect(scan.items.map(({ childId }) => childId)).not.toContain("zero-child");
    expect(tableCounts()).toEqual(before);
    expect(peopleRead).toHaveBeenCalledTimes(1);
    expect(parentsRead).toHaveBeenCalledTimes(1);
    expect(marriagesRead).toHaveBeenCalledTimes(1);
  });

  it("reports a conflicting complementary parent with Chinese names", () => {
    createPerson("known", "已知父亲", "male");
    createPerson("spouse", "建议母亲", "female");
    createPerson("recorded", "现有母亲", "female");
    createPerson("child", "孩子");
    createMarriage("marriage", "known", "spouse");
    createParent("father-edge", "known", "child", "father");
    createParent("mother-edge", "recorded", "child", "mother");

    const result = new ParentCompletionService(queries).plan({
      knownParentId: "known",
      childId: "child",
      parentRole: "father"
    });

    expect(result.plan).toMatchObject({
      status: "conflict",
      suggested: { parentId: "spouse", parentName: "建议母亲" },
      issues: [{
        code: "PARENT_ROLE_OCCUPIED",
        severity: "error",
        message: expect.stringMatching(/孩子.*现有母亲.*建议母亲/u)
      }]
    });
  });

  it("changes the private fingerprint for relevant birth, person, parent-edge, and marriage evidence", () => {
    const people: PersonRecord[] = [
      personRecord("known", "父亲", "male"),
      personRecord("spouse", "母亲", "female"),
      personRecord("child", "孩子", "unknown", solar(2000, 1, 1))
    ];
    const parentEdges: ParentChildRecord[] = [parentRecord("father-edge", "known", "child", "father")];
    const marriages: MarriageRecord[] = [marriageRecord("marriage", "known", "spouse")];
    const facts: ParentCompletionFacts = {
      listPeople: () => people,
      listParentChild: () => parentEdges,
      listMarriages: () => marriages
    };
    const service = new ParentCompletionService(facts);
    const plan = () => service.plan({ knownParentId: "known", childId: "child", parentRole: "father" }).planningFingerprint;
    const fingerprints = [plan()];

    people[2] = { ...people[2], birth: solar(2000, 2, 1) };
    fingerprints.push(plan());
    people[1] = { ...people[1], rowVersion: 2 };
    fingerprints.push(plan());
    parentEdges.push(parentRecord("mother-edge", "spouse", "child", "mother"));
    fingerprints.push(plan());
    parentEdges[1] = { ...parentEdges[1], rowVersion: 2 };
    fingerprints.push(plan());
    parentEdges.pop();
    fingerprints.push(plan());
    marriages[0] = { ...marriages[0], rowVersion: 2, status: "divorced", end: solar(2010) };
    fingerprints.push(plan());
    marriages.push(marriageRecord("second-episode", "known", "spouse"));
    fingerprints.push(plan());
    marriages.pop();
    fingerprints.push(plan());

    for (let index = 1; index < fingerprints.length; index += 1) {
      expect(fingerprints[index], `mutation ${index} must invalidate the previous fingerprint`).not.toBe(fingerprints[index - 1]);
    }
  });
});

function personRecord(
  id: string,
  displayName: string,
  gender: PersonRecord["gender"] = "unknown",
  birth: PartialDate | null = null
): PersonRecord {
  return {
    id,
    workspaceId,
    personCode: `P-${id}`,
    displayName,
    gender,
    birth,
    death: null,
    notes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    rowVersion: 1,
    childrenComplete: false
  };
}

function parentRecord(
  id: string,
  parentId: string,
  childId: string,
  parentRole: ParentChildRecord["parentRole"]
): ParentChildRecord {
  return {
    id,
    workspaceId,
    parentId,
    childId,
    parentRole,
    relationshipType: "biological",
    originKind: "explicit",
    inferredFromMarriageId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    rowVersion: 1
  };
}

function marriageRecord(id: string, spouseAId: string, spouseBId: string): MarriageRecord {
  return {
    id,
    workspaceId,
    spouseAId,
    spouseBId,
    status: "active",
    start: null,
    end: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    rowVersion: 1
  };
}
