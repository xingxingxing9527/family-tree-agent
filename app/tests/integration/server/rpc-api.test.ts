import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebServer, type WebServer } from "../../../src/server/create-web-server.js";
import { createFamilyAgentService, type FamilyAgentService } from "../../../src/server/runtime/family-agent-service.js";
import { createFamilyRuntime, type FamilyRuntime } from "../../../src/server/runtime/family-runtime.js";

const personDraft = (displayName: string) => ({
  displayName,
  aliases: [],
  gender: "unknown" as const,
  birth: null,
  death: null,
  notes: null,
  sourceDescription: "HTTP integration test"
});

describe("typed family RPC API", () => {
  let dataRoot: string;
  let runtime: FamilyRuntime;
  let service: FamilyAgentService;
  let server: WebServer;

  const rpc = async (group: string, method: string, input: unknown) => {
    const response = await server.inject({
      method: "POST",
      url: `/api/rpc/${group}/${method}`,
      payload: { input }
    });
    return { response, body: response.json() };
  };

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "family-agent-rpc-"));
    runtime = await createFamilyRuntime({ dataRoot });
    const created = await runtime.createFamily("王氏家谱");
    if (!created.ok) throw new Error(created.error.message);
    service = createFamilyAgentService({ runtime });
    server = createWebServer({ runtime, service });
  });

  afterEach(async () => {
    await server.close();
    await service.dispose();
    await runtime.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("round-trips the core structured capability groups", async () => {
    const father = await rpc("people", "save", { draft: personDraft("王建国"), confirmWarnings: true });
    const child = await rpc("people", "save", { draft: personDraft("王强"), confirmWarnings: true });
    expect(father.body).toMatchObject({ ok: true });
    expect(child.body).toMatchObject({ ok: true });
    const fatherId = father.body.value.entityId as string;
    const childId = child.body.value.entityId as string;

    const fixtures = [
      ["people", "list", { limit: 100, offset: 0 }],
      ["relations", "addParentChild", { draft: { parentId: fatherId, childId, parentRole: "father", sourceDescription: "族谱" }, confirmWarnings: true }],
      ["lineages", "createLineage", { name: "王氏直系", founderPersonId: fatherId, description: null }],
      ["merges", "history", null],
      ["wiki", "list", { limit: 20, offset: 0 }],
      ["query", "workspaceSnapshot", null],
      ["chat", "authorize", { sessionId: "session-1", operation: "ask", payload: { question: "王强的父亲是谁", viewpointId: childId, selectedPersonId: fatherId } }],
      ["dataManagement", "listAudit", null]
    ] as const;

    for (const [group, method, input] of fixtures) {
      const result = await rpc(group, method, input);
      expect(result.response.statusCode, `${group}.${method}`).toBe(200);
      expect(result.body, `${group}.${method}`).toMatchObject({ ok: true });
    }
  });

  it("rejects unknown methods, envelope fields and input fields", async () => {
    const unknown = await rpc("people", "readDatabasePath", {});
    expect(unknown.response.statusCode).toBe(400);
    const prototypeKey = await rpc("people", "constructor", {});
    expect(prototypeKey.response.statusCode).toBe(400);

    const extraEnvelope = await server.inject({
      method: "POST",
      url: "/api/rpc/people/list",
      payload: { input: { limit: 10, offset: 0 }, extra: true }
    });
    expect(extraEnvelope.statusCode).toBe(400);

    const extraInput = await rpc("people", "list", { limit: 10, offset: 0, databasePath: "C:\\secret" });
    expect(extraInput.response.statusCode).toBe(400);
  });

  it("returns read-only person codes and distinguishes partial from complete child counts", async () => {
    const saved = await rpc("people", "save", { draft: personDraft("王强"), confirmWarnings: true });
    const personId = saved.body.value.entityId as string;
    const person = await rpc("people", "get", { personId });
    expect(person.body).toMatchObject({ ok: true, value: { person: { personCode: "P000001", rowVersion: 1 } } });

    const partial = await rpc("people", "getChildrenCountStatus", { personId });
    expect(partial.body).toEqual({ ok: true, value: { count: 0, completeness: "partial" } });
    const confirmed = await rpc("people", "setChildrenCompleteness", {
      personId,
      complete: true,
      sourceDescription: "管理员核对",
      expectedVersion: 1
    });
    expect(confirmed.body).toMatchObject({ ok: true, value: { saved: true, entityId: personId } });
    const complete = await rpc("people", "getChildrenCountStatus", { personId });
    expect(complete.body).toEqual({ ok: true, value: { count: 0, completeness: "complete" } });
  });

  it("stages and atomically confirms browser mutations while synchronizing the family origin", async () => {
    const staged = await rpc("mutations", "stage", { intents: [{ type: "person.create", draft: personDraft("王建国") }] });
    expect(staged.response.statusCode).toBe(200);
    expect(staged.body).toMatchObject({ ok: true, value: { version: 1, changes: [{ disposition: "create" }] } });

    const preview = staged.body.value;
    const confirmed = await rpc("mutations", "confirm", {
      draftId: preview.id,
      draftVersion: preview.version,
      selectedChangeIds: [preview.changes[0].id],
      acknowledgedWarningCodes: []
    });
    expect(confirmed.body).toMatchObject({ ok: true, value: { operationGroupId: expect.any(String), changedEntityIds: [expect.any(String)] } });

    const families = await runtime.listFamilies();
    expect(families).toMatchObject({ ok: true, value: [{ originPersonId: confirmed.body.value.changedEntityIds[0] }] });
  });

  it("plans a relative path through the allowlisted Web RPC", async () => {
    const anchor = await rpc("people", "save", { draft: { ...personDraft("王小明"), gender: "male" }, confirmWarnings: true });
    const target = await rpc("people", "save", { draft: { ...personDraft("王守义"), gender: "male" }, confirmWarnings: true });
    const candidate = await rpc("people", "save", { draft: { ...personDraft("王建国"), gender: "male" }, confirmWarnings: true });
    const planned = await rpc("relations", "planRelativePath", {
      anchorId: anchor.body.value.entityId,
      targetId: target.body.value.entityId,
      templateId: "grandparent",
      selectedIntermediaryIds: {}
    });

    expect(planned.response.statusCode).toBe(200);
    expect(planned.body).toMatchObject({ ok: true, value: {
      templateId: "grandparent",
      requiredSelections: [{ role: "parent", candidateIds: [candidate.body.value.entityId] }],
      intents: []
    } });
  });

  it("plans and scans parent completion through the allowlisted read API without exposing private state", async () => {
    const father = await rpc("people", "save", { draft: { ...personDraft("王建国"), gender: "male" }, confirmWarnings: true });
    const mother = await rpc("people", "save", { draft: { ...personDraft("李秀兰"), gender: "female" }, confirmWarnings: true });
    const child = await rpc("people", "save", { draft: personDraft("王强"), confirmWarnings: true });
    const fatherId = father.body.value.entityId as string;
    const motherId = mother.body.value.entityId as string;
    const childId = child.body.value.entityId as string;
    await rpc("relations", "addMarriage", {
      draft: { spouseAId: fatherId, spouseBId: motherId, start: null, sourceDescription: "结婚证" },
      confirmWarnings: true
    });
    await rpc("relations", "addParentChild", {
      draft: { parentId: fatherId, childId, parentRole: "father", sourceDescription: "出生证" },
      confirmWarnings: true
    });

    const planned = await rpc("relations", "planParentCompletion", {
      knownParentId: fatherId,
      childId,
      parentRole: "father"
    });
    const scanned = await rpc("relations", "scanParentCompletions", {});

    expect(planned.response.statusCode).toBe(200);
    expect(planned.body).toMatchObject({
      ok: true,
      value: {
        status: "suggested",
        suggested: { parentId: motherId, parentName: "李秀兰", childId, childName: "王强", parentRole: "mother" },
        candidates: [{ personId: motherId, personName: "李秀兰", marriageEpisodes: [{ status: "active" }], reason: expect.any(String) }],
        evidence: expect.any(Array)
      }
    });
    expect(scanned.body).toMatchObject({
      ok: true,
      value: {
        counts: { total: 1, safe: 1, ambiguous: 0, noCandidate: 0, conflict: 0 },
        items: [{ childId, childName: "王强", classification: "safe" }]
      }
    });
    expect(JSON.stringify({ planned: planned.body, scanned: scanned.body })).not.toMatch(/planningFingerprint|databasePath|mediaPath|[A-Z]:\\/u);
  });

  it.each([
    { knownParentId: "", childId: "child", parentRole: "father" },
    { knownParentId: "known", childId: "child", parentRole: "father", selectedSpouseId: "" },
    { knownParentId: "same", childId: "same", parentRole: "mother" }
  ])("rejects invalid parent completion identifiers before service execution", async (input) => {
    const planned = await rpc("relations", "planParentCompletion", input);
    expect(planned.response.statusCode).toBe(400);
    expect(planned.body).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it.each([
    ["planParentCompletion", { knownParentId: "missing-parent", childId: "missing-child", parentRole: "father" }],
    ["scanParentCompletions", {}]
  ] as const)("holds relations.%s behind workspace replacement exclusivity", async (method, input) => {
    const lease = await runtime.mutationGate.acquireExclusive();
    let settled = false;
    const pending = rpc("relations", method, input).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    lease.release();

    expect((await pending).response.statusCode).toBe(200);
  });

  it("does not serialize filesystem paths", async () => {
    const snapshot = await rpc("query", "workspaceSnapshot", null);
    expect(snapshot.response.statusCode).toBe(200);
    expect(JSON.stringify(snapshot.body)).not.toMatch(/[A-Z]:\\|databasePath|mediaPath/u);
  });
});
