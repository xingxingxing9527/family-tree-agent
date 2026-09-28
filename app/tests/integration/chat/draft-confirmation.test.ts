import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftService, DraftValidationError } from "../../../src/main/application/chat/draft-service";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";
import type { ConversationMutationDraft } from "../../../src/shared/chat";

const workspaceId = "workspace-chat";
const emptyParts = { sources: [], fieldConfidence: [], unresolvedReferences: [] } as const;
const familyDraft: ConversationMutationDraft = {
  candidatePeople: [
    { referenceId: "father", displayName: "张国强", aliases: [], gender: "male", birth: null, death: null, notes: null, matchedPersonId: null },
    { referenceId: "child", displayName: "张敏", aliases: ["敏敏"], gender: "female", birth: null, death: null, notes: null, matchedPersonId: null }
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

    const receipt = service.confirm(preview.id, preview.changes.map((change) => change.id), {});
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
    expect(() => service.confirm(duplicate.id, duplicate.changes.map((change) => change.id), {})).toThrowError(DraftValidationError);

    const cleanDatabase = openDatabase(":memory:"); applyMigrations(cleanDatabase);
    try {
      const cleanService = new DraftService(cleanDatabase, workspaceId);
      const clean = cleanService.stage(familyDraft);
      const relation = clean.changes.find((change) => change.entityType === "parentChild")!;
      expect(() => cleanService.confirm(clean.id, [], {})).toThrow(/select/i);
      expect(() => cleanService.confirm(clean.id, [relation.id], {})).toThrow(/dependency/i);
      expect(counts(cleanDatabase)).toEqual({ people: 0, relations: 0, operations: 0 });
    } finally { cleanDatabase.close(); }
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
    expect(() => service.confirm(initial.id, initial.changes.map((change) => change.id), { existing: 1 })).toThrow(/superseded/i);
    expect(() => service.confirm(revised.id, revised.changes.map((change) => change.id), { existing: 2 })).toThrow(/version/i);
    now += 1_001;
    expect(() => service.confirm(revised.id, revised.changes.map((change) => change.id), { existing: 1 })).toThrow(/expired/i);
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
    expect(() => service.confirm(preview.id, preview.changes.map((change) => change.id), {})).toThrow(/conflict/i);
    expect(counts(database)).toEqual({ people: 0, relations: 0, operations: 0 });
  });
});
