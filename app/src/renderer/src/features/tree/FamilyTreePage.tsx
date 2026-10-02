import React, { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { FamilyAgentApi, PersonListItem, QueryApi, TreeProjectionDto, TreeViewDto } from "../../../../shared/contracts";
import { useViewpoint } from "../../app/ViewpointContext";
import { FamilyTreeCanvas, type TreeSelection } from "./FamilyTreeCanvas";
import { TreeContextDrawer } from "./TreeContextDrawer";

export interface FamilyTreePageProps {
  api: Pick<QueryApi, "projectTree"> | FamilyAgentApi;
  people: PersonListItem[];
  collapseDepth?: number;
  onDataChanged?(): void;
  onAskAbout?(personId: string): void;
}

const views: Array<{ id: TreeViewDto; label: string }> = [
  { id: "full", label: "全谱" },
  { id: "branch", label: "支系" },
  { id: "ancestors", label: "祖先" },
  { id: "descendants", label: "后代" }
];

export function normalizeTreeSelection(selection: TreeSelection, projection: TreeProjectionDto): TreeSelection | null {
  if (selection.kind === "person") {
    return projection.topology.nodes.some((node) => node.kind === "person" && node.personId === selection.personId)
      ? selection
      : null;
  }
  if (selection.kind === "parentChild") {
    const edge = projection.topology.edges.find((entry) => entry.kind === "unionChild"
      && entry.unionId === selection.unionId
      && entry.childId === selection.childId);
    return edge?.childId
      ? { kind: "parentChild", unionId: edge.unionId, parentIds: [...edge.parentIds], childId: edge.childId, marriageId: edge.marriageId }
      : null;
  }
  const union = projection.topology.nodes.find((node) => node.kind === "union" && node.unionId === selection.unionId);
  if (!union || union.kind !== "union") return null;
  if (selection.kind === "marriage") {
    return union.marriageId === selection.marriageId
      ? { kind: "marriage", unionId: union.unionId, marriageId: selection.marriageId, parentIds: [...union.parentIds] }
      : null;
  }
  return union.marriageId === null
    ? { kind: "family", unionId: union.unionId, parentIds: [...union.parentIds], childIds: [...union.childIds] }
    : null;
}

function sameSelection(left: TreeSelection | null, right: TreeSelection | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isFamilyAgentApi(api: Pick<QueryApi, "projectTree"> | FamilyAgentApi): api is FamilyAgentApi {
  const candidate = api as Partial<FamilyAgentApi>;
  return typeof candidate.people?.get === "function" && typeof candidate.query?.projectTree === "function";
}

export function FamilyTreePage({ api, people, collapseDepth, onDataChanged, onAskAbout }: FamilyTreePageProps): JSX.Element {
  const { viewpointId, setViewpointId } = useViewpoint();
  const interactiveApi: FamilyAgentApi | null = isFamilyAgentApi(api) ? api : null;
  const queryApi: Pick<QueryApi, "projectTree"> = interactiveApi?.query ?? api as Pick<QueryApi, "projectTree">;
  const [view, setView] = useState<TreeViewDto>("full");
  const [subjectId, setSubjectId] = useState<string>(viewpointId ?? people[0]?.id ?? "");
  const [projection, setProjection] = useState<TreeProjectionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<TreeSelection | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const requestId = useRef(0);
  const validIds = useMemo(() => new Set(people.map((person) => person.id)), [people]);

  useEffect(() => {
    if (!validIds.has(subjectId)) setSubjectId(viewpointId && validIds.has(viewpointId) ? viewpointId : people[0]?.id ?? "");
  }, [people, subjectId, validIds, viewpointId]);

  useEffect(() => {
    if (selection?.kind === "person" && !validIds.has(selection.personId)) setSelection(null);
  }, [selection, validIds]);

  useEffect(() => {
    if (!selection || !projection) return;
    const normalized = normalizeTreeSelection(selection, projection);
    if (!sameSelection(selection, normalized)) setSelection(normalized);
  }, [projection, selection]);

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
    void queryApi.projectTree({
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
  }, [collapseDepth, queryApi, reloadVersion, subjectId, view, viewpointId]);

  const dataChanged = async (): Promise<void> => {
    onDataChanged?.();
    setReloadVersion((current) => current + 1);
  };

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
    {!loading && !error && projection && projection.topology.nodes.length > 0 && <div className={`family-tree-workspace${selection && interactiveApi ? " has-drawer" : ""}`}>
      <FamilyTreeCanvas projection={projection} selection={selection} onSelectionChange={setSelection} />
      {selection && interactiveApi && <TreeContextDrawer
        selection={selection}
        api={interactiveApi}
        onClose={() => setSelection(null)}
        onDataChanged={dataChanged}
        onUseAsViewpoint={setViewpointId}
        onAskAbout={onAskAbout}
      />}
    </div>}
  </section>;
}
