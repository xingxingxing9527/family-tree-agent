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

const persistedWriteCounts = (database: WorkspaceDatabase) => ({
  people: database.prepare("SELECT COUNT(*) FROM person").pluck().get(),
  relations: database.prepare("SELECT COUNT(*) FROM parent_child").pluck().get(),
  marriages: database.prepare("SELECT COUNT(*) FROM marriage").pluck().get(),
  operations: database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get(),
  sources: database.prepare("SELECT COUNT(*) FROM source").pluck().get(),
  audits: database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()
});

const solarMonth = (year: number, month = 1) => ({
  calendar: "solar" as const, year, month, day: null, leapMonth: false, precision: "month" as const
});

const source = (key: string) => ({ sourceKey: key, title: key, kind: "test" });

const seedPerson = (
  facts: FactCommandService,
  id: string,
  displayName: string,
  gender: "male" | "female" | "unknown",
  birth: ReturnType<typeof solarMonth> | null = null
): void => {
  facts.execute({ type: "person.create", draft: { id, workspaceId, displayName, gender, birth }, source: source(id) });
};

const seedMarriage = (
  facts: FactCommandService,
  id: string,
  spouseAId: string,
  spouseBId: string,
  options: { status?: "active" | "divorced"; start?: ReturnType<typeof solarMonth>; end?: ReturnType<typeof solarMonth> } = {}
): void => {
  facts.execute({
    type: "marriage.add",
    draft: {
      id, workspaceId, spouseAId, spouseBId,
      status: options.status ?? "active",
      start: options.start ?? null,
      end: options.end ?? null
    },
    source: source(id)
  });
};

const existingPerson = (
  referenceId: string,
  matchedPersonId: string,
  displayName: string,
  gender: "male" | "female" | "unknown"
) => ({
  referenceId, statedFields: [] as const, displayName, aliases: [], gender,
  birth: null, death: null, notes: null, matchedPersonId
});

const newChild = (referenceId = "child", displayName = "孩子") => ({
  referenceId,
  statedFields: ["displayName", "aliases", "gender", "birth", "death", "notes"] as const,
  displayName,
  aliases: [],
  gender: "unknown" as const,
  birth: null,
  death: null,
  notes: null,
  matchedPersonId: null
});

