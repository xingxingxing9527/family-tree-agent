import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { WorkspaceSummary } from "../../../shared/contracts";

export type MutationRefreshOutcome =
  | { status: "refreshed"; workspace: WorkspaceSummary }
  | { status: "superseded" }
  | { status: "refresh-failed" };

export interface PreparedMutationRefresh {
  complete(): Promise<MutationRefreshOutcome>;
  retry(): Promise<MutationRefreshOutcome>;
}

export interface WorkspaceState {
  workspaces: WorkspaceSummary[];
  activeWorkspace: WorkspaceSummary | null;
  loading: boolean;
  switching: boolean;
  mutationEpoch: number;
  error: string | null;
  refresh(): Promise<void>;
  createWorkspace(name: string): Promise<WorkspaceSummary | null>;
  openWorkspace(id: string): Promise<WorkspaceSummary | null>;
  closeWorkspace(): Promise<boolean>;
  prepareMutation(sourceWorkspaceId: string, targetWorkspaceId?: string): PreparedMutationRefresh;
  reportError(message: string): void;
  clearError(): void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }): JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [mutationEpoch, setMutationEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const listRequestId = useRef(0);
  const switchRequestId = useRef(0);
  const refreshRequestId = useRef(0);
  const activeWorkspaceRef = useRef<WorkspaceSummary | null>(null);
  const activeWorkspaceEpochRef = useRef(0);
  activeWorkspaceRef.current = activeWorkspace;

  const supersedeList = useCallback((): void => {
    listRequestId.current += 1;
    setLoading(false);
  }, []);

  const upsertWorkspace = useCallback((workspace: WorkspaceSummary): void => {
    setWorkspaces((current) => current.some((entry) => entry.id === workspace.id)
      ? current.map((entry) => entry.id === workspace.id ? workspace : entry)
      : [...current, workspace]);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const activeRequest = ++listRequestId.current;
    setLoading(true);
    try {
      const result = await window.desktopApi.workspaces.list();
      if (activeRequest !== listRequestId.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setWorkspaces(result.value);
      setError(null);
    } catch { if (activeRequest === listRequestId.current) setError("无法读取本地谱册"); }
    finally { if (activeRequest === listRequestId.current) setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); return () => { listRequestId.current += 1; switchRequestId.current += 1; refreshRequestId.current += 1; }; }, [refresh]);

  const performOpen = useCallback(async (id: string, activeRequest: number, clearActive: boolean): Promise<WorkspaceSummary | null> => {
    if (activeRequest !== switchRequestId.current) return null;
    setSwitching(true);
    if (clearActive) { activeWorkspaceRef.current = null; setActiveWorkspace(null); }
    setError(null);
    try {
      const result = await window.desktopApi.workspaces.open({ id });
      if (activeRequest !== switchRequestId.current) return null;
      if (!result.ok) { setError(result.error.message); return null; }
      activeWorkspaceRef.current = result.value;
      activeWorkspaceEpochRef.current = activeRequest;
      setActiveWorkspace(result.value);
      upsertWorkspace(result.value);
      return result.value;
    } catch {
      if (activeRequest === switchRequestId.current) setError("无法打开所选谱册");
      return null;
    } finally {
      if (activeRequest === switchRequestId.current) {
        activeWorkspaceEpochRef.current = activeRequest;
        setSwitching(false);
      }
    }
  }, [upsertWorkspace]);

  const openWorkspace = useCallback(async (id: string): Promise<WorkspaceSummary | null> => {
    supersedeList();
    refreshRequestId.current += 1;
    return performOpen(id, ++switchRequestId.current, true);
  }, [performOpen, supersedeList]);

  const createWorkspace = useCallback(async (name: string): Promise<WorkspaceSummary | null> => {
    supersedeList();
    refreshRequestId.current += 1;
    const activeRequest = ++switchRequestId.current;
    setSwitching(true);
    setError(null);
    try {
      const result = await window.desktopApi.workspaces.create({ name });
      if (!result.ok) {
        if (activeRequest === switchRequestId.current) setError(result.error.message);
        return null;
      }
      upsertWorkspace(result.value);
      if (activeRequest !== switchRequestId.current) return null;
      return performOpen(result.value.id, activeRequest, true);
    } catch {
      if (activeRequest === switchRequestId.current) setError("无法创建谱册");
      return null;
    } finally {
      if (activeRequest === switchRequestId.current) {
        activeWorkspaceEpochRef.current = activeRequest;
        setSwitching(false);
      }
    }
  }, [performOpen, supersedeList, upsertWorkspace]);

  const closeWorkspace = useCallback(async (): Promise<boolean> => {
    supersedeList();
    refreshRequestId.current += 1;
    const activeRequest = ++switchRequestId.current;
    setSwitching(true);
    try {
      const result = await window.desktopApi.workspaces.close();
      if (activeRequest !== switchRequestId.current) return false;
      if (!result.ok) { setError(result.error.message); return false; }
      activeWorkspaceRef.current = null;
      setActiveWorkspace(null);
      return true;
    } catch { if (activeRequest === switchRequestId.current) setError("无法关闭当前谱册"); return false; }
    finally {
      if (activeRequest === switchRequestId.current) {
        activeWorkspaceEpochRef.current = activeRequest;
        setSwitching(false);
      }
    }
  }, [supersedeList]);

  const prepareMutation = useCallback((sourceWorkspaceId: string, requestedTargetWorkspaceId?: string): PreparedMutationRefresh => {
    const targetWorkspaceId = requestedTargetWorkspaceId ?? sourceWorkspaceId;
    const sourceNavigationEpoch = activeWorkspaceEpochRef.current;
    let claimedTargetNavigationEpoch: number | null = null;

    const runRefresh = async (): Promise<MutationRefreshOutcome> => {
      const expectedNavigationEpoch = claimedTargetNavigationEpoch ?? sourceNavigationEpoch;
      if (
        switchRequestId.current !== expectedNavigationEpoch ||
        activeWorkspaceEpochRef.current !== expectedNavigationEpoch ||
        activeWorkspaceRef.current?.id !== sourceWorkspaceId
      ) {
        return { status: "superseded" };
      }

      if (targetWorkspaceId !== sourceWorkspaceId) {
        if (claimedTargetNavigationEpoch === null) {
          supersedeList();
          refreshRequestId.current += 1;
          claimedTargetNavigationEpoch = ++switchRequestId.current;
        }
        const activeRequest = claimedTargetNavigationEpoch;
        setSwitching(true);
        setError(null);
        try {
          const result = await window.desktopApi.workspaces.open({ id: targetWorkspaceId });
          if (activeRequest !== switchRequestId.current) return { status: "superseded" };
          if (!result.ok) return { status: "refresh-failed" };
          activeWorkspaceRef.current = result.value;
          activeWorkspaceEpochRef.current = activeRequest;
          setActiveWorkspace(result.value);
          upsertWorkspace(result.value);
          setMutationEpoch((current) => current + 1);
          return { status: "refreshed", workspace: result.value };
        } catch {
          return activeRequest === switchRequestId.current ? { status: "refresh-failed" } : { status: "superseded" };
        } finally {
          if (activeRequest === switchRequestId.current) {
            activeWorkspaceEpochRef.current = activeRequest;
            setSwitching(false);
          }
        }
      }

      const activeRefresh = ++refreshRequestId.current;
      try {
        const result = await window.desktopApi.workspaces.open({ id: sourceWorkspaceId });
        if (
          activeRefresh !== refreshRequestId.current ||
          sourceNavigationEpoch !== switchRequestId.current ||
          activeWorkspaceRef.current?.id !== sourceWorkspaceId
        ) return { status: "superseded" };
        if (!result.ok) return { status: "refresh-failed" };
        activeWorkspaceRef.current = result.value;
        setActiveWorkspace(result.value);
        upsertWorkspace(result.value);
        setMutationEpoch((current) => current + 1);
        return { status: "refreshed", workspace: result.value };
      } catch {
        return (
          activeRefresh === refreshRequestId.current &&
          sourceNavigationEpoch === switchRequestId.current &&
          activeWorkspaceRef.current?.id === sourceWorkspaceId
        ) ? { status: "refresh-failed" } : { status: "superseded" };
      }
    };

    return { complete: runRefresh, retry: runRefresh };
  }, [supersedeList, upsertWorkspace]);

  const value = useMemo<WorkspaceState>(() => ({
    workspaces, activeWorkspace, loading, switching, mutationEpoch, error, refresh, createWorkspace, openWorkspace, closeWorkspace, prepareMutation,
    reportError: setError,
    clearError: () => setError(null)
  }), [activeWorkspace, closeWorkspace, createWorkspace, error, loading, mutationEpoch, openWorkspace, prepareMutation, refresh, switching, workspaces]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return value;
}
