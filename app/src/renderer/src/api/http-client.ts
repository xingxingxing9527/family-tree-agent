import type { AppResult, FamilyAgentApi, WorkspaceSummary } from "../../../shared/contracts";

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers }
  });
  return response.json() as Promise<T>;
}

function rpcGroups(baseUrl: string): FamilyAgentApi {
  return new Proxy({}, {
    get: (target, group: string) => Reflect.has(target, group) ? Reflect.get(target, group) : new Proxy({}, {
      get: (_groupTarget, method: string) => (input?: unknown) => requestJson(
        baseUrl,
        `/api/rpc/${encodeURIComponent(group)}/${encodeURIComponent(method)}`,
        { method: "POST", body: JSON.stringify({ input: input ?? null }) }
      )
    })
  }) as FamilyAgentApi;
}

export function createHttpApiClient(baseUrl = ""): FamilyAgentApi {
  const api = rpcGroups(baseUrl);
  api.app = {
    getVersion: async () => {
      const result = await requestJson<{ version: string }>(baseUrl, "/api/health");
      return result.version;
    }
  };
  api.workspaces = {
    list: () => requestJson<AppResult<WorkspaceSummary[]>>(baseUrl, "/api/family"),
    create: ({ name }) => requestJson<AppResult<WorkspaceSummary>>(baseUrl, "/api/family", { method: "POST", body: JSON.stringify({ name }) }),
    open: ({ id }) => requestJson<AppResult<WorkspaceSummary>>(baseUrl, `/api/family/${encodeURIComponent(id)}/open`, { method: "POST", body: "{}" }),
    close: () => requestJson<AppResult<null>>(baseUrl, "/api/family/open", { method: "DELETE" })
  };
  return api;
}
