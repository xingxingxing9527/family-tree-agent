import React, { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { PersonListItem, QueryApi, TreeProjectionDto, TreeViewDto } from "../../../../shared/contracts";
import { useViewpoint } from "../../app/ViewpointContext";
import { FamilyTreeCanvas } from "./FamilyTreeCanvas";

export interface FamilyTreePageProps {
  api: Pick<QueryApi, "projectTree">;
  people: PersonListItem[];
  collapseDepth?: number;
}

const views: Array<{ id: TreeViewDto; label: string }> = [
  { id: "full", label: "全谱" },
  { id: "branch", label: "支系" },
  { id: "ancestors", label: "祖先" },
  { id: "descendants", label: "后代" }
];

export function FamilyTreePage({ api, people, collapseDepth }: FamilyTreePageProps): JSX.Element {
  const { viewpointId, setViewpointId } = useViewpoint();
  const [view, setView] = useState<TreeViewDto>("full");
  const [subjectId, setSubjectId] = useState<string>(viewpointId ?? people[0]?.id ?? "");
  const [projection, setProjection] = useState<TreeProjectionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const validIds = useMemo(() => new Set(people.map((person) => person.id)), [people]);

  useEffect(() => {
    if (!validIds.has(subjectId)) setSubjectId(viewpointId && validIds.has(viewpointId) ? viewpointId : people[0]?.id ?? "");
  }, [people, subjectId, validIds, viewpointId]);

  useEffect(() => {
    const activeRequest = ++requestId.current;
    if (view !== "full" && !subjectId) {
      setProjection(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    void api.projectTree({
      view,
      ...(view === "full" ? {} : { subjectId }),
      ...(viewpointId ? { viewpointId } : {}),
      ...(collapseDepth === undefined ? {} : { collapseDepth })
    }).then((result) => {
      if (activeRequest !== requestId.current) return;
      if (result.ok) setProjection(result.value);
      else { setProjection(null); setError(result.error.message); }
    }).catch(() => {
      if (activeRequest === requestId.current) { setProjection(null); setError("无法读取家谱视图"); }
    }).finally(() => {
      if (activeRequest === requestId.current) setLoading(false);
    });
    return () => { requestId.current += 1; };
  }, [api, collapseDepth, subjectId, view, viewpointId]);

  return <section className="feature-page family-tree-page" aria-labelledby="tree-page-title">
    <header className="family-tree-header page-heading">
      <div><p className="eyebrow">真实关系投影</p><h1 id="tree-page-title">家谱树</h1><p>家庭联合节点会保留婚姻、共同父母和单亲结构。</p></div>
      <div className="tree-selectors">
        <label>当前视角<select aria-label="当前视角" value={viewpointId ?? ""} onChange={(event) => setViewpointId(event.target.value || null)}><option value="">未选择</option>{people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label>
        <label>视图中心<select aria-label="视图中心" value={subjectId} onChange={(event) => setSubjectId(event.target.value)} disabled={people.length === 0}>{people.length === 0 && <option value="">暂无人物</option>}{people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label>
      </div>
    </header>
    <nav className="tree-view-tabs" aria-label="家谱视图">
      {views.map((entry) => <button key={entry.id} type="button" className={`tree-view-button${view === entry.id ? " active" : ""}`} aria-pressed={view === entry.id} onClick={() => setView(entry.id)}>{entry.label}</button>)}
    </nav>
    {loading && <div className="tree-status" role="status">正在读取家谱…</div>}
    {!loading && error && <div className="tree-status" role="alert">{error}</div>}
    {!loading && !error && projection?.topology.nodes.length === 0 && <div className="tree-status">当前谱册还没有可显示的人物关系。</div>}
    {!loading && !error && projection && projection.topology.nodes.length > 0 && <FamilyTreeCanvas projection={projection} />}
  </section>;
}
