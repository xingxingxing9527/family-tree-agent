import { describe, expect, it, vi } from "vitest";
import { registerWikiIpc, WIKI_CHANNELS, type WikiGateway } from "../../../src/main/ipc/wiki-ipc";

type Handler = (event: { sender: { id: number } }, input: unknown) => Promise<unknown>;
const wikiId = "11111111-1111-4111-8111-111111111111";

function gateway(): WikiGateway {
  return {
    list: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    get: vi.fn()
  } as unknown as WikiGateway;
}

function setup(api = gateway()): { api: WikiGateway; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  registerWikiIpc({ handle: (channel, handler) => handlers.set(channel, handler as Handler) }, () => 7, api);
  return { api, handlers };
}

describe("wiki IPC contracts", () => {
  it("registers the bounded list channel and rejects extra fields before invoking the gateway", async () => {
    const { api, handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(Object.values(WIKI_CHANNELS).sort());

    await expect(handlers.get(WIKI_CHANNELS.list)!({ sender: { id: 7 } }, { limit: 101, offset: 0 }))
      .resolves.toEqual({ ok: false, error: { code: "VALIDATION", message: "Invalid request" } });
    await expect(handlers.get(WIKI_CHANNELS.list)!({ sender: { id: 7 } }, { limit: 20, offset: 0, databasePath: "C:\\private\\family.sqlite" }))
      .resolves.toEqual({ ok: false, error: { code: "VALIDATION", message: "Invalid request" } });
    expect(api.list).not.toHaveBeenCalled();

    await expect(handlers.get(WIKI_CHANNELS.list)!({ sender: { id: 7 } }, { limit: 20, offset: 0 })).resolves.toEqual({ ok: true, value: [] });
    expect(api.list).toHaveBeenCalledWith({ limit: 20, offset: 0 });
  });

  it("sender-checks every call and sanitizes thrown or internal details", async () => {
    const api = gateway();
    vi.mocked(api.get).mockRejectedValue(new Error("SQL SELECT secret at C:\\private\\genealogy.sqlite"));
    vi.mocked(api.remove).mockResolvedValue({ ok: false, error: { code: "INTERNAL", message: "stack C:\\secret" } });
    const { handlers } = setup(api);

    await expect(handlers.get(WIKI_CHANNELS.get)!({ sender: { id: 9 } }, { wikiEntryId: wikiId }))
      .resolves.toEqual({ ok: false, error: { code: "PATH_DENIED", message: "IPC sender was denied" } });
    expect(api.get).not.toHaveBeenCalled();

    const thrown = await handlers.get(WIKI_CHANNELS.get)!({ sender: { id: 7 } }, { wikiEntryId: wikiId });
    const internal = await handlers.get(WIKI_CHANNELS.remove)!({ sender: { id: 7 } }, { wikiEntryId: wikiId, expectedVersion: 1 });
    expect(thrown).toEqual({ ok: false, error: { code: "INTERNAL", message: "Unable to complete wiki request" } });
    expect(internal).toEqual(thrown);
    expect(JSON.stringify([thrown, internal])).not.toMatch(/SELECT|genealogy|private|stack|secret/i);
  });
});
