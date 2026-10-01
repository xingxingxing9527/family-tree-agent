import { rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { startWebServer } from "../src/server/index.js";
import { DeterministicE2EAdapter } from "../src/main/llm/deterministic-e2e-adapter.js";

const dataRoot = resolve(".e2e-web-data");
if (basename(dataRoot) !== ".e2e-web-data") throw new Error("Refusing to clean an unexpected E2E data directory");
await rm(dataRoot, { recursive: true, force: true });
process.env.FAMILY_AGENT_DATA_DIR = dataRoot;
process.env.FAMILY_AGENT_WEB_ROOT = resolve("out/web");
process.env.FAMILY_AGENT_PORT = process.env.FAMILY_AGENT_PORT ?? "8791";
await startWebServer(process.env, {
  initialModelKey: "e2e-only",
  modelFactory: () => new DeterministicE2EAdapter()
});
