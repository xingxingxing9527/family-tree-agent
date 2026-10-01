import React, { createContext, useContext, type JSX, type ReactNode } from "react";
import type { FamilyAgentApi } from "../../../shared/contracts";

const ApiContext = createContext<FamilyAgentApi | null>(null);

export function ApiProvider({ api, children }: { api: FamilyAgentApi; children: ReactNode }): JSX.Element {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): FamilyAgentApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("FamilyAgent API is unavailable");
  return api;
}
