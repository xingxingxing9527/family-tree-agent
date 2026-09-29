import React, { type JSX } from "react";
import type { PersonListItem, WorkspaceLineageReadModel } from "../../../../shared/contracts";

export function LineageSettings({ lineages, people }: { lineages: WorkspaceLineageReadModel[]; people: PersonListItem[] }): JSX.Element {
  const names = new Map(people.map((person) => [person.id, person.displayName]));
  return <section className="settings-section" aria-labelledby="lineage-settings-title">
    <h2 id="lineage-settings-title">支系与世代</h2>
    <div className="explanation-grid">
      <article><h3>录入原点</h3><p>创建谱册后用于引导录入和默认打开位置。</p></article>
      <article><h3>当前视角</h3><p>只改变称谓和界面标签，不修改人物或关系事实。</p></article>
      <article><h3>支系始祖</h3><p>每个支系计算世代的起点；世代不是人物的全局属性。</p></article>
    </div>
    {lineages.length === 0 ? <p className="empty-copy">当前谱册还没有支系记录。</p> : <ul className="settings-list">{lineages.map((lineage) => <li key={lineage.id}><strong>{lineage.name}</strong><span>始祖：{names.get(lineage.founderPersonId) ?? lineage.founderPersonId}</span><span>成员：{lineage.memberCount}</span>{lineage.description && <span>{lineage.description}</span>}</li>)}</ul>}
  </section>;
}
