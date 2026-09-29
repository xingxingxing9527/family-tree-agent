import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { WorkspaceSummary } from "../../../shared/contracts";

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
  completeMutation(targetWorkspaceId?: string): Promise<WorkspaceSummary | null>;
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

  useEffect(() => { void refresh(); return () => { listRequestId.current += 1; switchRequestId.current += 1; }; }, [refresh]);

  const performOpen = useCallback(async (id: string, activeRequest: number, clearActive: boolean, announceSwitch = true): Promise<WorkspaceSummary | null> => {
    if (announceSwitch) setSwitching(true);
    if (clearActive) setActiveWorkspace(null);
    setError(null);
    try {
      const result = await window.desktopApi.workspaces.open({ id });
      if (activeRequest !== switchRequestId.current) return null;
      if (!result.ok) { setError(result.error.message); return null; }
      setActiveWorkspace(result.value);
      upsertWorkspace(result.value);
      return result.value;
    } catch {
      if (activeRequest === switchRequestId.current) setError("无法打开所选谱册");
      return null;
    } finally { if (announceSwitch && activeRequest === switchRequestId.current) setSwitching(false); }
  }, [upsertWorkspace]);

  const openWorkspace = useCallback(async (id: string): Promise<WorkspaceSummary | null> => {
    supersedeList();
    return performOpen(id, ++switchRequestId.current, true);
  }, [performOpen, supersedeList]);

  const createWorkspace = useCallback(async (name: string): Promise<WorkspaceSummary | null> => {
    supersedeList();
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
      if (activeRequest === switchRequestId.current) setSwitching(false);
    }
  }, [performOpen, supersedeList, upsertWorkspace]);

  const closeWorkspace = useCallback(async (): Promise<boolean> => {
    supersedeList();
    const activeRequest = ++switchRequestId.current;
    setSwitching(true);
    try {
      const result = await window.desktopApi.workspaces.close();
      if (activeRequest !== switchRequestId.current) return false;
      if (!result.ok) { setError(result.error.message); return false; }
      setActiveWorkspace(null);
      return true;
    } catch { if (activeRequest === switchRequestId.current) setError("无法关闭当前谱册"); return false; }
    finally { if (activeRequest === switchRequestId.current) setSwitching(false); }
  }, [supersedeList]);

  const completeMutation = useCallback(async (targetWorkspaceId?: string): Promise<WorkspaceSummary | null> => {
    const target = targetWorkspaceId ?? activeWorkspace?.id;
    if (!target) { setError("没有可刷新的谱册"); return null; }
    supersedeList();
    const refreshed = await performOpen(target, ++switchRequestId.current, false, target !== activeWorkspace?.id);
    if (refreshed) setMutationEpoch((current) => current + 1);
    return refreshed;
  }, [activeWorkspace?.id, performOpen, supersedeList]);

  const value = useMemo<WorkspaceState>(() => ({
    workspaces, activeWorkspace, loading, switching, mutationEpoch, error, refresh, createWorkspace, openWorkspace, closeWorkspace, completeMutation,
    reportError: setError,
    clearError: () => setError(null)
  }), [activeWorkspace, closeWorkspace, completeMutation, createWorkspace, error, loading, mutationEpoch, openWorkspace, refresh, switching, workspaces]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return value;
}
