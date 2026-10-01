import { describe, expect, it } from "vitest";
import { registerWorkspaceIpc, WORKSPACE_CHANNELS } from "../../../src/main/ipc/register-ipc";
import type { WorkspaceManager } from "../../../src/main/workspaces/workspace-manager";
import { RPC_INPUT_SCHEMAS } from "../../../src/shared/api-schemas";

describe("workspace IPC contracts", () => {
  it("rejects malformed payloads before calling workspace operations", async () => {
    const handlers = new Map<string, (event: { sender: { id: number } }, payload?: unknown) => Promise<unknown>>();
    const manager = { create: async () => { throw new Error("must not run"); }, list: async () => ({ ok: true, value: [] }), open: async () => ({ ok: true, value: {} }), close: async () => ({ ok: true, value: null }) } as unknown as WorkspaceManager;
    registerWorkspaceIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) }, () => 7, manager);
    await expect(Promise.resolve(handlers.get(WORKSPACE_CHANNELS.create)!({ sender: { id: 7 } }, { name: "" }))).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("rejects calls from a sender other than the main application window", async () => {
    const handlers = new Map<string, (event: { sender: { id: number } }, payload?: unknown) => Promise<unknown>>();
    const manager = { create: async () => ({ ok: true, value: {} }), list: async () => ({ ok: true, value: [] }), open: async () => ({ ok: true, value: {} }), close: async () => ({ ok: true, value: null }) } as unknown as WorkspaceManager;
    registerWorkspaceIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) }, () => 7, manager);
    await expect(Promise.resolve(handlers.get(WORKSPACE_CHANNELS.list)!({ sender: { id: 9 } }))).resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
  });

  it("accepts only the server-planned parent family intent fields", () => {
    const valid = {
      type: "parentFamily.add",
      knownParentId: "known",
      childId: "child",
      parentRole: "father",
      completionPolicy: "spouse-default",
      selectedSpouseId: "spouse",
      skipCompletion: false,
      sourceDescription: "出生证明"
    };
    expect(RPC_INPUT_SCHEMAS.mutations.stage.safeParse({ intents: [valid] }).success).toBe(true);
    expect(RPC_INPUT_SCHEMAS.mutations.stage.safeParse({ intents: [{
      ...valid,
      candidateParentId: "client-forged",
      originKind: "spouse_default"
    }] }).success).toBe(false);
  });

  it("keeps legacy marriage drafts compatible while requiring an end for divorced events", () => {
    const legacy = {
      spouseAId: "spouse-a",
      spouseBId: "spouse-b",
      start: null,
      sourceDescription: "旧版表单"
    };
    const end = { calendar: "solar" as const, year: 2018, month: 6, day: null, leapMonth: false, precision: "month" as const };
    const divorced = { ...legacy, status: "divorced", end };

    expect(RPC_INPUT_SCHEMAS.relations.addMarriage.safeParse({ draft: legacy, confirmWarnings: false }).success).toBe(true);
    expect(RPC_INPUT_SCHEMAS.relations.addMarriage.safeParse({ draft: divorced, confirmWarnings: false }).success).toBe(true);
    expect(RPC_INPUT_SCHEMAS.mutations.stage.safeParse({ intents: [{ type: "marriage.add", draft: divorced }] }).success).toBe(true);
    expect(RPC_INPUT_SCHEMAS.relations.addMarriage.safeParse({
      draft: { ...legacy, status: "divorced", end: null },
      confirmWarnings: false
    }).success).toBe(false);
    expect(RPC_INPUT_SCHEMAS.mutations.stage.safeParse({
      intents: [{ type: "marriage.add", draft: { ...legacy, status: "divorced" } }]
    }).success).toBe(false);
  });

  it("enforces the public 1000-intent and 2000-selected-change bounds", () => {
    const intent = { type: "lineage.create", name: "长房", founderPersonId: "founder", description: null };
    expect(RPC_INPUT_SCHEMAS.mutations.stage.safeParse({ intents: Array.from({ length: 1_000 }, () => intent) }).success).toBe(true);
    expect(RPC_INPUT_SCHEMAS.mutations.stage.safeParse({ intents: Array.from({ length: 1_001 }, () => intent) }).success).toBe(false);
    const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
    const confirm = (count: number) => ({
      draftId: uuid(9_999),
      draftVersion: 1,
      selectedChangeIds: Array.from({ length: count }, (_, index) => uuid(index)),
      acknowledgedWarningCodes: []
    });
    expect(RPC_INPUT_SCHEMAS.mutations.confirm.safeParse(confirm(2_000)).success).toBe(true);
    expect(RPC_INPUT_SCHEMAS.mutations.confirm.safeParse(confirm(2_001)).success).toBe(false);
  });
});
