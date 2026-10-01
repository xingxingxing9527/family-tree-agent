import { afterEach, describe, expect, it } from "vitest";
import { createWebServer, resolveListenOptions, type WebServer } from "../../../src/server/create-web-server";

describe("Web security boundary", () => {
  let server: WebServer | null = null;
  afterEach(async () => { await server?.close(); server = null; });

  it("always binds to loopback even when an external host is requested", () => {
    expect(resolveListenOptions({ FAMILY_AGENT_PORT: "9010", FAMILY_AGENT_HOST: "0.0.0.0" } as never))
      .toEqual({ host: "127.0.0.1", port: 9010 });
  });

  it("does not serialize secrets, filesystem paths or stack details from public family routes", async () => {
    const runtime = {
      listFamilies: async () => ({ ok: false, error: { code: "INTERNAL", message: "OPENAI_API_KEY at C:\\private\\family.sqlite", details: { stack: "secret stack" } } }),
      createFamily: async () => ({ ok: false, error: { code: "INTERNAL", message: "/Users/private/workspaces" } }),
      openFamily: async () => ({ ok: false, error: { code: "INTERNAL", message: "databasePath=/tmp/private.sqlite" } }),
      closeFamily: async () => ({ ok: false, error: { code: "INTERNAL", message: "mediaPath=C:\\private" } }),
      dispose: async () => undefined,
      workspaceManager: {}, mutationGate: {}
    };
    server = createWebServer({ runtime: runtime as never });

    for (const request of [
      { method: "GET" as const, url: "/api/family" },
      { method: "POST" as const, url: "/api/family", payload: { name: "家谱" } },
      { method: "POST" as const, url: "/api/family/11111111-1111-4111-8111-111111111111/open", payload: {} },
      { method: "DELETE" as const, url: "/api/family/open" }
    ]) {
      const response = await server.inject(request);
      const body = response.body;
      expect(body).not.toMatch(/OPENAI|databasePath|mediaPath|[A-Z]:\\|\/Users\/|\/tmp\/|stack|private/i);
      expect(response.json()).toEqual({ ok: false, error: { code: "INTERNAL", message: "Unable to complete RPC request" } });
    }
  });

  it("sanitizes unexpected exceptions from every public family route", async () => {
    const reject = async (): Promise<never> => { throw new Error("OPENAI_API_KEY at C:\\private\\family.sqlite"); };
    const runtime = {
      listFamilies: reject,
      createFamily: reject,
      openFamily: reject,
      closeFamily: reject,
      dispose: async () => undefined,
      workspaceManager: {}, mutationGate: {}
    };
    server = createWebServer({ runtime: runtime as never });

    for (const request of [
      { method: "GET" as const, url: "/api/family" },
      { method: "POST" as const, url: "/api/family", payload: { name: "家谱" } },
      { method: "POST" as const, url: "/api/family/11111111-1111-4111-8111-111111111111/open", payload: {} },
      { method: "DELETE" as const, url: "/api/family/open" }
    ]) {
      const response = await server.inject(request);
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toMatch(/OPENAI|private|family\.sqlite|stack|[A-Z]:\\/iu);
      expect(response.json()).toEqual({ ok: false, error: { code: "INTERNAL", message: "Unable to complete RPC request" } });
    }
  });
});
