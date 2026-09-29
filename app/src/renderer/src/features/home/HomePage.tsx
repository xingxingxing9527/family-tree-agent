import React, { useState, type FormEvent, type JSX } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkspace } from "../../app/WorkspaceContext";

export function HomePage(): JSX.Element {
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const open = async (id: string): Promise<void> => {
    setBusy(true);
    const opened = await workspace.openWorkspace(id);
    setBusy(false);
    if (opened) navigate(`/workspace/${opened.id}/tree`);
  };
  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const created = await workspace.createWorkspace(name.trim());
    setBusy(false);
    if (created) { setName(""); navigate(`/workspace/${created.id}/people`); }
  };
  return <main className="home-page">
    <header className="hero-card"><p className="eyebrow">本地优先 · 可核对 · 不猜测</p><h1>家谱智能体</h1><p>欢迎使用家谱智能体。创建或打开一个本地谱册，开始记录、浏览与核对家族资料。</p></header>
    {workspace.error && <div className="error-banner" role="alert">{workspace.error}</div>}
    <section className="content-card" aria-labelledby="create-workspace-title"><h2 id="create-workspace-title">新建谱册</h2>
      <form className="workspace-create" onSubmit={(event) => void create(event)}><label><span>谱册名称</span><input className="field-control" aria-label="谱册名称" required disabled={busy} value={name} onChange={(event) => setName(event.target.value)} /></label><button className="button primary-button" type="submit" disabled={busy || !name.trim()}>新建并打开谱册</button></form>
    </section>
    <section className="content-card" aria-labelledby="workspace-list-title"><h2 id="workspace-list-title">本地谱册</h2>
      {workspace.loading ? <p role="status">正在载入本地谱册…</p>
        : workspace.workspaces.length === 0 ? <p className="empty-copy">还没有谱册。你的所有资料都将保存在本机。</p>
          : <div className="workspace-grid">{workspace.workspaces.map((entry) => <button className="workspace-card" type="button" disabled={busy} key={entry.id} onClick={() => void open(entry.id)}><strong>{entry.name}</strong><span>{entry.lastOpenedAt ? `最近打开：${new Date(entry.lastOpenedAt).toLocaleString("zh-CN")}` : "尚未打开"}</span><span>备份状态可在“设置与数据”查看</span></button>)}</div>}
    </section>
  </main>;
}