describe("DraftService confirmation", () => {
  let database: WorkspaceDatabase;
  beforeEach(() => { database = openDatabase(":memory:"); applyMigrations(database); });
  afterEach(() => database.close());

  const expectStaleWithoutConversationWrites = (
    service: DraftService,
    preview: ReturnType<DraftService["stage"]>,
    selectedChangeIds: string[],
    acknowledgedWarningCodes: string[] = []
  ): void => {
    const before = persistedWriteCounts(database);
    expect(() => service.confirm(preview.id, preview.version, selectedChangeIds, {}, acknowledgedWarningCodes))
      .toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    expect(persistedWriteCounts(database)).toEqual(before);
    expect(database.prepare("SELECT COUNT(*) FROM operation_group WHERE kind = 'conversation.confirm'").pluck().get()).toBe(0);
    expect(database.prepare("SELECT COUNT(*) FROM source WHERE source_key LIKE ?").pluck().get(`conversation:${preview.id}:%`)).toBe(0);
    expect(database.prepare("SELECT COUNT(*) FROM audit_log audit JOIN operation_group operation ON operation.id = audit.operation_group_id WHERE operation.kind = 'conversation.confirm'").pluck().get()).toBe(0);
  };

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

  it("completes a newly stated child from a marriage confirmed before the conversation draft", () => {
    const facts = new FactCommandService(database, workspaceId);
    seedPerson(facts, "father", "父亲", "male");
    seedPerson(facts, "mother", "母亲", "female");
    seedMarriage(facts, "parents-marriage", "father", "mother");
    const service = new DraftService(database, workspaceId);

    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [existingPerson("father", "father", "父亲", "male"), newChild()],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 0.96 }]
    });
    const childChange = preview.changes.find((change) => change.entityType === "person")!;
    const relations = preview.changes.filter((change) => change.entityType === "parentChild");
    const explicit = relations.find((change) => change.originKind === "explicit")!;
    const automatic = relations.find((change) => change.originKind === "spouse_default")!;

    expect(relations).toHaveLength(2);
    expect(explicit).toMatchObject({ selectedByDefault: true });
    expect(automatic).toMatchObject({
      selectedByDefault: true,
      summary: "母亲 → 孩子：母亲（依据：唯一已确认配偶）",
      dependsOnChangeIds: expect.arrayContaining([childChange.id, explicit.id]),
      parentCompletion: {
        status: "suggested",
        basis: "unique_spouse",
        reason: "已确认婚姻中唯一的配偶候选"
      }
    });

    service.confirm(preview.id, preview.version, preview.changes.map((change) => change.id), {}, []);
    expect(new FactQueries(database, workspaceId).listParentChild()).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentId: "father", parentRole: "father", originKind: "explicit" }),
      expect.objectContaining({ parentId: "mother", parentRole: "mother", originKind: "spouse_default", inferredFromMarriageId: "parents-marriage" })
    ]));
  });

  it("does not use a marriage proposed in the same unconfirmed draft as completion evidence", () => {
    const facts = new FactCommandService(database, workspaceId);
    seedPerson(facts, "father", "父亲", "male");
    seedPerson(facts, "mother", "母亲", "female");
    const service = new DraftService(database, workspaceId);

    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [
        existingPerson("father", "father", "父亲", "male"),
        existingPerson("mother", "mother", "母亲", "female"),
        newChild()
      ],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }],
      marriages: [{ spouseARef: "father", spouseBRef: "mother", start: solarMonth(2000), sourceRef: null, confidence: 1 }]
    });
    const relationChanges = preview.changes.filter((change) => change.entityType === "parentChild");

    expect(preview.changes.filter((change) => change.entityType === "marriage")).toHaveLength(1);
    expect(relationChanges).toHaveLength(1);
    expect(relationChanges[0]).toMatchObject({
      originKind: "explicit",
      parentCompletion: {
        status: "no_candidate",
        reason: expect.stringContaining("已确认婚姻")
      }
    });
    expect(preview.changes.some((change) => change.originKind === "spouse_default")).toBe(false);

    service.confirm(preview.id, preview.version, preview.changes.map((change) => change.id), {}, []);
    const childId = preview.changes.find((change) => change.entityType === "person")!.entityId;
    const followUp = new DraftService(database, workspaceId);
    const followUpPreview = followUp.stage({
      ...familyDraft,
      candidatePeople: [
        existingPerson("father", "father", "父亲", "male"),
        existingPerson("child", childId, "孩子", "unknown")
      ],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }],
      marriages: []
    });
    expect(followUpPreview.conflicts).toEqual([]);
    expect(followUpPreview.changes).toEqual([
      expect.objectContaining({ originKind: "spouse_default", selectedByDefault: true, dependsOnChangeIds: [] })
    ]);
    followUp.confirm(followUpPreview.id, followUpPreview.version, [followUpPreview.changes[0]!.id], {}, []);
    expect(new FactQueries(database, workspaceId).listParentChild()).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentId: "father", parentRole: "father", originKind: "explicit" }),
      expect.objectContaining({ parentId: "mother", parentRole: "mother", originKind: "spouse_default" })
    ]));
  });

  it("replans selected completion evidence inside confirmation and rolls back when the marriage changed", () => {
    const facts = new FactCommandService(database, workspaceId);
    seedPerson(facts, "father", "父亲", "male");
    seedPerson(facts, "mother", "母亲", "female");
    seedMarriage(facts, "parents-marriage", "father", "mother");
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [existingPerson("father", "father", "父亲", "male"), newChild()],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    });
    expect(preview.changes.some((change) => change.originKind === "spouse_default")).toBe(true);

    facts.execute({
      type: "marriage.divorce",
      marriageId: "parents-marriage",
      expectedVersion: 1,
      endDate: solarMonth(2020),
      source: source("divorce-after-preview")
    });

    expectStaleWithoutConversationWrites(
      service,
      preview,
      preview.changes.map((change) => change.id),
      preview.warnings.map((warning) => warning.code)
    );
    expect(new FactQueries(database, workspaceId).listParentChild()).toEqual([]);
  });

  it("invalidates a no-candidate decision when a persisted marriage appears before confirmation", () => {
    const facts = new FactCommandService(database, workspaceId);
    seedPerson(facts, "father", "父亲", "male");
    seedPerson(facts, "mother", "母亲", "female");
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [existingPerson("father", "father", "父亲", "male"), newChild()],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    });
    expect(preview.changes.find((change) => change.entityType === "parentChild")?.parentCompletion?.status).toBe("no_candidate");

    seedMarriage(facts, "parents-marriage", "father", "mother");

    expectStaleWithoutConversationWrites(service, preview, preview.changes.map((change) => change.id));
    expect(new FactQueries(database, workspaceId).listParentChild()).toEqual([]);
  });

  it("invalidates a safe completion decision even when the administrator cancels the automatic change", () => {
    const facts = new FactCommandService(database, workspaceId);
    seedPerson(facts, "father", "父亲", "male");
    seedPerson(facts, "mother", "母亲", "female");
    seedMarriage(facts, "parents-marriage", "father", "mother");
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [existingPerson("father", "father", "父亲", "male"), newChild()],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    });
    expect(preview.changes.some((change) => change.originKind === "spouse_default")).toBe(true);

    facts.execute({
      type: "marriage.divorce",
      marriageId: "parents-marriage",
      expectedVersion: 1,
      endDate: solarMonth(2020),
      source: source("divorce-after-cancelled-preview")
    });
    const selected = preview.changes.filter((change) => change.originKind !== "spouse_default").map((change) => change.id);

    expectStaleWithoutConversationWrites(service, preview, selected);
    expect(new FactQueries(database, workspaceId).listParentChild()).toEqual([]);
  });

  it("invalidates an ambiguous decision when every candidate is skipped and marriage evidence changes", () => {
    const facts = new FactCommandService(database, workspaceId);
    for (const [id, name, gender] of [["father", "父亲", "male"], ["former", "前配偶", "female"], ["current", "现配偶", "female"]] as const) {
      seedPerson(facts, id, name, gender);
    }
    seedMarriage(facts, "former-marriage", "father", "former", { status: "divorced", start: solarMonth(1990), end: solarMonth(1999) });
    seedMarriage(facts, "current-marriage", "father", "current", { start: solarMonth(2000) });
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [existingPerson("father", "father", "父亲", "male"), newChild()],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    });
    expect(preview.changes.filter((change) => change.originKind === "spouse_default")).toHaveLength(2);

    facts.execute({
      type: "marriage.divorce",
      marriageId: "current-marriage",
      expectedVersion: 1,
      endDate: solarMonth(2025),
      source: source("ambiguous-marriage-change")
    });
    const selected = preview.changes.filter((change) => change.originKind !== "spouse_default").map((change) => change.id);

    expectStaleWithoutConversationWrites(service, preview, selected);
    expect(new FactQueries(database, workspaceId).listParentChild()).toEqual([]);
  });

  it.each([
    ["child", "孩子"],
    ["mother", "候选父母"]
  ] as const)("invalidates an unselected completion decision when the %s birth and row version change", (personId) => {
    const facts = new FactCommandService(database, workspaceId);
    seedPerson(facts, "father", "父亲", "male", solarMonth(1970));
    seedPerson(facts, "mother", "母亲", "female", solarMonth(1972));
    seedPerson(facts, "child", "孩子", "unknown", solarMonth(2000));
    seedMarriage(facts, "parents-marriage", "father", "mother");
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [
        existingPerson("father", "father", "父亲", "male"),
        existingPerson("child", "child", "孩子", "unknown"),
        newChild("observer", "旁观者")
      ],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    });
    const observer = preview.changes.find((change) => change.entityType === "person")!;

    facts.execute({
      type: "person.update",
      personId,
      expectedVersion: 1,
      patch: { birth: solarMonth(personId === "child" ? 2001 : 1973) },
      source: source(`${personId}-birth-change`)
    });

    expectStaleWithoutConversationWrites(service, preview, [observer.id]);
    expect(new FactQueries(database, workspaceId).getPerson(observer.entityId)).toBeNull();
  });

  it("invalidates an unselected completion decision when a persisted parent edge is added", () => {
    const facts = new FactCommandService(database, workspaceId);
    seedPerson(facts, "father", "父亲", "male");
    seedPerson(facts, "mother", "母亲", "female");
    seedPerson(facts, "recorded", "已记录母亲", "female");
    seedPerson(facts, "child", "孩子", "unknown");
    seedMarriage(facts, "parents-marriage", "father", "mother");
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [
        existingPerson("father", "father", "父亲", "male"),
        existingPerson("child", "child", "孩子", "unknown"),
        newChild("observer", "旁观者")
      ],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    });
    const observer = preview.changes.find((change) => change.entityType === "person")!;

    facts.execute({
      type: "parentChild.add",
      draft: { id: "new-parent-edge", workspaceId, parentId: "recorded", childId: "child", parentRole: "mother" },
      source: source("new-parent-edge")
    });

    expectStaleWithoutConversationWrites(service, preview, [observer.id]);
    expect(new FactQueries(database, workspaceId).getPerson(observer.entityId)).toBeNull();
  });

  it.each(["deleted", "versioned"] as const)("invalidates an unselected completion decision when a persisted parent edge is %s", (mutation) => {
    const facts = new FactCommandService(database, workspaceId);
    seedPerson(facts, "father", "父亲", "male");
    seedPerson(facts, "mother", "母亲", "female");
    seedPerson(facts, "child", "孩子", "unknown");
    seedMarriage(facts, "parents-marriage", "father", "mother");
    facts.execute({
      type: "parentChild.add",
      draft: { id: "existing-parent-edge", workspaceId, parentId: "father", childId: "child", parentRole: "father" },
      source: source("existing-parent-edge")
    });
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [
        existingPerson("father", "father", "父亲", "male"),
        existingPerson("child", "child", "孩子", "unknown"),
        newChild("observer", "旁观者")
      ],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    });
    const observer = preview.changes.find((change) => change.entityType === "person")!;

    if (mutation === "deleted") {
      facts.execute({ type: "fact.softDelete", entityType: "parent_child", entityId: "existing-parent-edge", expectedVersion: 1 });
    } else {
      database.prepare("UPDATE parent_child SET row_version = row_version + 1 WHERE id = ?").run("existing-parent-edge");
    }

    expectStaleWithoutConversationWrites(service, preview, [observer.id]);
    expect(new FactQueries(database, workspaceId).getPerson(observer.entityId)).toBeNull();
  });

  it("treats two explicitly stated parents in one draft as explicit facts without automatic completion", () => {
    const facts = new FactCommandService(database, workspaceId);
    seedPerson(facts, "father", "父亲", "male");
    seedPerson(facts, "mother", "母亲", "female");
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [
        existingPerson("father", "father", "父亲", "male"),
        existingPerson("mother", "mother", "母亲", "female"),
        newChild()
      ],
      parentChildFacts: [
        { parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 },
        { parentRef: "mother", childRef: "child", parentRole: "mother", sourceRef: null, confidence: 1 }
      ]
    });
    const relations = preview.changes.filter((change) => change.entityType === "parentChild");

    expect(relations).toHaveLength(2);
    expect(relations.every((change) => change.originKind === "explicit")).toBe(true);
    expect(preview.changes.some((change) => change.originKind === "spouse_default")).toBe(false);
    expect(preview.conflicts).toEqual([]);

    service.confirm(preview.id, preview.version, preview.changes.map((change) => change.id), {}, []);
    expect(new FactQueries(database, workspaceId).listParentChild()).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentId: "father", parentRole: "father", originKind: "explicit" }),
      expect.objectContaining({ parentId: "mother", parentRole: "mother", originKind: "explicit" })
    ]));
    expect(database.prepare("SELECT COUNT(*) FROM operation_group WHERE kind = 'conversation.confirm'").pluck().get()).toBe(1);
  });

  it("shows no-spouse information without blocking the explicit parent relation", () => {
    const service = new DraftService(database, workspaceId);
    const preview = service.stage(familyDraft);
    const relation = preview.changes.find((change) => change.entityType === "parentChild")!;

    expect(relation).toMatchObject({
      originKind: "explicit",
      selectedByDefault: true,
      parentCompletion: {
        status: "no_candidate",
        reason: expect.stringContaining("另一位父母")
      }
    });
    expect(preview.conflicts).toEqual([]);
    expect(() => service.confirm(preview.id, preview.version, preview.changes.map((change) => change.id), {}, [])).not.toThrow();
    expect(new FactQueries(database, workspaceId).listParentChild()).toHaveLength(1);
  });

  it("offers ambiguous persisted spouses as unselected server-planned choices and accepts at most one", () => {
    const facts = new FactCommandService(database, workspaceId);
    for (const [id, name, gender] of [["father", "父亲", "male"], ["former", "前配偶", "female"], ["current", "现配偶", "female"]] as const) {
      seedPerson(facts, id, name, gender);
    }
    seedMarriage(facts, "former-marriage", "father", "former", { status: "divorced", start: solarMonth(1990), end: solarMonth(1999) });
    seedMarriage(facts, "current-marriage", "father", "current", { start: solarMonth(2000) });
    const service = new DraftService(database, workspaceId);
    const preview = service.stage({
      ...familyDraft,
      candidatePeople: [existingPerson("father", "father", "父亲", "male"), newChild()],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    });
    const explicit = preview.changes.find((change) => change.entityType === "parentChild" && change.originKind === "explicit")!;
    const candidates = preview.changes.filter((change) => change.originKind === "spouse_default");

    expect(candidates).toHaveLength(2);
    expect(candidates.map((change) => change.selectedByDefault)).toEqual([false, false]);
    expect(candidates.map((change) => change.parentCompletion?.candidatePersonId).sort()).toEqual(["current", "former"]);
    expect(candidates.every((change) => change.dependsOnChangeIds.includes(explicit.id))).toBe(true);
    expect(new Set(candidates.map((change) => change.selectionGroupId))).toEqual(new Set([explicit.id]));
    expect(() => service.confirm(
      preview.id,
      preview.version,
      preview.changes.filter((change) => change.selectedByDefault || change === candidates[0]).map((change) => change.id),
      {},
      []
    )).not.toThrow();
    expect(new FactQueries(database, workspaceId).listParentChild().filter((edge) => edge.originKind === "spouse_default")).toHaveLength(1);

    const secondService = new DraftService(database, workspaceId);
    const secondPreview = secondService.stage({
      ...familyDraft,
      candidatePeople: [existingPerson("father", "father", "父亲", "male"), newChild("second-child", "另一个孩子")],
      parentChildFacts: [{ parentRef: "father", childRef: "second-child", parentRole: "father", sourceRef: null, confidence: 1 }]
    });
    const secondCandidates = secondPreview.changes.filter((change) => change.originKind === "spouse_default");
    expect(() => secondService.confirm(
      secondPreview.id,
      secondPreview.version,
      secondPreview.changes.filter((change) => change.selectedByDefault || secondCandidates.includes(change)).map((change) => change.id),
      {},
      []
    )).toThrowError(expect.objectContaining({ code: "INVALID_SELECTION" }));
  });

  it("keeps the explicit relation when automatic completion is cancelled and rejects missing automatic dependencies", () => {
    const facts = new FactCommandService(database, workspaceId);
    seedPerson(facts, "father", "父亲", "male");
    seedPerson(facts, "mother", "母亲", "female");
    seedMarriage(facts, "parents-marriage", "father", "mother");
    const draft: ConversationMutationDraft = {
      ...familyDraft,
      candidatePeople: [existingPerson("father", "father", "父亲", "male"), newChild()],
      parentChildFacts: [{ parentRef: "father", childRef: "child", parentRole: "father", sourceRef: null, confidence: 1 }]
    };

    const service = new DraftService(database, workspaceId);
    const preview = service.stage(draft);
    const explicit = preview.changes.find((change) => change.originKind === "explicit" && change.entityType === "parentChild")!;
    const automatic = preview.changes.find((change) => change.originKind === "spouse_default")!;
    const child = preview.changes.find((change) => change.entityType === "person")!;
    expect(() => service.confirm(preview.id, preview.version, [child.id, automatic.id], {}, [])).toThrow(/dependency/i);

    const cancellable = new DraftService(database, workspaceId);
    const cancellablePreview = cancellable.stage(draft);
    const selected = cancellablePreview.changes
      .filter((change) => change.originKind !== "spouse_default")
      .map((change) => change.id);
    cancellable.confirm(cancellablePreview.id, cancellablePreview.version, selected, {}, []);
    expect(new FactQueries(database, workspaceId).listParentChild()).toEqual([
      expect.objectContaining({ parentId: "father", parentRole: "father", originKind: "explicit" })
    ]);
    expect(explicit).toBeDefined();
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
