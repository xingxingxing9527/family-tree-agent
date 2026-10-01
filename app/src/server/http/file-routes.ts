import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { UploadKind } from "../../shared/contracts.js";
import { resolveWorkspaceMediaRequest } from "../../main/media/media-protocol.js";
import type { FamilyRuntime } from "../runtime/family-runtime.js";
import type { DownloadStore } from "./download-store.js";
import { UploadValidationError, type UploadStore } from "./upload-store.js";

export interface FileTransferStores { uploads: UploadStore; downloads: DownloadStore; }

export function registerFileRoutes(server: FastifyInstance, runtime: FamilyRuntime, stores: FileTransferStores): void {
  if (!server.hasContentTypeParser("application/octet-stream")) {
    server.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  }
  server.post<{ Params: { kind: string } }>("/api/files/:kind", async (request, reply) => {
    const kind = request.params.kind;
    if (!(["import", "media", "backup"] as string[]).includes(kind)) return reply.code(400).send({ ok: false, error: { code: "VALIDATION", message: "Unknown upload purpose" } });
    const fileName = request.headers["x-file-name"];
    if (typeof fileName !== "string") return reply.code(400).send({ ok: false, error: { code: "VALIDATION", message: "File name is required" } });
    try {
      const value = await stores.uploads.uploadFile(kind as UploadKind, { fileName: decodeURIComponent(fileName), stream: request.body as Readable });
      return reply.code(200).send({ ok: true, value });
    } catch (error) {
      const status = error instanceof UploadValidationError ? error.statusCode : 400;
      return reply.code(status).send({ ok: false, error: { code: "VALIDATION", message: error instanceof UploadValidationError ? error.message : "Upload failed" } });
    }
  });

  server.get<{ Params: { token: string } }>("/api/downloads/:token", async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/iu.test(request.params.token)) return reply.code(404).send("Not found");
    const claimed = stores.downloads.consume(request.params.token);
    if (claimed.status === "missing") return reply.code(404).send("Not found");
    if (claimed.status === "expired") return reply.code(410).send("Expired");
    const encoded = encodeURIComponent(claimed.value.fileName);
    return reply
      .header("content-type", claimed.value.mimeType)
      .header("content-disposition", `attachment; filename*=UTF-8''${encoded}`)
      .header("cache-control", "no-store")
      .send(claimed.value.bytes);
  });

  server.get<{ Params: { assetId: string } }>("/api/media/:assetId", async (request, reply) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(request.params.assetId)) return reply.code(404).send("Not found");
    const response = await resolveWorkspaceMediaRequest(`app-media://asset/${request.params.assetId}`, runtime.workspaceManager, runtime.mutationGate);
    if (response.status !== 200) return reply.code(404).send("Not found");
    return reply
      .header("content-type", response.headers.get("content-type") ?? "application/octet-stream")
      .header("cache-control", "no-store")
      .send(Buffer.from(await response.arrayBuffer()));
  });
}
