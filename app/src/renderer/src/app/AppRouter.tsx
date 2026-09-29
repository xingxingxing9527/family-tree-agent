import React, { useEffect, useRef, type JSX } from "react";
import { HashRouter, Link, Navigate, Route, Routes, useParams } from "react-router-dom";
import { HomePage } from "../features/home/HomePage";
import { AppShell } from "./AppShell";
import { WorkspaceProvider, useWorkspace } from "./WorkspaceContext";

function WorkspaceRoute(): JSX.Element {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const state = useWorkspace();
  const attempted = useRef<string | null>(null);
  const indexed = state.workspaces.some((workspace) => workspace.id === workspaceId);

  useEffect(() => {
    if (!workspaceId || state.loading || !indexed || state.activeWorkspace?.id === workspaceId || state.switching || attempted.current === workspaceId) return;
    attempted.current = workspaceId;
    void state.openWorkspace(workspaceId);
  }, [indexed, state, workspaceId]);

  if (!workspaceId) return <Navigate to="/" replace />;
  if (state.loading || (state.switching && state.activeWorkspace?.id !== workspaceId) || (indexed && attempted.current !== workspaceId && state.activeWorkspace?.id !== workspaceId)) return <main className="state-page"><section className="state-card" role="status"><h1>正在打开谱册…</h1><p>正在验证本地谱册并隔离工作区。</p></section></main>;
  if (!indexed) return <main className="state-page"><section className="state-card" role="alert"><h1>找不到这个谱册</h1><p>链接中的谱册不在本机索引中，未加载任何其他谱册资料。</p><Link to="/">返回首页</Link></section></main>;
  if (state.activeWorkspace?.id !== workspaceId) return <main className="state-page"><section className="state-card" role="alert"><h1>无法打开谱册</h1><p>没有加载链接目标以外的谱册资料。</p><Link to="/">返回首页</Link></section></main>;
  return <AppShell workspace={state.activeWorkspace} />;
}

export function AppRouter(): JSX.Element {
  return <HashRouter><WorkspaceProvider><Routes>
    <Route path="/" element={<HomePage />} />
    <Route path="/workspace/:workspaceId/*" element={<WorkspaceRoute />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></WorkspaceProvider></HashRouter>;
}
