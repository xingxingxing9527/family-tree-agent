import type { APIRequestContext, Page } from "@playwright/test";

interface Workspace { id: string; name: string; }
interface Result<T> { ok: boolean; value?: T; error?: { message: string }; }

export async function ensureFamily(request: APIRequestContext): Promise<Workspace> {
  const listed = await (await request.get("/api/family")).json() as Result<Workspace[]>;
  if (!listed.ok) throw new Error(listed.error?.message ?? "Unable to list the E2E family");
  let workspace = listed.value?.[0];
  if (!workspace) {
    const created = await (await request.post("/api/family", { data: { name: "网页 MVP 验证家谱" } })).json() as Result<Workspace>;
    if (!created.ok || !created.value) throw new Error(created.error?.message ?? "Unable to create the E2E family");
    workspace = created.value;
  }
  const opened = await (await request.post(`/api/family/${workspace.id}/open`, { data: {} })).json() as Result<Workspace>;
  if (!opened.ok) throw new Error(opened.error?.message ?? "Unable to open the E2E family");
  return workspace;
}

export async function rpc<T>(request: APIRequestContext, group: string, method: string, input: unknown = null): Promise<T> {
  const response = await request.post(`/api/rpc/${group}/${method}`, { data: { input } });
  const body = await response.json() as Result<T>;
  if (!body.ok || body.value === undefined) throw new Error(body.error?.message ?? `${group}.${method} failed`);
  return body.value;
}

export async function stageAndConfirm(request: APIRequestContext, intents: unknown[]): Promise<{ operationGroupId: string; changedEntityIds: string[] }> {
  const preview = await rpc<{
    id: string; version: number;
    changes: Array<{ id: string; disposition: "create" | "update" | "unchanged" | "blocked" }>;
    issues: Array<{ changeId: string; severity: "warning" | "error"; code: string }>;
  }>(request, "mutations", "stage", { intents });
  const selectedChangeIds = preview.changes.filter((change) => change.disposition === "create" || change.disposition === "update").map((change) => change.id);
  const selected = new Set(selectedChangeIds);
  const acknowledgedWarningCodes = [...new Set(preview.issues.filter((issue) => issue.severity === "warning" && selected.has(issue.changeId)).map((issue) => issue.code))];
  return rpc(request, "mutations", "confirm", { draftId: preview.id, draftVersion: preview.version, selectedChangeIds, acknowledgedWarningCodes });
}

export async function openArea(page: Page, workspaceId: string, area: string): Promise<void> {
  await page.goto(`/#/workspace/${workspaceId}/${area}`);
  await page.waitForLoadState("domcontentloaded");
}
