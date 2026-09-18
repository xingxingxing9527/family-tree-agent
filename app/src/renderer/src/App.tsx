import { useEffect, useState, type FormEvent, type JSX } from "react";
import type { WorkspaceSummary } from "../../shared/contracts";
import { PeoplePage } from "./features/people/PeoplePage";

export default function App(): JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [active, setActive] = useState<WorkspaceSummary | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const listed = await window.desktopApi.workspaces.list();
      if (!listed.ok) {
        setError(listed.error.message);
        setLoading(false);
        return;
      }
      setWorkspaces(listed.value);
      const recent = [...listed.value].filter((workspace) => workspace.lastOpenedAt).sort((left, right) => (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? ""))[0];
      if (recent) {
        const opened = await window.desktopApi.workspaces.open({ id: recent.id });
        if (opened.ok) setActive(opened.value);
        else setError(opened.error.message);
      }
      setLoading(false);
    })();
  }, []);

  const open = async (workspace: WorkspaceSummary): Promise<void> => {
    const result = await window.desktopApi.workspaces.open({ id: workspace.id });
    if (result.ok) setActive(result.value);
    else setError(result.error.message);
  };

  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const created = await window.desktopApi.workspaces.create({ name });
    if (!created.ok) {
      setError(created.error.message);
      return;
    }
    setWorkspaces((current) => [...current, created.value]);
    setName("");
    await open(created.value);
  };

  if (loading) return <main><h1>家谱智能体</h1><p>正在载入本地谱册…</p></main>;
  if (active) return <PeoplePage workspace={active} api={window.desktopApi} />;

  return (
    <main className="workspace-home">
      <h1>家谱智能体</h1>
      <p>欢迎使用家谱智能体。创建或打开一个本地谱册开始录入。</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <form className="workspace-create" onSubmit={(event) => void create(event)}>
        <label><span>谱册名称</span><input className="field-control" aria-label="谱册名称" required value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button className="button primary-button" type="submit">新建并打开谱册</button>
      </form>
      {workspaces.length > 0 && <section><h2>已有谱册</h2>{workspaces.map((workspace) => <button className="workspace-card" type="button" key={workspace.id} onClick={() => void open(workspace)}>{workspace.name}</button>)}</section>}
    </main>
  );
}
