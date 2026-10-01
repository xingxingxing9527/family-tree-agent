import staticPlugin from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppResult } from "../shared/contracts.js";
import type { FamilyRuntime } from "./runtime/family-runtime.js";

export type WebServer = FastifyInstance;

export interface WebServerOptions {
  runtime: FamilyRuntime;
  webRoot?: string;
  logger?: boolean;
}

export interface ListenEnvironment {
  FAMILY_AGENT_PORT?: string;
}

export function resolveListenOptions(environment: ListenEnvironment): { host: "127.0.0.1"; port: number } {
  const candidate = Number(environment.FAMILY_AGENT_PORT ?? 8787);
  const port = Number.isInteger(candidate) && candidate > 0 && candidate <= 65_535 ? candidate : 8787;
  return { host: "127.0.0.1", port };
}

function statusFor<T>(result: AppResult<T>): number {
  if (result.ok) return 200;
  if (result.error.code === "CONFLICT") return 409;
  if (result.error.code === "NOT_FOUND") return 404;
  if (result.error.code === "VALIDATION") return 400;
  if (result.error.code === "PATH_DENIED") return 403;
  return 500;
}

export function createWebServer(options: WebServerOptions): WebServer {
  const server = Fastify({ logger: options.logger ?? false });

  server.get("/api/health", async () => ({ ok: true, version: "1.0.0" }));
  server.get("/api/family", async (_request, reply) => {
    const result = await options.runtime.listFamilies();
    return reply.code(statusFor(result)).send(result);
  });
  server.post<{ Body: { name?: unknown } }>("/api/family", async (request, reply) => {
    const name = typeof request.body?.name === "string" ? request.body.name : "";
    const result = await options.runtime.createFamily(name);
    return reply.code(statusFor(result)).send(result);
  });
  server.post<{ Params: { id: string } }>("/api/family/:id/open", async (request, reply) => {
    const result = await options.runtime.openFamily(request.params.id);
    return reply.code(statusFor(result)).send(result);
  });
  server.delete("/api/family/open", async (_request, reply) => {
    const result = await options.runtime.closeFamily();
    return reply.code(statusFor(result)).send(result);
  });

  if (options.webRoot) {
    void server.register(staticPlugin, { root: options.webRoot, wildcard: false });
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "API route was not found" } });
      return reply.sendFile("index.html");
    });
  }

  server.addHook("onClose", async () => options.runtime.dispose());
  return server;
}
