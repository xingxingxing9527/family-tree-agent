import type { AppResult, FamilyAgentApi, WorkspaceSummary } from "../../../shared/contracts";

const httpApiGroups = new WeakSet<object>();
export const isHttpApiGroup = (value: object): boolean => httpApiGroups.has(value);

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers }
  });
  return response.json() as Promise<T>;
}

function rpcGroups(baseUrl: string): FamilyAgentApi {
  const groups = new Map<PropertyKey, object>();
  return new Proxy({}, {
    get: (target, group: PropertyKey) => {
      if (Reflect.has(target, group)) return Reflect.get(target, group);
      const cached = groups.get(group);
      if (cached) return cached;
      const proxy = new Proxy({}, {
      get: (_groupTarget, method: string) => (input?: unknown) => requestJson(
        baseUrl,
        `/api/rpc/${encodeURIComponent(String(group))}/${encodeURIComponent(method)}`,
        { method: "POST", body: JSON.stringify({ input: input ?? null }) }
      )
      });
      groups.set(group, proxy);
      return proxy;
    }
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
  for (const group of [api.imports, api.media, api.dataManagement, api.modelSettings]) httpApiGroups.add(group);
  return api;
}
