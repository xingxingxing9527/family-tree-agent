import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebServer, resolveListenOptions, type WebServer } from "../../../src/server/create-web-server.js";
import { createFamilyRuntime, type FamilyRuntime } from "../../../src/server/runtime/family-runtime.js";

describe("single-family web server lifecycle", () => {
  let dataRoot: string;
  let runtime: FamilyRuntime;
  let server: WebServer;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "family-agent-web-"));
    runtime = await createFamilyRuntime({ dataRoot });
    server = createWebServer({ runtime });
  });

  afterEach(async () => {
    await server.close();
    await runtime.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("serves health and creates at most one family", async () => {
    const health = await server.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    const first = await server.inject({ method: "POST", url: "/api/family", payload: { name: "王氏家谱" } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, value: { name: "王氏家谱" } });
    expect((await stat(join(dataRoot, "workspaces"))).isDirectory()).toBe(true);

    const second = await server.inject({ method: "POST", url: "/api/family", payload: { name: "第二个家谱" } });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("reopens the sole existing family on a new runtime", async () => {
    const created = await runtime.createFamily("王氏家谱");
    expect(created.ok).toBe(true);
    await runtime.dispose();

    runtime = await createFamilyRuntime({ dataRoot });
    const current = runtime.workspaceManager.getOpenWorkspaceContext();
    expect(current?.workspaceId).toBe(created.ok ? created.value.id : null);
  });

  it("defaults to a loopback-only listener", () => {
    expect(resolveListenOptions({})).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(resolveListenOptions({ FAMILY_AGENT_PORT: "9010" })).toEqual({ host: "127.0.0.1", port: 9010 });
  });
});
