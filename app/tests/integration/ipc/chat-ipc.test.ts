import { describe, expect, it, vi } from "vitest";
import { CHAT_CHANNELS, MODEL_SETTINGS_CHANNELS, registerChatIpc, registerModelSettingsIpc, type ChatGateway } from "../../../src/main/ipc/chat-ipc";

describe("chat IPC", () => {
  it("rejects untrusted senders and extra fields before issuing an online capability", async () => {
    const authorize = vi.fn().mockResolvedValue({ ok: true, value: { authorizationToken: "token", expiresAt: "2099-01-01T00:00:00Z" } });
    const gateway = { authorize, stageMutation: vi.fn(), ask: vi.fn(), confirm: vi.fn(), revise: vi.fn() } as unknown as ChatGateway;
    const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => Promise<unknown>>();
    registerChatIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) }, () => 7, gateway);
    const payload = { sessionId: "session", operation: "ask", payload: { question: "q", viewpointId: "v", selectedPersonId: null } };

    await expect(handlers.get(CHAT_CHANNELS.authorize)!({ sender: { id: 9 } }, payload)).resolves.toMatchObject({ ok: false, error: { code: "PATH_DENIED" } });
    await expect(handlers.get(CHAT_CHANNELS.authorize)!({ sender: { id: 7 } }, { ...payload, confirmed: true })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(authorize).not.toHaveBeenCalled();
    await expect(handlers.get(CHAT_CHANNELS.authorize)!({ sender: { id: 7 } }, payload)).resolves.toMatchObject({ ok: true });
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("validates edited immutable drafts with the shared mutation schema", async () => {
    const revise = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const gateway = { authorize: vi.fn(), stageMutation: vi.fn(), ask: vi.fn(), confirm: vi.fn(), revise } as unknown as ChatGateway;
    const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => Promise<unknown>>();
    registerChatIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) }, () => 7, gateway);
    await expect(handlers.get(CHAT_CHANNELS.revise)!({ sender: { id: 7 } }, {
      draftId: "draft", replacement: { candidatePeople: [], parentChildFacts: [], marriages: [], sources: [], fieldConfidence: [], unresolvedReferences: [], sql: "DELETE" }
    })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(revise).not.toHaveBeenCalled();
  });
});

describe("model settings IPC", () => {
  it("keeps keys write-only at the renderer boundary and validates before encryption", async () => {
    const vault = { readKey: vi.fn().mockResolvedValue("sk-never-return"), saveKey: vi.fn().mockResolvedValue(undefined), clearKey: vi.fn().mockResolvedValue(undefined) };
    const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => Promise<unknown>>();
    registerModelSettingsIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) }, () => 7, vault);

    await expect(handlers.get(MODEL_SETTINGS_CHANNELS.status)!({ sender: { id: 7 } })).resolves.toEqual({ ok: true, value: { configured: true } });
    expect(JSON.stringify(await handlers.get(MODEL_SETTINGS_CHANNELS.status)!({ sender: { id: 7 } }))).not.toContain("sk-never-return");
    await expect(handlers.get(MODEL_SETTINGS_CHANNELS.saveKey)!({ sender: { id: 7 } }, { key: "x", plaintextPath: "C:\\secret" }))
      .resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(vault.saveKey).not.toHaveBeenCalled();
    await expect(handlers.get(MODEL_SETTINGS_CHANNELS.saveKey)!({ sender: { id: 7 } }, { key: "sk-new" })).resolves.toEqual({ ok: true, value: null });
    expect(vault.saveKey).toHaveBeenCalledWith("sk-new");
  });
});
