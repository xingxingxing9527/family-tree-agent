import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_CHANNELS, ControlledChatGateway, DisclosureCapabilityService, registerChatIpc, WorkspaceChatGateway } from "../../../src/main/ipc/chat-ipc";
import { ConversationService } from "../../../src/main/application/chat/conversation-service";
import { DraftService } from "../../../src/main/application/chat/draft-service";
import { QueryToolRegistry } from "../../../src/main/application/query/query-tool-registry";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";
import type { ConversationMutationDraft } from "../../../src/shared/chat";
import { WorkspaceMutationGate } from "../../../src/main/workspaces/workspace-mutation-gate";

const workspaceId = "workspace-controlled-chat";
const emptyDraft: ConversationMutationDraft = {
  candidatePeople: [], parentChildFacts: [], marriages: [], sources: [], fieldConfidence: [], unresolvedReferences: []
};

describe("controlled conversational model boundary", () => {
  const roots: string[] = [];
  let database: WorkspaceDatabase;
  beforeEach(() => { database = openDatabase(":memory:"); applyMigrations(database); });
  afterEach(async () => { database.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it.each(["stage", "ask"] as const)("drains a delayed chat %s before restore can dispose the old workspace runtime", async (operation) => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-chat-drain-"));
    roots.push(root);
    const databasePath = join(root, "genealogy.sqlite");
    const stored = openDatabase(databasePath);
    applyMigrations(stored);
    stored.close();
    let context: { workspaceId: string; databasePath: string } | null = { workspaceId, databasePath };
    let started!: () => void;
    let resume!: () => void;
    const modelStarted = new Promise<void>((resolve) => { started = resolve; });
    const modelCanFinish = new Promise<void>((resolve) => { resume = resolve; });
    const model = {
      extractDraft: vi.fn(async () => { started(); await modelCanFinish; return emptyDraft; }),
      continueWithTools: vi.fn()
        .mockImplementationOnce(async () => { started(); await modelCanFinish; return { answer: null, toolCalls: [{ callId: "one", name: "search_people", arguments: { query: "nobody", limit: 1 } }] }; })
        .mockResolvedValueOnce({ answer: "没有找到。", toolCalls: [] })
    };
    const gateway = new WorkspaceChatGateway({ getOpenWorkspaceContext: () => context }, { readKey: async () => "sk-test" }, () => model as never);
    const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => Promise<unknown>>();
    const gate = new WorkspaceMutationGate();
    registerChatIpc({ handle: (channel, handler) => { handlers.set(channel, handler as never); } } as never, () => 7, gateway, gate);
    const payload = operation === "stage"
      ? { text: "录入一个人", candidatePeople: [] }
      : { question: "有谁？", viewpointId: "viewpoint", selectedPersonId: null };
    const authorized = await gateway.authorize({ sessionId: "session", operation: operation === "stage" ? "extract" : "ask", payload });
    if (!authorized.ok) throw new Error("authorization fixture failed");
    const pending = handlers.get(operation === "stage" ? CHAT_CHANNELS.stageMutation : CHAT_CHANNELS.ask)!({ sender: { id: 7 } }, {
      sessionId: "session", authorizationToken: authorized.value.authorizationToken, payload
    });
    await modelStarted;
    let exclusiveGranted = false;
    const exclusive = gate.acquireExclusive().then((lease) => { exclusiveGranted = true; return lease; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const grantedBeforeModelFinished = exclusiveGranted;
    resume();
    await expect(pending).resolves.toMatchObject({ ok: true });
    const lease = await exclusive;
    context = null;
    gateway.dispose();
    const moved = `${root}-moved`;
    await rename(root, moved);
    roots[roots.indexOf(root)] = moved;
    lease.release();
    expect(grantedBeforeModelFinished).toBe(false);
  });

  it("bounds outstanding disclosure capabilities while preserving single-use semantics", () => {
    const capabilities = new DisclosureCapabilityService(() => 0, 60_000, 2);
    const binding = { workspaceId, sessionId: "session", operation: "ask" as const, payload: { question: "q" } };
    const first = capabilities.issue(binding); capabilities.issue({ ...binding, payload: { question: "q2" } });
    const latest = capabilities.issue({ ...binding, payload: { question: "q3" } });
    expect(capabilities.consume(first.authorizationToken, binding)).toBe(false);
    expect(capabilities.consume(latest.authorizationToken, { ...binding, payload: { question: "q3" } })).toBe(true);
    expect(capabilities.consume(latest.authorizationToken, { ...binding, payload: { question: "q3" } })).toBe(false);
  });

  it("requires a short-lived single-use main-process capability bound to the exact payload", async () => {
    const model = { extractDraft: vi.fn().mockResolvedValue(emptyDraft), continueWithTools: vi.fn() };
    const drafts = new DraftService(database, workspaceId, model);
    const gateway = new ControlledChatGateway(
      () => ({ workspaceId }), new DisclosureCapabilityService(), drafts,
      new ConversationService(model, new QueryToolRegistry(database, workspaceId))
    );
    const payload = { text: "张国强有两个孩子", candidatePeople: [] };

    await expect(gateway.stageMutation({ sessionId: "session-1", authorizationToken: "missing", payload }))
      .resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
    expect(model.extractDraft).not.toHaveBeenCalled();

    const authorized = await gateway.authorize({ sessionId: "session-1", operation: "extract", payload });
    expect(authorized.ok).toBe(true); if (!authorized.ok) return;
    await expect(gateway.stageMutation({ sessionId: "session-1", authorizationToken: authorized.value.authorizationToken, payload: { ...payload, text: "tampered" } }))
      .resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
    expect(model.extractDraft).not.toHaveBeenCalled();

    const second = await gateway.authorize({ sessionId: "session-1", operation: "extract", payload });
    if (!second.ok) return;
    await expect(gateway.stageMutation({ sessionId: "session-1", authorizationToken: second.value.authorizationToken, payload }))
      .resolves.toMatchObject({ ok: true, value: { workspaceId } });
    expect(model.extractDraft).toHaveBeenCalledTimes(1);
    await expect(gateway.stageMutation({ sessionId: "session-1", authorizationToken: second.value.authorizationToken, payload }))
      .resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
    expect(model.extractDraft).toHaveBeenCalledTimes(1);
  });

  it("does not read the encrypted key or construct a provider client before live IPC authorization", async () => {
    const vault = { readKey: vi.fn().mockResolvedValue("sk-runtime") };
    const model = { extractDraft: vi.fn().mockResolvedValue(emptyDraft), continueWithTools: vi.fn() };
    const modelFactory = vi.fn(() => model);
    const gateway = new WorkspaceChatGateway(
      { getOpenWorkspaceContext: () => ({ workspaceId, databasePath: ":memory:" }) },
      vault, modelFactory, new DisclosureCapabilityService()
    );
    const payload = { text: "张国强有两个孩子", candidatePeople: [] };
    await expect(gateway.stageMutation({ sessionId: "session", authorizationToken: "missing", payload }))
      .resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
    expect(vault.readKey).not.toHaveBeenCalled(); expect(modelFactory).not.toHaveBeenCalled();

    const authorized = await gateway.authorize({ sessionId: "session", operation: "extract", payload });
    if (!authorized.ok) return;
    await expect(gateway.stageMutation({ sessionId: "session", authorizationToken: authorized.value.authorizationToken, payload })).resolves.toMatchObject({ ok: true });
    expect(vault.readKey).toHaveBeenCalledTimes(1); expect(modelFactory).toHaveBeenCalledWith("sk-runtime");
    gateway.dispose();
  });

  it("maps provider failure to MODEL_UNAVAILABLE while the six deterministic local tools remain usable", async () => {
    const model = { extractDraft: vi.fn(), continueWithTools: vi.fn().mockRejectedValue(new Error("provider leaked details")) };
    const registry = new QueryToolRegistry(database, workspaceId);
    const gateway = new ControlledChatGateway(
      () => ({ workspaceId }), new DisclosureCapabilityService(), new DraftService(database, workspaceId, model),
      new ConversationService(model, registry)
    );
    const payload = { question: "有几个人？", viewpointId: "viewpoint", selectedPersonId: null };
    const authorized = await gateway.authorize({ sessionId: "session", operation: "ask", payload });
    if (!authorized.ok) return;
    await expect(gateway.ask({ sessionId: "session", authorizationToken: authorized.value.authorizationToken, payload }))
      .resolves.toEqual({ ok: false, error: { code: "MODEL_UNAVAILABLE", message: "The online model is unavailable" } });
    expect(Object.keys(registry.tools)).toEqual([
      "search_people", "get_person", "list_relatives", "calculate_relationship", "summarize_lineage", "search_wiki"
    ]);
    expect(registry.tools.search_people({ query: "nobody", limit: 20 })).toEqual([]);
  });

  it("runs a bounded allowlisted tool loop and returns deterministic evidence", async () => {
    const model = {
      extractDraft: vi.fn(),
      continueWithTools: vi.fn()
        .mockResolvedValueOnce({ answer: null, toolCalls: [{ callId: "call-1", name: "search_people", arguments: { query: "张", limit: 20 } }] })
        .mockResolvedValueOnce({ answer: "没有找到匹配人物。", toolCalls: [] })
    };
    const service = new ConversationService(model, new QueryToolRegistry(database, workspaceId), { maxTurns: 3 });
    await expect(service.ask({ question: "查找张姓", viewpointId: "v", selectedPersonId: null })).resolves.toMatchObject({
      status: "answered", conclusion: "没有找到匹配人物。", answer: "没有找到匹配人物。", matchedPersonIds: [], sourceIds: [], relationship: null,
      toolTrace: [{ name: "search_people", arguments: { query: "张", limit: 20 } }]
    });
    expect(model.continueWithTools.mock.calls[1]![0].toolResults[0]).toMatchObject({ callId: "call-1", name: "search_people", output: [] });
  });

  it("rejects terminal answers without deterministic tool evidence", async () => {
    const model = { extractDraft: vi.fn(), continueWithTools: vi.fn().mockResolvedValue({ answer: "编造答案", toolCalls: [] }) };
    await expect(new ConversationService(model, new QueryToolRegistry(database, workspaceId)).ask({ question: "q", viewpointId: "v", selectedPersonId: null }))
      .rejects.toThrow(/evidence|tool/i);
  });

  it("bounds calls per response, duplicate call IDs, and cumulative calls", async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ callId: `call-${index}`, name: "search_people", arguments: { query: "张", limit: 1 } }));
    const duplicate = [
      { callId: "same", name: "search_people", arguments: { query: "张", limit: 1 } },
      { callId: "same", name: "search_people", arguments: { query: "李", limit: 1 } }
    ];
    for (const toolCalls of [many, duplicate]) {
      const model = { extractDraft: vi.fn(), continueWithTools: vi.fn().mockResolvedValue({ answer: null, toolCalls }) };
      await expect(new ConversationService(model as never, new QueryToolRegistry(database, workspaceId)).ask({ question: "q", viewpointId: "v", selectedPersonId: null }))
        .rejects.toThrow(/call|duplicate|limit/i);
    }
    const four = (offset: number) => Array.from({ length: 4 }, (_, index) => ({ callId: `call-${offset + index}`, name: "search_people", arguments: { query: "张", limit: 1 } }));
    const cumulative = { extractDraft: vi.fn(), continueWithTools: vi.fn()
      .mockResolvedValueOnce({ answer: null, toolCalls: four(0) })
      .mockResolvedValueOnce({ answer: null, toolCalls: four(4) })
      .mockResolvedValueOnce({ answer: null, toolCalls: [{ callId: "call-8", name: "search_people", arguments: { query: "张", limit: 1 } }] }) };
    await expect(new ConversationService(cumulative as never, new QueryToolRegistry(database, workspaceId), { maxTurns: 4 }).ask({ question: "q", viewpointId: "v", selectedPersonId: null }))
      .rejects.toThrow(/limit/i);

    const contextModel = { extractDraft: vi.fn(), continueWithTools: vi.fn().mockResolvedValue({ answer: null, toolCalls: four(20) }) };
    const largeRegistry = { tools: { search_people: () => [{ id: "p", displayName: "x".repeat(20_000), aliases: [], gender: "unknown", birth: null, parentHints: [] }] } };
    await expect(new ConversationService(contextModel as never, largeRegistry as never).ask({ question: "q", viewpointId: "v", selectedPersonId: null }))
      .rejects.toThrow(/context|size/i);
  });
});
