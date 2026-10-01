import { request, type FullConfig } from "@playwright/test";
import { ensureFamily, rpc, stageAndConfirm } from "./helpers";

export const suiteBaselinePersonName = "Web E2E 套件基准人物";

interface WorkspaceSnapshot {
  people: Array<{ id: string; displayName: string }>;
}

function configuredBaseUrl(config: FullConfig): string {
  const baseURLs = [...new Set(config.projects.map((project) => project.use.baseURL).filter((value): value is string => typeof value === "string"))];
  if (baseURLs.length !== 1) throw new Error(`Web E2E global setup requires exactly one baseURL; found ${baseURLs.length}`);
  return baseURLs[0]!;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const api = await request.newContext({ baseURL: configuredBaseUrl(config) });
  try {
    const workspace = await ensureFamily(api);
    const before = await rpc<WorkspaceSnapshot>(api, "query", "workspaceSnapshot");
    const existing = before.people.filter((person) => person.displayName === suiteBaselinePersonName);
    if (existing.length > 1) throw new Error(`Web E2E suite baseline is duplicated ${existing.length} times`);
    if (existing.length === 0) {
      await stageAndConfirm(api, [{
        type: "person.create",
        draft: {
          displayName: suiteBaselinePersonName,
          aliases: [],
          gender: "unknown",
          birth: null,
          death: null,
          notes: "Playwright 全套件固定基准",
          sourceDescription: "Web E2E 全套件基准"
        }
      }]);
    }
    const after = await rpc<WorkspaceSnapshot>(api, "query", "workspaceSnapshot");
    const verified = after.people.filter((person) => person.displayName === suiteBaselinePersonName);
    if (after.people.length === 0 || verified.length !== 1) {
      throw new Error(`Unable to establish one non-empty Web E2E suite baseline; found ${verified.length} in ${after.people.length} people`);
    }
    console.info(`[web-e2e global setup] baseline workspace=${workspace.id} people=${after.people.length} person=${suiteBaselinePersonName}`);
  } finally {
    await api.dispose();
  }
}
