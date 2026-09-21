import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import type { AppResult, RelationshipResultDto } from "../../../shared/contracts";

export interface ViewpointQuery {
  calculateRelationship(input: { viewpointId: string; targetId: string }): Promise<AppResult<RelationshipResultDto>>;
}

export interface ViewpointState {
  viewpointId: string | null;
  relationshipLabels: Readonly<Record<string, string | null>>;
  setViewpointId(viewpointId: string | null): void;
}

interface ViewpointStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface ViewpointProviderProps {
  workspaceId: string;
  visiblePersonIds: readonly string[];
  query: ViewpointQuery;
  children: ReactNode;
  storage?: ViewpointStorage;
}

const ViewpointContext = createContext<ViewpointState | null>(null);
const storageKey = (workspaceId: string): string => `family-agent:viewpoint:${workspaceId}`;

export function ViewpointProvider({
  workspaceId,
  visiblePersonIds,
  query,
  children,
  storage = window.localStorage
}: ViewpointProviderProps): JSX.Element {
  const [viewpointId, setViewpointState] = useState<string | null>(() => storage.getItem(storageKey(workspaceId)));
  const [relationshipLabels, setRelationshipLabels] = useState<Readonly<Record<string, string | null>>>({});
  const visibleKey = [...new Set(visiblePersonIds)].sort().join("\u0000");
  const visible = useMemo(() => visibleKey ? visibleKey.split("\u0000") : [], [visibleKey]);

  useEffect(() => {
    setViewpointState(storage.getItem(storageKey(workspaceId)));
    setRelationshipLabels({});
  }, [storage, workspaceId]);

  const setViewpointId = useCallback((next: string | null): void => {
    if (next) storage.setItem(storageKey(workspaceId), next);
    else storage.removeItem(storageKey(workspaceId));
    setViewpointState(next);
  }, [storage, workspaceId]);

  useEffect(() => {
    let current = true;
    if (!viewpointId) {
      setRelationshipLabels({});
      return () => { current = false; };
    }
    void Promise.all(visible.map(async (targetId) => {
      const result = await query.calculateRelationship({ viewpointId, targetId });
      return [targetId, result.ok ? result.value.primaryTerm : null] as const;
    })).then((entries) => {
      if (current) setRelationshipLabels(Object.fromEntries(entries));
    });
    return () => { current = false; };
  }, [query, viewpointId, visible]);

  const value = useMemo<ViewpointState>(() => ({ viewpointId, relationshipLabels, setViewpointId }), [relationshipLabels, setViewpointId, viewpointId]);
  return <ViewpointContext.Provider value={value}>{children}</ViewpointContext.Provider>;
}

export function useViewpoint(): ViewpointState {
  const value = useContext(ViewpointContext);
  if (!value) throw new Error("useViewpoint must be used within ViewpointProvider");
  return value;
}

export function useOptionalViewpoint(): ViewpointState | null {
  return useContext(ViewpointContext);
}
