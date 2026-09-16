import { describe, expect, it } from "vitest";
import { registerWorkspaceIpc, WORKSPACE_CHANNELS } from "../../../src/main/ipc/register-ipc";
import type { WorkspaceManager } from "../../../src/main/workspaces/workspace-manager";

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
});
