import staticPlugin from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppResult } from "../shared/contracts.js";
import { registerRpcRoutes } from "./http/rpc-router.js";
import { registerFileRoutes, type FileTransferStores } from "./http/file-routes.js";
import { mapUnexpectedRpcError, sanitizeRpcResponse } from "./http/error-mapper.js";
import type { FamilyAgentService } from "./runtime/family-agent-service.js";
import type { FamilyRuntime } from "./runtime/family-runtime.js";

export type WebServer = FastifyInstance;

export interface WebServerOptions {
  runtime: FamilyRuntime;
  service?: FamilyAgentService;
  fileTransfers?: FileTransferStores;
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
  server.setErrorHandler((_error, _request, reply) => {
    const error = mapUnexpectedRpcError();
    return reply.code(error.statusCode).send(error.body);
  });

  server.get("/api/health", async () => ({ ok: true, version: "1.0.0" }));
  server.get("/api/family", async (_request, reply) => {
    const result = await options.runtime.listFamilies();
    return reply.code(statusFor(result)).send(sanitizeRpcResponse(result));
  });
  server.post<{ Body: { name?: unknown } }>("/api/family", async (request, reply) => {
    const name = typeof request.body?.name === "string" ? request.body.name : "";
    const result = await options.runtime.createFamily(name);
    return reply.code(statusFor(result)).send(sanitizeRpcResponse(result));
  });
  server.post<{ Params: { id: string } }>("/api/family/:id/open", async (request, reply) => {
    const result = await options.runtime.openFamily(request.params.id);
    return reply.code(statusFor(result)).send(sanitizeRpcResponse(result));
  });
  server.delete("/api/family/open", async (_request, reply) => {
    const result = await options.runtime.closeFamily();
    return reply.code(statusFor(result)).send(sanitizeRpcResponse(result));
  });

  if (options.service) registerRpcRoutes(server, options.service);
  if (options.fileTransfers) registerFileRoutes(server, options.runtime, options.fileTransfers);

  if (options.webRoot) {
    void server.register(staticPlugin, { root: options.webRoot, wildcard: false });
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "API route was not found" } });
      return reply.sendFile("index.html");
    });
  }

  server.addHook("onClose", async () => {
    await options.service?.dispose();
    await options.fileTransfers?.uploads.dispose();
    options.fileTransfers?.downloads.dispose();
    await options.runtime.dispose();
  });
  return server;
}
