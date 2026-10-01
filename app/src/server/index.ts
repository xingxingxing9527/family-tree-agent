import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWebServer, resolveListenOptions } from "./create-web-server.js";
import { DownloadStore } from "./http/download-store.js";
import { UploadStore } from "./http/upload-store.js";
import { createFamilyAgentService } from "./runtime/family-agent-service.js";
import { createFamilyRuntime } from "./runtime/family-runtime.js";

export async function startWebServer(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dataRoot = resolve(environment.FAMILY_AGENT_DATA_DIR ?? ".family-agent-data");
  const webRoot = resolve(environment.FAMILY_AGENT_WEB_ROOT ?? "out/web");
  const runtime = await createFamilyRuntime({ dataRoot });
  const fileTransfers = { uploads: new UploadStore({ root: resolve(dataRoot, "uploads") }), downloads: new DownloadStore() };
  const service = createFamilyAgentService({ runtime, ...fileTransfers });
  const server = createWebServer({ runtime, service, fileTransfers, ...(existsSync(webRoot) ? { webRoot } : {}), logger: true });
  const listenOptions = resolveListenOptions(environment);

  const shutdown = async (): Promise<void> => {
    await server.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await server.listen(listenOptions);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startWebServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
