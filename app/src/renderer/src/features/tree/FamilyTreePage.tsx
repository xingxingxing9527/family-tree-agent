import React, { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { FamilyAgentApi, PersonListItem, QueryApi, TreeProjectionDto, TreeViewDto, WorkspaceLineageReadModel } from "../../../../shared/contracts";
import { useViewpoint } from "../../app/ViewpointContext";
import { formatApproximateAge } from "../people/format-approximate-age";
import { FamilyTreeCanvas, type TreeSelection } from "./FamilyTreeCanvas";
import { TreeContextDrawer } from "./TreeContextDrawer";

export interface FamilyTreePageProps {
  api: Pick<QueryApi, "projectTree"> | FamilyAgentApi;
  people: PersonListItem[];
  lineages: WorkspaceLineageReadModel[];
  collapseDepth?: number;
  onDataChanged?(): void;
  onAskAbout?(personId: string): void;
  onOpenLineageSettings?(): void;
}

const views: Array<{ id: TreeViewDto; label: string }> = [
  { id: "full", label: "全谱" },
  { id: "lineage", label: "本家支系" },
  { id: "core", label: "核心亲属" },
  { id: "descendants", label: "子孙后代" }
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

interface LineageChoice {
  lineage: WorkspaceLineageReadModel;
  membership: WorkspaceLineageReadModel["memberships"][number];
}

function describeScope(
  projection: TreeProjectionDto,
  people: readonly PersonListItem[],
  lineages: readonly WorkspaceLineageReadModel[]
): string {
  const { view, subjectId, lineageId, visiblePersonCount } = projection.scope;
  const subjectName = people.find(({ id }) => id === subjectId)?.displayName ?? "所选人物";
  const evidence = "结果基于当前已确认关系。";
  if (view === "full") return `正在显示全部已录入人物，共 ${visiblePersonCount} 人。${evidence}`;
  if (view === "lineage") {
    const lineageName = lineages.find(({ id }) => id === lineageId)?.name ?? "所选本家支系";
    return `正在显示${subjectName}的本家支系“${lineageName}”，共 ${visiblePersonCount} 人。${evidence}`;
  }
  if (view === "core") {
    return `正在显示${subjectName}的父母、祖父母、兄弟姐妹、配偶和子女，共 ${visiblePersonCount} 人。${evidence}`;
  }
  return `正在显示${subjectName}的子孙后代及必要配偶，共 ${visiblePersonCount} 人。${evidence}`;
}

export function FamilyTreePage({
  api,
  people,
  lineages,
  collapseDepth,
  onDataChanged,
  onAskAbout,
  onOpenLineageSettings
}: FamilyTreePageProps): JSX.Element {
  const { viewpointId, setViewpointId } = useViewpoint();
  const interactiveApi: FamilyAgentApi | null = isFamilyAgentApi(api) ? api : null;
  const queryApi: Pick<QueryApi, "projectTree"> = interactiveApi?.query ?? api as Pick<QueryApi, "projectTree">;
  const [view, setView] = useState<TreeViewDto>("full");
  const [subjectId, setSubjectId] = useState<string>(viewpointId ?? people[0]?.id ?? "");
  const [lineageId, setLineageId] = useState("");
  const [projection, setProjection] = useState<TreeProjectionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<TreeSelection | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const requestId = useRef(0);
  const lineageSubject = useRef<string | null>(null);
  const validIds = useMemo(() => new Set(people.map((person) => person.id)), [people]);
  const ageLabels = useMemo(() => people.reduce<Record<string, string>>((labels, person) => {
    const label = formatApproximateAge(person.birth, person.death);
    if (label) labels[person.id] = label;
    return labels;
  }, {}), [people]);
  const subject = useMemo(() => people.find((person) => person.id === subjectId) ?? null, [people, subjectId]);
  const lineageChoices = useMemo<LineageChoice[]>(() => lineages.flatMap((lineage) => {
    const membership = lineage.memberships.find((entry) => entry.personId === subjectId);
    return membership ? [{ lineage, membership }] : [];
  }), [lineages, subjectId]);
  const lineageChoiceKey = lineageChoices
    .map(({ lineage, membership }) => `${lineage.id}:${membership.id}:${membership.isPrimary ? "1" : "0"}`)
    .sort()
    .join("\u0000");
  const primaryLineageChoices = lineageChoices.filter(({ membership }) => membership.isPrimary);
  const selectedLineage = lineageChoices.find(({ lineage }) => lineage.id === lineageId) ?? null;
  const missingPrimaryLineage = view === "lineage" && Boolean(subjectId) && primaryLineageChoices.length === 0;
  const conflictingPrimaryLineages = view === "lineage" && primaryLineageChoices.length > 1;
  const unresolvedLineage = view === "lineage" && (!selectedLineage || missingPrimaryLineage);
  const missingSubject = view !== "full" && !subjectId;

  useEffect(() => {
    if (!validIds.has(subjectId)) setSubjectId(viewpointId && validIds.has(viewpointId) ? viewpointId : people[0]?.id ?? "");
  }, [people, subjectId, validIds, viewpointId]);

  useEffect(() => {
    const changedSubject = lineageSubject.current !== subjectId;
    lineageSubject.current = subjectId;
    setLineageId((current) => {
      if (!changedSubject && current && lineageChoices.some(({ lineage }) => lineage.id === current)) return current;
      return primaryLineageChoices.length === 1 ? primaryLineageChoices[0]!.lineage.id : "";
    });
  }, [lineageChoiceKey, subjectId]);

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
    if (missingSubject || unresolvedLineage) {
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
      ...(view === "lineage" ? { lineageId } : {}),
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
  }, [collapseDepth, lineageId, missingSubject, queryApi, reloadVersion, subjectId, unresolvedLineage, view, viewpointId]);

  const dataChanged = async (): Promise<void> => {
    onDataChanged?.();
    setReloadVersion((current) => current + 1);
  };

  return <section className="feature-page family-tree-page" aria-labelledby="tree-page-title">
    <header className="family-tree-header page-heading">
      <div><p className="eyebrow">真实关系投影</p><h1 id="tree-page-title">家谱树</h1><p>家庭联合节点会保留婚姻、共同父母和单亲结构。</p></div>
      <div className="tree-selectors">
        <label>当前视角<select aria-label="当前视角" value={viewpointId ?? ""} onChange={(event) => setViewpointId(event.target.value || null)}><option value="">未选择</option>{people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label>
        <label>围绕谁查看<select aria-label="围绕谁查看" value={subjectId} onChange={(event) => setSubjectId(event.target.value)} disabled={people.length === 0}>{people.length === 0 && <option value="">暂无人物</option>}{people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label>
      </div>
    </header>
    <nav className="tree-view-tabs" aria-label="家谱视图">
      {views.map((entry) => <button key={entry.id} type="button" className={`tree-view-button${view === entry.id ? " active" : ""}`} aria-pressed={view === entry.id} onClick={() => setView(entry.id)}>{entry.label}</button>)}
    </nav>
    {view === "lineage" && subjectId && primaryLineageChoices.length > 0 && <section className="tree-lineage-controls" aria-label="本家支系选择">
      <label>选择本家支系<select aria-label="选择本家支系" value={lineageId} onChange={(event) => setLineageId(event.target.value)}>
        {!lineageId && <option value="">请选择</option>}
        {lineageChoices.map(({ lineage }) => <option key={lineage.id} value={lineage.id}>{lineage.name}</option>)}
      </select></label>
      {conflictingPrimaryLineages && <div className="tree-lineage-warning" role="alert">
        <span>{subject?.displayName ?? "所选人物"}存在多个主要本家支系，请选择一个并前往设置中修正。</span>
        {onOpenLineageSettings && <button type="button" onClick={onOpenLineageSettings}>前往设置本家支系</button>}
      </div>}
    </section>}
    {loading && <div className="tree-status" role="status">正在读取家谱…</div>}
    {!loading && missingSubject && <div className="tree-status">请先选择“围绕谁查看”</div>}
    {!loading && missingPrimaryLineage && <div className="tree-status tree-actionable-status">
      <span>尚未为 {subject?.displayName ?? "所选人物"} 设置主要本家支系</span>
      {onOpenLineageSettings && <button type="button" onClick={onOpenLineageSettings}>前往设置本家支系</button>}
    </div>}
    {!loading && !missingSubject && !missingPrimaryLineage && conflictingPrimaryLineages && !lineageId && <div className="tree-status">请选择一个本家支系后查看。</div>}
    {!loading && !missingSubject && !unresolvedLineage && error && <div className="tree-status tree-actionable-status" role="alert"><span>{error}</span><button type="button" onClick={() => setReloadVersion((current) => current + 1)}>重新加载</button></div>}
    {!loading && !missingSubject && !unresolvedLineage && !error && projection && <p className="tree-scope-description">{describeScope(projection, people, lineages)}</p>}
    {!loading && !missingSubject && !unresolvedLineage && !error && projection?.topology.nodes.length === 0 && <div className="tree-status">当前范围还没有可显示的人物关系。</div>}
    {!loading && !missingSubject && !unresolvedLineage && !error && projection && projection.topology.nodes.length > 0 && <div className={`family-tree-workspace${selection && interactiveApi ? " has-drawer" : ""}`}>
      <FamilyTreeCanvas projection={projection} ageLabels={ageLabels} selection={selection} onSelectionChange={setSelection} />
      {selection && interactiveApi && <TreeContextDrawer
        selection={selection}
        api={interactiveApi}
        relationshipLabel={selection.kind === "person" ? projection.labels[selection.personId] ?? null : null}
        onClose={() => setSelection(null)}
        onDataChanged={dataChanged}
        onUseAsViewpoint={setViewpointId}
        onAskAbout={onAskAbout}
      />}
    </div>}
  </section>;
}
