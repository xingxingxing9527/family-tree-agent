import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftService, DraftValidationError } from "../../../src/main/application/chat/draft-service";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { FactQueries } from "../../../src/main/application/facts/fact-queries";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";
import type { ConversationMutationDraft } from "../../../src/shared/chat";

const workspaceId = "workspace-chat";
const emptyParts = { sources: [], fieldConfidence: [], unresolvedReferences: [] } as const;
const familyDraft: ConversationMutationDraft = {
  candidatePeople: [
    { referenceId: "father", statedFields: ["displayName", "aliases", "gender", "birth", "death", "notes"], displayName: "张国强", aliases: [], gender: "male", birth: null, death: null, notes: null, matchedPersonId: null },
    { referenceId: "child", statedFields: ["displayName", "aliases", "gender", "birth", "death", "notes"], displayName: "张敏", aliases: ["敏敏"], gender: "female", birth: null, death: null, notes: null, matchedPersonId: null }
  ],
  parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 0.98 }],
  marriages: [], ...emptyParts
};

const counts = (database: WorkspaceDatabase) => ({
  people: database.prepare("SELECT COUNT(*) FROM person").pluck().get(),
  relations: database.prepare("SELECT COUNT(*) FROM parent_child").pluck().get(),
  operations: database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get()
});

