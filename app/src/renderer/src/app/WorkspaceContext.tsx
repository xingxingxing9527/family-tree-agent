import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { WorkspaceSummary } from "../../../shared/contracts";

export interface WorkspaceState {
  workspaces: WorkspaceSummary[];
  activeWorkspace: WorkspaceSummary | null;
  loading: boolean;
  switching: boolean;
  error: string | null;
  refresh(): Promise<void>;
  createWorkspace(name: string): Promise<WorkspaceSummary | null>;
  openWorkspace(id: string): Promise<WorkspaceSummary | null>;
  closeWorkspace(): Promise<boolean>;
  reportError(message: string): void;
  clearError(): void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }): JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const activeRequest = ++requestId.current;
    setLoading(true);
    try {
      const result = await window.desktopApi.workspaces.list();
      if (activeRequest !== requestId.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setWorkspaces(result.value);
      setError(null);
    } catch { if (activeRequest === requestId.current) setError("无法读取本地谱册"); }
    finally { if (activeRequest === requestId.current) setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); return () => { requestId.current += 1; }; }, [refresh]);

  const openWorkspace = useCallback(async (id: string): Promise<WorkspaceSummary | null> => {
    const activeRequest = ++requestId.current;
    setSwitching(true);
    setActiveWorkspace(null);
    setError(null);
    try {
      const result = await window.desktopApi.workspaces.open({ id });
      if (activeRequest !== requestId.current) return null;
      if (!result.ok) { setError(result.error.message); return null; }
      setActiveWorkspace(result.value);
      setWorkspaces((current) => current.map((entry) => entry.id === result.value.id ? result.value : entry));
      return result.value;
    } catch {
      if (activeRequest === requestId.current) setError("无法打开所选谱册");
      return null;
    } finally { if (activeRequest === requestId.current) setSwitching(false); }
  }, []);

  const createWorkspace = useCallback(async (name: string): Promise<WorkspaceSummary | null> => {
    setError(null);
    try {
      const result = await window.desktopApi.workspaces.create({ name });
      if (!result.ok) { setError(result.error.message); return null; }
      setWorkspaces((current) => [...current.filter((entry) => entry.id !== result.value.id), result.value]);
      return openWorkspace(result.value.id);
    } catch { setError("无法创建谱册"); return null; }
  }, [openWorkspace]);

  const closeWorkspace = useCallback(async (): Promise<boolean> => {
    const activeRequest = ++requestId.current;
    setSwitching(true);
    try {
      const result = await window.desktopApi.workspaces.close();
      if (activeRequest !== requestId.current) return false;
      if (!result.ok) { setError(result.error.message); return false; }
      setActiveWorkspace(null);
      return true;
    } catch { if (activeRequest === requestId.current) setError("无法关闭当前谱册"); return false; }
    finally { if (activeRequest === requestId.current) setSwitching(false); }
  }, []);

  const value = useMemo<WorkspaceState>(() => ({
    workspaces, activeWorkspace, loading, switching, error, refresh, createWorkspace, openWorkspace, closeWorkspace,
    reportError: setError,
    clearError: () => setError(null)
  }), [activeWorkspace, closeWorkspace, createWorkspace, error, loading, openWorkspace, refresh, switching, workspaces]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return value;
}
