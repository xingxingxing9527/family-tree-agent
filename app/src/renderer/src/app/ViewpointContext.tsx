import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
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
  validPersonIds?: readonly string[];
  fallbackViewpointId?: string | null;
  query: ViewpointQuery;
  children: ReactNode;
  storage?: ViewpointStorage;
}

const ViewpointContext = createContext<ViewpointState | null>(null);
const storageKey = (workspaceId: string): string => `family-agent:viewpoint:${workspaceId}`;

export function ViewpointProvider({
  workspaceId,
  visiblePersonIds,
  validPersonIds,
  fallbackViewpointId = null,
  query,
  children,
  storage = window.localStorage
}: ViewpointProviderProps): JSX.Element {
  const validKey = validPersonIds ? [...new Set(validPersonIds)].sort().join("\u0000") : null;
  const valid = useMemo(() => validKey === null ? null : new Set(validKey ? validKey.split("\u0000") : []), [validKey]);
  const selectValid = useCallback((candidate: string | null): string | null => {
    if (valid === null || (candidate && valid.has(candidate))) return candidate;
    if (fallbackViewpointId && valid.has(fallbackViewpointId)) return fallbackViewpointId;
    return valid.values().next().value ?? null;
  }, [fallbackViewpointId, valid]);
  const [viewpointId, setViewpointState] = useState<string | null>(() => storage.getItem(storageKey(workspaceId)));
  const [relationshipLabels, setRelationshipLabels] = useState<Readonly<Record<string, string | null>>>({});
  const [labelsKey, setLabelsKey] = useState<string | null>(null);
  const requestToken = useRef(0);
  const visibleKey = [...new Set(visiblePersonIds)].sort().join("\u0000");
  const visible = useMemo(() => visibleKey ? visibleKey.split("\u0000") : [], [visibleKey]);
  const requestKey = `${workspaceId}\u0001${viewpointId ?? ""}\u0001${visibleKey}`;

  useEffect(() => {
    const next = selectValid(storage.getItem(storageKey(workspaceId)));
    if (next) storage.setItem(storageKey(workspaceId), next);
    else storage.removeItem(storageKey(workspaceId));
    setViewpointState(next);
    setLabelsKey(null);
  }, [selectValid, storage, validKey, workspaceId]);

  const setViewpointId = useCallback((next: string | null): void => {
    const validated = selectValid(next);
    requestToken.current += 1;
    if (validated) storage.setItem(storageKey(workspaceId), validated);
    else storage.removeItem(storageKey(workspaceId));
    setViewpointState(validated);
    setLabelsKey(null);
  }, [selectValid, storage, workspaceId]);

  useEffect(() => {
    const token = ++requestToken.current;
    let current = true;
    const activeRequestKey = requestKey;
    if (!viewpointId) {
      setRelationshipLabels({});
      setLabelsKey(activeRequestKey);
      return () => { current = false; };
    }
    void Promise.all(visible.map(async (targetId) => {
      try {
        const result = await query.calculateRelationship({ viewpointId, targetId });
        return [targetId, result.ok ? result.value.primaryTerm : null] as const;
      } catch {
        return [targetId, null] as const;
      }
    })).then((entries) => {
      if (current && token === requestToken.current) {
        setRelationshipLabels(Object.fromEntries(entries));
        setLabelsKey(activeRequestKey);
      }
    });
    return () => { current = false; };
  }, [query, requestKey, viewpointId, visible]);

  const value = useMemo<ViewpointState>(() => ({
    viewpointId,
    relationshipLabels: labelsKey === requestKey ? relationshipLabels : {},
    setViewpointId
  }), [labelsKey, relationshipLabels, requestKey, setViewpointId, viewpointId]);
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
