import React, { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { FamilyAgentApi, MarriageReadModel, PersonDetailReadModel, PersonListItem } from "../../../../shared/contracts";
import type { PartialDate } from "../../../../shared/domain";
import { MutationReviewDialog } from "../mutations/MutationReviewDialog";
import { useStagedMutation } from "../mutations/useStagedMutation";
import { PartialDateField } from "../people/PartialDateField";
import { FamilyRelationsPanel, type RelativeQuickCreateRequest } from "../relations/FamilyRelationsPanel";
import type { TreeSelection } from "./FamilyTreeCanvas";

type RelationshipSelection = Exclude<TreeSelection, { kind: "person" }>;

interface TreeRelationshipEditorProps {
  selection: RelationshipSelection;
  api: FamilyAgentApi;
  onChanged(): void | Promise<void>;
  onRequestQuickCreate?(request: RelativeQuickCreateRequest): void;
}

interface LoadedMarriage {
  owner: PersonDetailReadModel;
  marriage: MarriageReadModel;
}

const sourceDescription = "家谱树关系修订";

function namesFor(ids: string[], people: PersonListItem[]): string {
  const byId = new Map(people.map((entry) => [entry.id, entry.displayName]));
  return ids.map((id) => byId.get(id) ?? id).join("、");
}

export function TreeRelationshipEditor({ selection, api, onChanged, onRequestQuickCreate }: TreeRelationshipEditorProps): JSX.Element {
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [marriage, setMarriage] = useState<LoadedMarriage | null>(null);
  const [childDetail, setChildDetail] = useState<PersonDetailReadModel | null>(null);
  const [spouseAId, setSpouseAId] = useState("");
  const [spouseBId, setSpouseBId] = useState("");
  const [status, setStatus] = useState<"active" | "divorced">("active");
  const [start, setStart] = useState<PartialDate | null>(null);
  const [end, setEnd] = useState<PartialDate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const activeRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    setMarriage(null);
    setChildDetail(null);
    try {
      const peopleResult = await api.people.list({ limit: 1_000, offset: 0 });
      if (activeRequest !== requestId.current) return;
      if (!peopleResult.ok) throw new Error(peopleResult.error.message);
      setPeople(peopleResult.value);

      if (selection.kind === "marriage") {
        let loaded: LoadedMarriage | null = null;
        for (const personId of selection.parentIds) {
          const detailResult = await api.people.get({ personId });
          if (activeRequest !== requestId.current) return;
          if (!detailResult.ok) continue;
          const record = detailResult.value.marriages.find(({ id }) => id === selection.marriageId);
          if (record) {
            loaded = { owner: detailResult.value, marriage: record };
            break;
          }
        }
        if (!loaded) throw new Error("未找到这条婚姻记录，家谱可能刚刚发生变化");
        setMarriage(loaded);
        setSpouseAId(loaded.owner.person.id);
        setSpouseBId(loaded.marriage.spouse.id);
        setStatus(loaded.marriage.status);
        setStart(loaded.marriage.start);
        setEnd(loaded.marriage.end);
      } else if (selection.kind === "parentChild") {
        const detailResult = await api.people.get({ personId: selection.childId });
        if (activeRequest !== requestId.current) return;
        if (!detailResult.ok) throw new Error(detailResult.error.message);
        setChildDetail(detailResult.value);
      }
    } catch (caught) {
      if (activeRequest === requestId.current) setError(caught instanceof Error ? caught.message : "无法读取关系详情");
    } finally {
      if (activeRequest === requestId.current) setLoading(false);
    }
  }, [api.people, selection]);

  const committed = useCallback(async (): Promise<void> => {
    await onChanged();
    await load();
  }, [load, onChanged]);
  const staged = useStagedMutation(api.mutations, committed);

  useEffect(() => {
    staged.reset();
    void load();
    return () => { requestId.current += 1; };
  }, [load, staged.reset]);

  const peopleOptions = useMemo(() => people.map((entry) => <option key={entry.id} value={entry.id}>{entry.personCode}｜{entry.displayName}</option>), [people]);

  const stageCorrection = (): void => {
    if (!marriage || !spouseAId || !spouseBId) return;
    void staged.stage([{
      type: "marriage.correct",
      marriageId: marriage.marriage.id,
      expectedVersion: marriage.marriage.rowVersion,
      replacement: {
        spouseAId,
        spouseBId,
        status,
        start,
        end: status === "divorced" ? end : null,
        sourceDescription
      }
    }]);
  };

  const stageRemoval = (): void => {
    if (!marriage) return;
    void staged.stage([{ type: "marriage.remove", marriageId: marriage.marriage.id, expectedVersion: marriage.marriage.rowVersion }]);
  };

  if (loading) return <p role="status">正在读取关系详情…</p>;
  if (error) return <div className="error-banner" role="alert">{error}</div>;

  if (selection.kind === "family") {
    return <section className="tree-relationship-editor" aria-labelledby="family-relation-summary-title">
      <h3 id="family-relation-summary-title">共同父母家庭</h3>
      <p>父母：{namesFor(selection.parentIds, people) || "未记录"}</p>
      <p>子女：{namesFor(selection.childIds, people) || "未记录"}</p>
      <p className="text-secondary">这不是婚姻记录。请点击通向某个孩子的竖线，修改对应亲子关系。</p>
    </section>;
  }

  if (selection.kind === "parentChild" && childDetail) {
    return <section className="tree-relationship-editor" aria-labelledby="parent-child-editor-title">
      <h3 id="parent-child-editor-title">亲子关系</h3>
      <p><strong>当前孩子：{childDetail.person.displayName}</strong></p>
      <p className="text-secondary">这里以孩子为中心显示父母，可直接更正、移除或补充关系。</p>
      <FamilyRelationsPanel
        detail={childDetail}
        peopleApi={api.people}
        relationsApi={api.relations}
        mutations={api.mutations}
        onChanged={committed}
        onRequestQuickCreate={onRequestQuickCreate}
      />
    </section>;
  }

  if (selection.kind === "marriage" && marriage) {
    const spouseA = people.find(({ id }) => id === spouseAId)?.displayName ?? spouseAId;
    const spouseB = people.find(({ id }) => id === spouseBId)?.displayName ?? spouseBId;
    return <section className="tree-relationship-editor" aria-labelledby="marriage-editor-title">
      <h3 id="marriage-editor-title">婚姻关系</h3>
      <p><strong>{spouseA} 与 {spouseB}</strong></p>
      {staged.error && <div className="error-banner" role="alert">{staged.error}</div>}
      <div className="tree-marriage-fields">
        <label><span>配偶一</span><select className="field-control" aria-label="配偶一" value={spouseAId} onChange={(event) => setSpouseAId(event.target.value)}>{peopleOptions}</select></label>
        <label><span>配偶二</span><select className="field-control" aria-label="配偶二" value={spouseBId} onChange={(event) => setSpouseBId(event.target.value)}>{peopleOptions}</select></label>
        <label><span>婚姻状态</span><select className="field-control" aria-label="婚姻状态" value={status} onChange={(event) => {
          const next = event.target.value as "active" | "divorced";
          setStatus(next);
          if (next === "active") setEnd(null);
        }}><option value="active">当前婚姻</option><option value="divorced">已离婚</option></select></label>
        <PartialDateField label="婚姻开始日期" value={start} onChange={setStart} />
        {status === "divorced" && <PartialDateField label="婚姻结束日期" value={end} onChange={setEnd} />}
      </div>
      <div className="button-row">
        <button className="button primary-button" type="button" disabled={staged.busy || !spouseAId || !spouseBId || spouseAId === spouseBId} onClick={stageCorrection}>预览婚姻更正</button>
        <button className="button secondary-button danger-button" type="button" disabled={staged.busy} onClick={stageRemoval}>删除错误婚姻记录</button>
      </div>
      <p className="text-secondary">删除只会归档这条错误婚姻，不会删除人物或已有亲子关系；确认后仍可从历史记录撤销。</p>
      {staged.preview && <MutationReviewDialog preview={staged.preview} busy={staged.busy} onCancel={staged.cancel} onConfirm={(ids, warnings) => void staged.confirm(ids, warnings)} />}
    </section>;
  }

  return <div className="error-banner" role="alert">这条关系已不存在，请重新选择。</div>;
}
