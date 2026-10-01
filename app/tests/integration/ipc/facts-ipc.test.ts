import { describe, expect, it, vi } from "vitest";
import type { AppResult, FactMutationReceipt, ParentCompletionPlanDto, ParentCompletionScanDto, PersonDetailReadModel, PersonListItem } from "../../../src/shared/contracts";
import { FACT_CHANNELS, registerFactsIpc, type FactsGateway } from "../../../src/main/ipc/facts-ipc";
import { WorkspaceMutationGate } from "../../../src/main/workspaces/workspace-mutation-gate";

type Handler = (event: { sender: { id: number } }, payload?: unknown) => Promise<unknown> | unknown;

const person: PersonListItem = {
  id: "person-1",
  personCode: "P000001",
  displayName: "张敏",
  aliases: ["敏敏"],
  gender: "female",
  birth: null,
  death: null,
  notes: null,
  rowVersion: 1
};

const detail: PersonDetailReadModel = {
  person,
  aliases: person.aliases,
  parents: [],
  children: [],
  marriages: []
};

const mutation: AppResult<FactMutationReceipt> = {
  ok: true,
  value: { entityId: "person-1", saved: true, warnings: [] }
};

const completionPlan: ParentCompletionPlanDto = {
  status: "no_candidate",
  basis: null,
  explicit: { parentId: "person-1", parentName: "张敏", childId: "child-1", childName: "孩子", parentRole: "mother" },
  candidates: [],
  issues: [],
  evidence: []
};

const completionScan: ParentCompletionScanDto = {
  counts: { total: 0, safe: 0, ambiguous: 0, noCandidate: 0, conflict: 0 },
  items: []
};

function gateway(): FactsGateway {
  return {
    listPeople: vi.fn().mockResolvedValue({ ok: true, value: [person] }),
    getPerson: vi.fn().mockResolvedValue({ ok: true, value: detail }),
    savePerson: vi.fn().mockResolvedValue(mutation),
    updatePerson: vi.fn().mockResolvedValue(mutation),
    setChildrenCompleteness: vi.fn().mockResolvedValue(mutation),
    getChildrenCountStatus: vi.fn().mockResolvedValue({ ok: true, value: { count: 0, completeness: "partial" } }),
    addParentChild: vi.fn().mockResolvedValue(mutation),
    addMarriage: vi.fn().mockResolvedValue(mutation),
    divorce: vi.fn().mockResolvedValue(mutation),
    planParentCompletion: vi.fn().mockResolvedValue({ ok: true, value: completionPlan }),
    scanParentCompletions: vi.fn().mockResolvedValue({ ok: true, value: completionScan })
  };
}

function setup(facts = gateway(), gate?: WorkspaceMutationGate): { facts: FactsGateway; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  registerFactsIpc({ handle: (channel, handler) => handlers.set(channel, handler as Handler) }, () => 7, facts, gate);
  return { facts, handlers };
}

describe("facts IPC contracts", () => {
  it("registers the exact people and relationship channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(Object.values(FACT_CHANNELS).sort());
  });

  it.each([
    [FACT_CHANNELS.peopleList, { limit: 0, offset: 0 }],
    [FACT_CHANNELS.peopleGet, { personId: "" }],
    [FACT_CHANNELS.peopleSave, { draft: { displayName: "" }, confirmWarnings: false }],
    [FACT_CHANNELS.peopleUpdate, { personId: "person-1", patch: {}, expectedVersion: 0, confirmWarnings: false }],
    [FACT_CHANNELS.childrenCompletenessSet, { personId: "person-1", complete: true, sourceDescription: "核对", expectedVersion: 0 }],
    [FACT_CHANNELS.childrenCountStatus, { personId: "" }],
    [FACT_CHANNELS.addParentChild, { draft: { parentId: "same", childId: "same", parentRole: "father", sourceDescription: "手录" }, confirmWarnings: false }],
    [FACT_CHANNELS.addMarriage, { draft: { spouseAId: "a", spouseBId: "b", start: null }, confirmWarnings: false }],
    [FACT_CHANNELS.divorce, { marriageId: "m", endDate: { calendar: "lunar", year: 2024, month: 2, day: 31, leapMonth: false, precision: "day" }, expectedVersion: 1 }],
    [FACT_CHANNELS.divorce, { marriageId: "m", endDate: { calendar: "solar", year: 2024, month: 2, day: 30, leapMonth: false, precision: "day" }, expectedVersion: 1 }],
    [FACT_CHANNELS.planParentCompletion, { knownParentId: "", childId: "child", parentRole: "father" }],
    [FACT_CHANNELS.planParentCompletion, { knownParentId: "known", childId: "child", parentRole: "father", selectedSpouseId: "" }],
    [FACT_CHANNELS.planParentCompletion, { knownParentId: "same", childId: "same", parentRole: "mother" }],
    [FACT_CHANNELS.scanParentCompletions, { unexpected: true }]
  ])("rejects malformed payloads on %s before invoking the gateway", async (channel, payload) => {
    const { facts, handlers } = setup();
    const result = await handlers.get(channel)!({ sender: { id: 7 } }, payload);
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION", message: "Invalid request" } });
    expect(Object.values(facts).every((method) => !vi.mocked(method).mock.calls.length)).toBe(true);
  });

  it("rejects every facts call from a non-main-window sender", async () => {
    const { facts, handlers } = setup();
    const result = await handlers.get(FACT_CHANNELS.peopleList)!({ sender: { id: 9 } }, { limit: 20, offset: 0 });
    expect(result).toEqual({ ok: false, error: { code: "PATH_DENIED", message: "IPC sender was denied" } });
    expect(facts.listPeople).not.toHaveBeenCalled();
  });

  it("forwards parsed payloads without adding workspace paths", async () => {
    const { facts, handlers } = setup();
    const result = await handlers.get(FACT_CHANNELS.peopleList)!({ sender: { id: 7 } }, { query: "敏敏", limit: 20, offset: 0 });
    expect(result).toEqual({ ok: true, value: [person] });
    expect(facts.listPeople).toHaveBeenCalledWith({ query: "敏敏", limit: 20, offset: 0 });
  });

  it.each([
    [FACT_CHANNELS.planParentCompletion, { knownParentId: "person-1", childId: "child-1", parentRole: "mother", selectedSpouseId: "spouse-1" }, completionPlan],
    [FACT_CHANNELS.scanParentCompletions, {}, completionScan]
  ] as const)("runs %s through the workspace operation gate", async (channel, payload, expected) => {
    const gate = new WorkspaceMutationGate();
    const lease = await gate.acquireExclusive();
    const { handlers } = setup(gateway(), gate);
    let settled = false;
    const pending = Promise.resolve(handlers.get(channel)!({ sender: { id: 7 } }, payload)).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    lease.release();

    await expect(pending).resolves.toEqual({ ok: true, value: expected });
  });

  it("sanitizes unexpected exceptions without returning SQL, paths, or stacks", async () => {
    const facts = gateway();
    vi.mocked(facts.getPerson).mockRejectedValue(new Error("SQL SELECT secret FROM person at C:\\private\\genealogy.sqlite"));
    const { handlers } = setup(facts);

    const result = await handlers.get(FACT_CHANNELS.peopleGet)!({ sender: { id: 7 } }, { personId: "person-1" });

    expect(result).toEqual({ ok: false, error: { code: "INTERNAL", message: "Unable to complete facts request" } });
    expect(JSON.stringify(result)).not.toMatch(/SELECT|genealogy\.sqlite|private|stack/i);
  });
});
