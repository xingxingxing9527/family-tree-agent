import React, { useMemo, useState, type JSX } from "react";
import type { TreeProjectionService } from "../../../../main/domain/projection/tree-projection-service";
import { FamilyTreeCanvas } from "./FamilyTreeCanvas";

type TreeView = "full" | "branch" | "ancestors" | "descendants";

export interface TreePersonOption {
  id: string;
  displayName: string;
}

export interface FamilyTreePageProps {
  service: TreeProjectionService;
  people: TreePersonOption[];
  initialViewpointId: string;
  collapseDepth?: number;
}

const views: Array<{ id: TreeView; label: string }> = [
  { id: "full", label: "全谱" },
  { id: "branch", label: "分支" },
  { id: "ancestors", label: "祖先" },
  { id: "descendants", label: "后代" }
];

export function FamilyTreePage({ service, people, initialViewpointId, collapseDepth = Number.POSITIVE_INFINITY }: FamilyTreePageProps): JSX.Element {
  const [view, setView] = useState<TreeView>("full");
  const [viewpointId, setViewpointId] = useState(initialViewpointId);
  const [subjectId, setSubjectId] = useState(initialViewpointId);

  const topologyProjection = useMemo(() => {
    if (view === "branch") return service.branch(subjectId);
    if (view === "ancestors") return service.ancestors(subjectId);
    if (view === "descendants") return service.descendants(subjectId);
    return service.full("", collapseDepth);
  }, [collapseDepth, service, subjectId, view]);
  const projection = useMemo(
    () => service.withViewpoint(topologyProjection, viewpointId),
    [service, topologyProjection, viewpointId]
  );

  return (
    <section className="family-tree-page" aria-labelledby="family-tree-title">
      <header className="family-tree-header">
        <div>
          <h1 id="family-tree-title">家谱树</h1>
          <p>视角只改变称谓；切换查看范围不会改动家谱事实。</p>
        </div>
        <div className="tree-selectors">
          <label>
            <span>查看人物</span>
            <select className="field-control" aria-label="查看人物" value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>
              {people.map((person) => <option value={person.id} key={person.id}>{person.displayName}</option>)}
            </select>
          </label>
          <label>
            <span>当前视角</span>
            <select className="field-control" aria-label="当前视角" value={viewpointId} onChange={(event) => setViewpointId(event.target.value)}>
              {people.map((person) => <option value={person.id} key={person.id}>{person.displayName}</option>)}
            </select>
          </label>
        </div>
      </header>
      <nav className="tree-view-tabs" aria-label="家谱查看范围">
        {views.map((item) => (
          <button
            className={view === item.id ? "button tree-view-button active" : "button tree-view-button"}
            type="button"
            aria-pressed={view === item.id}
            key={item.id}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <FamilyTreeCanvas projection={projection} />
    </section>
  );
}