describe("DraftService confirmation", () => {
  let database: WorkspaceDatabase;
  beforeEach(() => { database = openDatabase(":memory:"); applyMigrations(database); });
  afterEach(() => database.close());

  it("stages a valid model draft without writes, then commits selected dependent facts atomically", async () => {
    const adapter = { extractDraft: vi.fn().mockResolvedValue(familyDraft), continueWithTools: vi.fn() };
    const service = new DraftService(database, workspaceId, adapter);
    const before = counts(database);

    const preview = await service.stageFromText("张国强有一个女儿张敏", []);
    expect(counts(database)).toEqual(before);
    expect(preview).toMatchObject({ workspaceId, version: 1, creates: 3, updates: 0, unresolvedReferences: [] });

    const receipt = service.confirm(preview.id, preview.version, preview.changes.map((change) => change.id), {}, []);
    expect(receipt.changedEntityIds).toHaveLength(3);
    expect(counts(database)).toEqual({ people: 2, relations: 1, operations: 1 });
  });

  it("blocks duplicate unresolved names and invalid dependency subsets without writing", () => {
    const facts = new FactCommandService(database, workspaceId);
    for (const id of ["existing-a", "existing-b"]) facts.execute({
      type: "person.create", draft: { id, workspaceId, displayName: "张敏", gender: "unknown" },
      source: { sourceKey: id, title: id, kind: "test" }
    });
    const service = new DraftService(database, workspaceId);
    const duplicate = service.stage({
      ...familyDraft,
      candidatePeople: [{ ...familyDraft.candidatePeople[1]!, matchedPersonId: null }],
      parentChildFacts: []
    });
    expect(duplicate.unresolvedReferences[0]).toMatchObject({ reference: "child", candidatePersonIds: ["existing-a", "existing-b"] });
    expect(() => service.confirm(duplicate.id, duplicate.version, duplicate.changes.map((change) => change.id), {}, [])).toThrowError(DraftValidationError);

    const cleanDatabase = openDatabase(":memory:"); applyMigrations(cleanDatabase);
    try {
      const cleanService = new DraftService(cleanDatabase, workspaceId);
      const clean = cleanService.stage(familyDraft);
      const relation = clean.changes.find((change) => change.entityType === "parentChild")!;
      expect(() => cleanService.confirm(clean.id, clean.version, [], {}, [])).toThrow(/select/i);
      expect(() => cleanService.confirm(clean.id, clean.version, [relation.id], {}, [])).toThrow(/dependency/i);
      expect(counts(cleanDatabase)).toEqual({ people: 0, relations: 0, operations: 0 });
    } finally { cleanDatabase.close(); }
  });

  it("rejects duplicate explicit references to one existing person before staging dependencies", () => {
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({
      type: "person.create",
      draft: {
        id: "existing-parent", workspaceId, displayName: "父", aliases: ["老父"], gender: "male",
        birth: { calendar: "solar", year: 1970, month: 1, day: null, leapMonth: false, precision: "month" }
      },
      source: { sourceKey: "existing-parent", title: "existing-parent", kind: "test" }
    });
    const service = new DraftService(database, workspaceId);
    const duplicate: ConversationMutationDraft = {
      ...familyDraft,
      candidatePeople: [
        {
          referenceId: "parent-update", statedFields: ["birth"], displayName: "父", aliases: [], gender: "male",
          birth: { calendar: "solar", year: 1995, month: 1, day: null, leapMonth: false, precision: "month" },
          death: null, notes: null, matchedPersonId: "existing-parent"
        },
        {
          referenceId: "parent-relation", statedFields: [], displayName: "父", aliases: [], gender: "male",
          birth: null, death: null, notes: null, matchedPersonId: "existing-parent"
        },
        familyDraft.candidatePeople[1]!
      ],
      parentChildFacts: [{ parentRef: "parent-relation", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    };

    expect(() => service.stage(duplicate)).toThrowError(expect.objectContaining({ code: "DUPLICATE_EXISTING_PERSON_REFERENCE" }));
  });

  it("rejects duplicate name and alias resolutions to one existing person", () => {
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({
      type: "person.create",
      draft: {
        id: "existing-parent", workspaceId, displayName: "父", aliases: ["老父"], gender: "male",
        birth: { calendar: "solar", year: 1970, month: 1, day: null, leapMonth: false, precision: "month" }
      },
      source: { sourceKey: "existing-parent", title: "existing-parent", kind: "test" }
    });
    const service = new DraftService(database, workspaceId);
    const duplicate: ConversationMutationDraft = {
      ...familyDraft,
      candidatePeople: [
        {
          referenceId: "parent-by-name", statedFields: ["birth"], displayName: "父", aliases: [], gender: "male",
          birth: { calendar: "solar", year: 1995, month: 1, day: null, leapMonth: false, precision: "month" },
          death: null, notes: null, matchedPersonId: null
        },
        {
          referenceId: "parent-by-alias", statedFields: [], displayName: "老父", aliases: [], gender: "male",
          birth: null, death: null, notes: null, matchedPersonId: null
        },
        familyDraft.candidatePeople[1]!
      ],
      parentChildFacts: [{ parentRef: "parent-by-alias", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    };

    expect(() => service.stage(duplicate)).toThrowError(expect.objectContaining({ code: "DUPLICATE_EXISTING_PERSON_REFERENCE" }));
  });

  it("creates immutable revisions, supersedes old drafts, and enforces row versions and lifetime", () => {
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({
      type: "person.create", draft: { id: "existing", workspaceId, displayName: "张国强", gender: "male" },
      source: { sourceKey: "existing", title: "existing", kind: "test" }
    });
    let now = Date.parse("2026-09-28T00:00:00Z");
    const service = new DraftService(database, workspaceId, undefined, { now: () => now, ttlMs: 1_000 });
    const initial = service.stage({
      ...familyDraft, parentChildFacts: [],
      candidatePeople: [{ ...familyDraft.candidatePeople[0]!, aliases: ["老张"], matchedPersonId: "existing" }]
    });
    expect(initial.changes[0]).toMatchObject({
      entityType: "person",
      fieldChanges: [{ field: "aliases", before: [], after: ["老张"] }]
    });
    const revised = service.revise(initial.id, {
      ...familyDraft, parentChildFacts: [],
      candidatePeople: [{ ...familyDraft.candidatePeople[0]!, aliases: ["强叔"], matchedPersonId: "existing" }]
    });
    expect(revised.version).toBe(2);
    expect(initial).not.toBe(revised);
    expect(() => service.confirm(initial.id, initial.version, initial.changes.map((change) => change.id), { existing: 1 }, [])).toThrow(/superseded/i);
    expect(() => service.confirm(revised.id, revised.version, revised.changes.map((change) => change.id), { existing: 2 }, [])).toThrow(/version/i);
    now += 1_001;
    expect(() => service.confirm(revised.id, revised.version, revised.changes.map((change) => change.id), { existing: 1 }, [])).toThrow(/expired/i);
  });

  it("previews the same domain warnings and conflicts used by manual entry and blocks conflicted confirmation", () => {
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [
        { ...familyDraft.candidatePeople[0]!, birth: { calendar: "solar", year: 2010, month: 1, day: null, leapMonth: false, precision: "month" } },
        { ...familyDraft.candidatePeople[1]!, birth: { calendar: "solar", year: 2015, month: 1, day: null, leapMonth: false, precision: "month" } }
      ],
      marriages: [{ spouseARef: "father", spouseBRef: "father", start: null, sourceRef: null, confidence: 0.9 }]
    });
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PARENT_AGE_OUTLIER" })]));
    expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SELF_RELATION" })]));
    expect(() => service.confirm(preview.id, preview.version, preview.changes.map((change) => change.id), {}, preview.warnings.map((warning) => warning.code))).toThrow(/conflict/i);
    expect(counts(database)).toEqual({ people: 0, relations: 0, operations: 0 });
  });

  it("updates only explicitly stated person fields and preserves confirmed values", () => {
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({
      type: "person.create",
      draft: { id: "existing", workspaceId, displayName: "张国强", aliases: ["老张"], gender: "male", birth: { calendar: "solar", year: 1970, month: 1, day: 2, leapMonth: false, precision: "day" }, death: null, notes: "重要备注" },
      source: { sourceKey: "existing", title: "existing", kind: "test" }
    });
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft, parentChildFacts: [],
      candidatePeople: [{ referenceId: "father", statedFields: ["aliases"], displayName: "张国强", aliases: ["强叔"], gender: "unknown", birth: null, death: null, notes: null, matchedPersonId: "existing" }]
    });
    expect(preview.changes[0]?.fieldChanges).toEqual([{ field: "aliases", before: ["老张"], after: ["强叔"] }]);
    service.confirm(preview.id, preview.version, preview.changes.map((change) => change.id), { existing: 1 }, []);
    expect(new FactQueries(database, workspaceId).getPerson("existing")).toMatchObject({
      displayName: "张国强", gender: "male", notes: "重要备注", birth: { year: 1970 }
    });
  });

  it("rejects a new person without explicit identity intent", () => {
    const service = new DraftService(database, workspaceId);
    expect(() => service.stage({
      ...familyDraft, parentChildFacts: [],
      candidatePeople: [{ ...familyDraft.candidatePeople[0]!, statedFields: ["aliases"] }]
    })).toThrow(/identity|display name|gender/i);
  });

  it("requires explicit acknowledgement of every warning for the exact draft version", () => {
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [
        { ...familyDraft.candidatePeople[0]!, birth: { calendar: "solar", year: 2010, month: 1, day: null, leapMonth: false, precision: "month" } },
        { ...familyDraft.candidatePeople[1]!, birth: { calendar: "solar", year: 2015, month: 1, day: null, leapMonth: false, precision: "month" } }
      ]
    });
    expect(preview.warnings.length).toBeGreaterThan(0);
    const ids = preview.changes.map((change) => change.id);
    expect(() => service.confirm(preview.id, preview.version, ids, {}, [])).toThrow(/acknowledge|warning/i);
    expect(() => service.confirm(preview.id, preview.version + 1, ids, {}, preview.warnings.map((warning) => warning.code))).toThrow(/version/i);
    expect(() => service.confirm(preview.id, preview.version, ids, {}, preview.warnings.map((warning) => warning.code))).not.toThrow();
  });

  it("stores an immutable nested draft snapshot for preview and confirmation", () => {
    const mutable = structuredClone({
      ...familyDraft,
      candidatePeople: [
        { ...familyDraft.candidatePeople[0]!, aliases: ["强叔"], birth: { calendar: "solar" as const, year: 1970, month: 1, day: 2, leapMonth: false, precision: "day" as const } },
        { ...familyDraft.candidatePeople[1]!, birth: { calendar: "solar" as const, year: 2000, month: 2, day: 3, leapMonth: false, precision: "day" as const } },
        { ...familyDraft.candidatePeople[1]!, referenceId: "spouse", displayName: "李华", aliases: [], gender: "female" as const, birth: { calendar: "solar" as const, year: 1972, month: 4, day: 5, leapMonth: false, precision: "day" as const } }
      ],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father" as const, sourceRef: "source", confidence: 0.9 }],
      marriages: [{ spouseARef: "father", spouseBRef: "spouse", start: { calendar: "solar" as const, year: 1995, month: 6, day: 7, leapMonth: false, precision: "day" as const }, sourceRef: "source", confidence: 0.9 }],
      sources: [{ referenceId: "source", title: "原始来源", kind: "book", citation: "第1页" }]
    });
    const service = new DraftService(database, workspaceId);
    const preview = service.stage(mutable);
    mutable.candidatePeople[0]!.displayName = "篡改人物";
    mutable.candidatePeople[0]!.aliases[0] = "篡改别名";
    mutable.candidatePeople[0]!.birth!.year = 1900;
    mutable.parentChildFacts[0]!.parentRole = "mother";
    mutable.marriages[0]!.start!.year = 2020;
    mutable.sources[0]!.title = "篡改来源";
    mutable.sources[0]!.citation = "篡改引文";

    service.confirm(preview.id, preview.version, preview.changes.map((change) => change.id), {}, preview.warnings.map((warning) => warning.code));
    expect(new FactQueries(database, workspaceId).listPeople()).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayName: "张国强", birth: expect.objectContaining({ year: 1970 }) })
    ]));
    expect(new FactQueries(database, workspaceId).listAliases(preview.changes.find((change) => change.summary.includes("张国强"))!.entityId).map((alias) => alias.name)).toEqual(["强叔"]);
    expect(new FactQueries(database, workspaceId).listParentChild()[0]).toMatchObject({ parentRole: "father" });
    expect(new FactQueries(database, workspaceId).listMarriages()[0]).toMatchObject({ start: expect.objectContaining({ year: 1995 }) });
    expect(database.prepare("SELECT title, citation FROM source WHERE workspace_id = ?").all(workspaceId)).toEqual(expect.arrayContaining([expect.objectContaining({ title: "原始来源", citation: "第1页" })]));
  });

  it("previews validator issues from existing relations and marriage dates", () => {
    const facts = new FactCommandService(database, workspaceId);
    for (const person of [
      { id: "parent", displayName: "父", birth: { calendar: "solar" as const, year: 1970, month: 1, day: null, leapMonth: false, precision: "month" as const } },
      { id: "child", displayName: "子", birth: { calendar: "solar" as const, year: 2000, month: 1, day: null, leapMonth: false, precision: "month" as const } }
    ]) facts.execute({ type: "person.create", draft: { ...person, workspaceId, gender: "unknown" }, source: { sourceKey: person.id, title: person.id, kind: "test" } });
    facts.execute({ type: "parentChild.add", draft: { id: "edge", workspaceId, parentId: "parent", childId: "child", parentRole: "father" }, source: { sourceKey: "edge", title: "edge", kind: "test" } });
    const service = new DraftService(database, workspaceId);
    const relationPreview = service.stage({
      ...familyDraft, parentChildFacts: [],
      candidatePeople: [{ referenceId: "parent", statedFields: ["birth"], displayName: "父", aliases: [], gender: "unknown", birth: { calendar: "solar", year: 1995, month: 1, day: null, leapMonth: false, precision: "month" }, death: null, notes: null, matchedPersonId: "parent" }]
    });
    expect(relationPreview.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PARENT_AGE_OUTLIER" })]));

    const invalidMarriage = structuredClone({ ...familyDraft, parentChildFacts: [], marriages: [{ spouseARef: "father", spouseBRef: "child", start: { calendar: "solar", year: 2025, month: 2, day: 31, leapMonth: false, precision: "day" }, sourceRef: null, confidence: 1 }] }) as never;
    expect(service.stage(invalidMarriage).conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ code: "INVALID_DATE" })]));
  });

  it("validates interacting prospective relation commands as one graph", () => {
    const person = (referenceId: string, displayName: string) => ({
      ...familyDraft.candidatePeople[0]!, referenceId, displayName, gender: "unknown" as const
    });
    const preview = new DraftService(database, workspaceId).stage({
      ...familyDraft,
      candidatePeople: [person("father-a", "父甲"), person("father-b", "父乙"), person("child", "孩子")],
      parentChildFacts: [
        { parentRef: "father-a", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 },
        { parentRef: "father-b", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }
      ]
    });
    expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PARENT_ROLE_OCCUPIED" })]));
  });

  it("requires restaging when the exact validator issue set changes before confirmation", () => {
    const facts = new FactCommandService(database, workspaceId);
    for (const person of [
      { id: "parent", displayName: "父", birth: { calendar: "solar" as const, year: 1970, month: 1, day: null, leapMonth: false, precision: "month" as const } },
      { id: "child", displayName: "子", birth: { calendar: "solar" as const, year: 2000, month: 1, day: null, leapMonth: false, precision: "month" as const } }
    ]) facts.execute({ type: "person.create", draft: { ...person, workspaceId, gender: "unknown" }, source: { sourceKey: person.id, title: person.id, kind: "test" } });
    facts.execute({ type: "parentChild.add", draft: { id: "edge", workspaceId, parentId: "parent", childId: "child", parentRole: "father" }, source: { sourceKey: "edge", title: "edge", kind: "test" } });
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft, parentChildFacts: [],
      candidatePeople: [{ referenceId: "parent", statedFields: ["notes"], displayName: "父", aliases: [], gender: "unknown", birth: null, death: null, notes: "新备注", matchedPersonId: "parent" }]
    });
    expect(preview.warnings).toEqual([]);
    facts.execute({ type: "person.update", personId: "child", expectedVersion: 1, patch: { birth: { calendar: "solar", year: 1975, month: 1, day: null, leapMonth: false, precision: "month" } }, source: { sourceKey: "child-update", title: "child-update", kind: "test" } }, { confirmWarnings: true });
    expect(() => service.confirm(preview.id, preview.version, preview.changes.map((change) => change.id), { parent: 1 }, [])).toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));
  });

  it("makes a relation depend on a staged update whose prospective person values it used", () => {
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({ type: "person.create", draft: { id: "parent", workspaceId, displayName: "父", gender: "male", birth: { calendar: "solar", year: 1970, month: 1, day: null, leapMonth: false, precision: "month" } }, source: { sourceKey: "parent", title: "parent", kind: "test" } });
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [
        { referenceId: "parent", statedFields: ["birth"], displayName: "父", aliases: [], gender: "male", birth: { calendar: "solar", year: 1995, month: 1, day: null, leapMonth: false, precision: "month" }, death: null, notes: null, matchedPersonId: "parent" },
        { ...familyDraft.candidatePeople[1]!, referenceId: "child", birth: { calendar: "solar", year: 2000, month: 1, day: null, leapMonth: false, precision: "month" } }
      ],
      parentChildFacts: [{ parentRef: "parent", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    });
    const update = preview.changes.find((change) => change.kind === "update")!;
    const child = preview.changes.find((change) => change.entityType === "person" && change.kind === "create")!;
    const relation = preview.changes.find((change) => change.entityType === "parentChild")!;
    expect(relation.dependsOnChangeIds).toEqual(expect.arrayContaining([update.id, child.id]));
    expect(() => service.confirm(preview.id, preview.version, [child.id, relation.id], {}, preview.warnings.map((warning) => warning.code))).toThrow(/dependency/i);
  });

  it("snapshots referenced existing-person versions even when they are not directly updated", () => {
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({ type: "person.create", draft: { id: "parent", workspaceId, displayName: "父", gender: "male" }, source: { sourceKey: "parent", title: "parent", kind: "test" } });
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [
        { referenceId: "parent", statedFields: [], displayName: "父", aliases: [], gender: "male", birth: null, death: null, notes: null, matchedPersonId: "parent" },
        familyDraft.candidatePeople[1]!
      ],
      parentChildFacts: [{ parentRef: "parent", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    });
    facts.execute({ type: "person.update", personId: "parent", expectedVersion: 1, patch: { notes: "外部修改" }, source: { sourceKey: "parent-update", title: "parent-update", kind: "test" } });
    expect(() => service.confirm(preview.id, preview.version, preview.changes.map((change) => change.id), {}, [])).toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));
  });

  it("preserves same-code issue multiplicity and validates only the selected change graph", () => {
    const facts = new FactCommandService(database, workspaceId);
    const birth = (year: number) => ({ calendar: "solar" as const, year, month: 1, day: null, leapMonth: false, precision: "month" as const });
    for (const id of ["p1", "p2"]) {
      facts.execute({ type: "person.create", draft: { id, workspaceId, displayName: id, gender: "male", birth: birth(1970) }, source: { sourceKey: id, title: id, kind: "test" } });
      facts.execute({ type: "person.create", draft: { id: `c-${id}`, workspaceId, displayName: `c-${id}`, gender: "unknown", birth: birth(1975) }, source: { sourceKey: `c-${id}`, title: `c-${id}`, kind: "test" } });
      facts.execute({ type: "parentChild.add", draft: { id: `e-${id}`, workspaceId, parentId: id, childId: `c-${id}`, parentRole: "father" }, source: { sourceKey: `e-${id}`, title: `e-${id}`, kind: "test" } }, { confirmWarnings: true });
    }
    const draft = (): ConversationMutationDraft => ({
      ...familyDraft, parentChildFacts: [],
      candidatePeople: ["p1", "p2"].map((id) => ({ referenceId: id, statedFields: ["notes"], displayName: id, aliases: [], gender: "male", birth: null, death: null, notes: `note-${id}`, matchedPersonId: id }))
    });

    const partialService = new DraftService(database, workspaceId);
    const partial = partialService.stage(draft());
    const p1Change = partial.changes.find((change) => change.entityId === "p1")!;
    partialService.confirm(partial.id, partial.version, [p1Change.id], { p1: 1 }, ["PARENT_AGE_OUTLIER"]);
    expect(new FactQueries(database, workspaceId).getPerson("p1")?.notes).toBe("note-p1");
    expect(new FactQueries(database, workspaceId).getPerson("p2")?.notes).toBeNull();

    const collisionService = new DraftService(database, workspaceId);
    const collision = collisionService.stage({
      ...draft(),
      candidatePeople: draft().candidatePeople.map((candidate) => candidate.referenceId === "p1" ? { ...candidate, notes: "note-p1-again" } : candidate)
    });
    const selected = collision.changes.find((change) => change.entityId === "p1")!;
    facts.execute({ type: "person.update", personId: "c-p1", expectedVersion: 1, patch: { birth: birth(2000) }, source: { sourceKey: "c-p1-update", title: "c-p1-update", kind: "test" } });
    expect(() => collisionService.confirm(collision.id, collision.version, [selected.id], { p1: 2 }, ["PARENT_AGE_OUTLIER"]))
      .toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));
  });
});
