import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import type {
  FamilyAgentApi,
  MarriageDraft,
  ParentCompletionPlanDto,
  PersonDetailReadModel,
  PersonListItem,
  RelatedPersonReadModel
} from "../../../../shared/contracts";
import type { PartialDate } from "../../../../shared/domain";
import type { MutationApi, MutationIntent } from "../../../../shared/mutations";
import { MutationReviewDialog } from "../mutations/MutationReviewDialog";
import { useStagedMutation } from "../mutations/useStagedMutation";
import { formatPartialDate } from "../people/format-partial-date";
import { PartialDateField } from "../people/PartialDateField";

type ParentRole = "father" | "mother";
type ParentFamilyIntent = Extract<MutationIntent, { type: "parentFamily.add" }>;
type RelativePurpose = "父亲" | "母亲" | "配偶" | "子女" | "更正人物";

export interface RelativeQuickCreateRequest {
  ownerPersonId: string;
  purpose: RelativePurpose;
  onCreated(person: PersonListItem): void;
}

interface FamilyRelationsPanelProps {
  detail: PersonDetailReadModel;
  peopleApi: FamilyAgentApi["people"];
  relationsApi: FamilyAgentApi["relations"];
  mutations?: MutationApi;
  onChanged(): Promise<void>;
  onRequestQuickCreate?(request: RelativeQuickCreateRequest): void;
}

interface PlannedFamilyIntent {
  key: string;
  intent: ParentFamilyIntent;
  plan: ParentCompletionPlanDto;
}

interface PendingPlan {
  prefixIntents: MutationIntent[];
  family: PlannedFamilyIntent[];
}

interface MarriageEventDraft {
  key: number;
  spouseId: string;
  status: "" | "active" | "divorced";
  start: PartialDate | null;
  end: PartialDate | null;
}

interface OwnerRequest {
  ownerPersonId: string;
  generation: number;
}

const roleName = (role: ParentRole): "父亲" | "母亲" => role === "father" ? "父亲" : "母亲";
const emptyMarriageEvent = (key: number): MarriageEventDraft => ({ key, spouseId: "", status: "", start: null, end: null });
const sourceDescription = "人物中心关系录入";
const skipChoice = "__skip__";

function marriageRange(start: PartialDate | null, end: PartialDate | null): string {
  return `${formatPartialDate(start)} 至 ${formatPartialDate(end)}`;
}

function provenanceDate(value: PartialDate | null): string {
  if (value === null) return "未记录";
  const precision = value.precision === "day" ? "日精度" : "月精度";
  return `${formatPartialDate(value)}（${precision}）`;
}

export function FamilyRelationsPanel({
  detail,
  peopleApi,
  relationsApi,
  mutations,
  onChanged,
  onRequestQuickCreate
}: FamilyRelationsPanelProps): JSX.Element {
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [query, setQuery] = useState("");
  const [loadingPeople, setLoadingPeople] = useState(true);
  const [parentSelections, setParentSelections] = useState<Record<ParentRole, string>>({ father: "", mother: "" });
  const [selectedChildren, setSelectedChildren] = useState<Set<string>>(new Set());
  const [childParentRole, setChildParentRole] = useState<ParentRole | "">("");
  const [marriageEvents, setMarriageEvents] = useState<MarriageEventDraft[]>([emptyMarriageEvent(1)]);
  const [correction, setCorrection] = useState<{ relation: RelatedPersonReadModel; replacementId: string; parentRole: ParentRole | "" } | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const searchRequestId = useRef(0);
  const nextMarriageKey = useRef(2);
  const ownerPersonId = useRef(detail.person.id);
  const ownerGeneration = useRef(0);
  const mounted = useRef(true);

  const mutationCommitted = useCallback(async (): Promise<void> => {
    setPendingPlan(null);
    setResolutions({});
    setParentSelections({ father: "", mother: "" });
    setSelectedChildren(new Set());
    setChildParentRole("");
    setMarriageEvents([emptyMarriageEvent(nextMarriageKey.current++)]);
    setCorrection(null);
    await onChanged();
  }, [onChanged]);
  const staged = useStagedMutation(mutations, mutationCommitted);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ownerGeneration.current += 1;
    };
  }, []);

  useLayoutEffect(() => {
    ownerPersonId.current = detail.person.id;
    ownerGeneration.current += 1;
    searchRequestId.current += 1;
    nextMarriageKey.current = 2;
    setPeople([]);
    setQuery("");
    setLoadingPeople(true);
    setParentSelections({ father: "", mother: "" });
    setSelectedChildren(new Set());
    setChildParentRole("");
    setMarriageEvents([emptyMarriageEvent(1)]);
    setCorrection(null);
    setPendingPlan(null);
    setResolutions({});
    setNotices([]);
    setError(null);
    setPlanning(false);
    staged.reset();
  }, [detail.person.id, staged.reset]);

  const captureOwner = (): OwnerRequest => ({ ownerPersonId: detail.person.id, generation: ownerGeneration.current });
  const ownerIsCurrent = (request: OwnerRequest): boolean => mounted.current
    && ownerPersonId.current === request.ownerPersonId
    && ownerGeneration.current === request.generation;

  const mergePerson = useCallback((created: PersonListItem): void => {
    setPeople((current) => current.some(({ id }) => id === created.id) ? current : [...current, created]);
  }, []);

  const searchPeople = useCallback(async (value: string): Promise<void> => {
    const activeRequest = ++searchRequestId.current;
    setQuery(value);
    setLoadingPeople(true);
    try {
      const result = await peopleApi.list({ query: value.trim() || undefined, limit: 1_000, offset: 0 });
      if (activeRequest !== searchRequestId.current) return;
      if (result.ok) {
        setPeople(result.value.filter(({ id }) => id !== detail.person.id));
        setError(null);
      } else {
        setError(result.error.message);
      }
    } catch {
      if (activeRequest === searchRequestId.current) setError("无法搜索关系人物，请稍后重试");
    } finally {
      if (activeRequest === searchRequestId.current) setLoadingPeople(false);
    }
  }, [detail.person.id, peopleApi]);

  useEffect(() => {
    void searchPeople("");
    return () => { searchRequestId.current += 1; };
  }, [searchPeople]);

  const availablePeople = useMemo(() => people.filter(({ id }) => id !== detail.person.id), [detail.person.id, people]);
  const existingChildIds = useMemo(() => new Set(detail.children.map(({ person }) => person.id)), [detail.children]);
  const childCandidates = useMemo(
    () => availablePeople.filter(({ id }) => !existingChildIds.has(id)),
    [availablePeople, existingChildIds]
  );

  const familyIntent = (knownParentId: string, childId: string, parentRole: ParentRole, description = sourceDescription): ParentFamilyIntent => ({
    type: "parentFamily.add",
    knownParentId,
    childId,
    parentRole,
    completionPolicy: "spouse-default",
    sourceDescription: description
  });

  const planAndStage = async (family: ParentFamilyIntent[], prefixIntents: MutationIntent[] = []): Promise<void> => {
    if (!mutations || family.length === 0 || planning) return;
    const owner = captureOwner();
    if (!ownerIsCurrent(owner)) return;
    setPlanning(true);
    setError(null);
    setNotices([]);
    try {
      const planned: PlannedFamilyIntent[] = [];
      for (const [index, intent] of family.entries()) {
        const result = await relationsApi.planParentCompletion({
          knownParentId: intent.knownParentId,
          childId: intent.childId,
          parentRole: intent.parentRole
        });
        if (!ownerIsCurrent(owner)) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        planned.push({ key: `${intent.childId}:${intent.parentRole}:${index}`, intent, plan: result.value });
      }
      if (!ownerIsCurrent(owner)) return;
      setNotices(planned
        .filter(({ plan }) => plan.status === "no_candidate")
        .map(({ plan }) => `${plan.explicit.childName}：另一位父母尚未确认`));
      if (planned.some(({ plan }) => plan.status === "ambiguous")) {
        setPendingPlan({ prefixIntents, family: planned });
        setResolutions({});
        return;
      }
      if (!ownerIsCurrent(owner)) return;
      await staged.stage([...prefixIntents, ...family]);
      if (!ownerIsCurrent(owner)) return;
    } catch {
      if (ownerIsCurrent(owner)) setError("无法规划家庭关系，请稍后重试");
    } finally {
      if (ownerIsCurrent(owner)) setPlanning(false);
    }
  };

  const stageResolvedPlan = (): void => {
    if (!pendingPlan) return;
    const unresolved = pendingPlan.family.some(({ key, plan }) => plan.status === "ambiguous" && !resolutions[key]);
    if (unresolved) return;
    const intents = pendingPlan.family.map(({ key, intent, plan }) => {
      if (plan.status !== "ambiguous") return intent;
      const choice = resolutions[key];
      return choice === skipChoice
        ? { ...intent, skipCompletion: true }
        : { ...intent, selectedSpouseId: choice };
    });
    setPendingPlan(null);
    void staged.stage([...pendingPlan.prefixIntents, ...intents]);
  };

  const stageRemoval = (relation: RelatedPersonReadModel): void => {
    if (!mutations) return;
    setError(null);
    void staged.stage([{ type: "parentChild.remove", relationId: relation.relationId, expectedVersion: relation.rowVersion }]);
  };

  const stageCorrection = (): void => {
    if (!correction?.replacementId) return;
    const relation = correction.relation;
    const parentRole = relation.role === "child" ? correction.parentRole : relation.role;
    if (!parentRole) return;
    const replacementIntent = relation.role === "child"
      ? familyIntent(detail.person.id, correction.replacementId, parentRole, "人物中心关系更正")
      : familyIntent(correction.replacementId, detail.person.id, parentRole, "人物中心关系更正");
    replacementIntent.skipCompletion = true;
    void planAndStage([replacementIntent], [{
      type: "parentChild.remove",
      relationId: relation.relationId,
      expectedVersion: relation.rowVersion
    }]);
  };

  const updateMarriage = (key: number, patch: Partial<MarriageEventDraft>): void => {
    setMarriageEvents((current) => current.map((event) => event.key === key ? { ...event, ...patch } : event));
    setError(null);
  };

  const stageMarriages = (): void => {
    if (!mutations) return;
    setError(null);
    if (marriageEvents.some(({ spouseId, status }) => !spouseId || !status)) {
      setError("请为每段婚姻事件选择配偶和状态");
      return;
    }
    if (marriageEvents.some(({ status, end }) => status === "divorced" && !end)) {
      setError("已离婚的婚姻事件必须填写结束日期");
      return;
    }
    if (marriageEvents.filter(({ status }) => status === "active").length > 1) {
      setError("同一人物的新婚姻事件最多只能有一段当前婚姻");
      return;
    }
    const intents: MutationIntent[] = marriageEvents.map(({ spouseId, status, start, end }) => ({
      type: "marriage.add",
      draft: {
        spouseAId: detail.person.id,
        spouseBId: spouseId,
        status: status as MarriageDraft["status"],
        start,
        end: status === "divorced" ? end : null,
        sourceDescription
      }
    }));
    void staged.stage(intents);
  };

  const quickCreate = (purpose: RelativePurpose, onCreated: (person: PersonListItem) => void): void => {
    const owner = captureOwner();
    if (!ownerIsCurrent(owner)) return;
    onRequestQuickCreate?.({
      ownerPersonId: owner.ownerPersonId,
      purpose,
      onCreated: (created) => {
        if (!ownerIsCurrent(owner)) return;
        mergePerson(created);
        onCreated(created);
      }
    });
  };

  const inferredMarriage = (relation: RelatedPersonReadModel): string | null => {
    if (!relation.inferredFromMarriageId) return null;
    const source = relation.inferredFromMarriage;
    if (!source) return "来源婚姻：已确认婚姻记录（详情暂不可用）";
    const status = source.status === "active" ? "当前婚姻" : "已离婚";
    const range = source.status === "active" && source.end === null
      ? `${provenanceDate(source.start)} 至今`
      : `${provenanceDate(source.start)} 至 ${provenanceDate(source.end)}`;
    return `来源婚姻：${source.spouseAName} 与 ${source.spouseBName}；${status}；${range}`;
  };

  const relationRow = (relation: RelatedPersonReadModel, label: string): JSX.Element => <article className="family-relation-row" key={relation.relationId}>
    <div>
      <strong>{relation.person.displayName}</strong>
      <span className={`mutation-origin mutation-origin-${relation.originKind}`}>{relation.originKind === "spouse_default" ? "系统自动补全" : "人工录入"}</span>
      {inferredMarriage(relation) && <small className="text-secondary">{inferredMarriage(relation)}</small>}
    </div>
    <div className="button-row">
      <button className="button secondary-button" type="button" onClick={() => setCorrection({ relation, replacementId: "", parentRole: "" })}>更正{label} {relation.person.displayName}</button>
      <button className="button secondary-button" type="button" disabled={staged.busy} onClick={() => stageRemoval(relation)}>移除{label} {relation.person.displayName}</button>
    </div>
  </article>;

  const correctionLabel = correction?.relation.role === "father"
    ? "父亲"
    : correction?.relation.role === "mother"
      ? "母亲"
      : "子女";
  const correctionNeedsRole = correction?.relation.role === "child";
  const correctionReady = Boolean(correction?.replacementId && (!correctionNeedsRole || correction.parentRole));
  const currentGender = detail.person.gender === "male" ? "男" : detail.person.gender === "female" ? "女" : "未知";

  return <section className="family-relations-panel" aria-labelledby="family-relations-title">
    <div className="section-heading-row">
      <div>
        <h3 id="family-relations-title">家庭关系</h3>
        <p className="text-secondary">当前人物固定为：{detail.person.displayName}</p>
      </div>
    </div>
    <label>
      <span>搜索关系候选</span>
      <input className="field-control" aria-label="搜索关系候选" value={query} onChange={(event) => void searchPeople(event.target.value)} />
    </label>
    {loadingPeople && <p role="status">正在加载关系候选…</p>}
    {error && <div className="error-banner" role="alert">{error}</div>}
    {staged.error && <div className="error-banner" role="alert">{staged.error}</div>}
    {notices.map((notice) => <p className="family-relation-notice" role="status" key={notice}>{notice}</p>)}

    <div className="family-relation-sections">
      {(["father", "mother"] as const).map((role) => {
        const existing = detail.parents.find((entry) => entry.role === role);
        const label = roleName(role);
        return <section className="family-relation-section" aria-labelledby={`family-${role}-title`} key={role}>
          <h4 id={`family-${role}-title`}>{label}</h4>
          {existing ? relationRow(existing, label) : <>
            <label>
              <span>选择{label}</span>
              <select className="field-control" aria-label={`选择${label}`} value={parentSelections[role]} onChange={(event) => setParentSelections((current) => ({ ...current, [role]: event.target.value }))}>
                <option value="">请选择</option>
                {availablePeople.map((entry) => <option key={entry.id} value={entry.id}>{entry.personCode}｜{entry.displayName}</option>)}
              </select>
            </label>
            <div className="button-row">
              {onRequestQuickCreate && <button className="button secondary-button" type="button" onClick={() => quickCreate(label, (created) => setParentSelections((current) => ({ ...current, [role]: created.id })))}>快速新建{label}</button>}
              <button className="button primary-button" type="button" disabled={!parentSelections[role] || planning || staged.busy} onClick={() => void planAndStage([familyIntent(parentSelections[role], detail.person.id, role)])}>添加{label}并预览</button>
            </div>
          </>}
        </section>;
      })}

      <section className="family-relation-section family-spouse-section" aria-labelledby="family-spouse-title">
        <h4 id="family-spouse-title">配偶</h4>
        {detail.marriages.length === 0
          ? <p className="text-secondary">暂无婚姻记录。</p>
          : detail.marriages.map((marriage) => <article className="family-relation-row" key={marriage.id}>
            <strong>{marriage.spouse.displayName}</strong>
            <span>{marriage.status === "active" ? "当前婚姻" : "已离婚"}</span>
            <small className="text-secondary">{marriageRange(marriage.start, marriage.end)}</small>
          </article>)}
        <div className="marriage-event-list">
          {marriageEvents.map((event, index) => {
            const number = index + 1;
            return <fieldset className="marriage-event-editor" key={event.key}>
              <legend>第{number}段婚姻事件</legend>
              <label><span>配偶</span><select className="field-control" aria-label={`第${number}段婚姻配偶`} value={event.spouseId} onChange={(change) => updateMarriage(event.key, { spouseId: change.target.value })}><option value="">请选择</option>{availablePeople.map((entry) => <option key={entry.id} value={entry.id}>{entry.personCode}｜{entry.displayName}</option>)}</select></label>
              <label><span>状态</span><select className="field-control" aria-label={`第${number}段婚姻状态`} value={event.status} onChange={(change) => updateMarriage(event.key, { status: change.target.value as MarriageEventDraft["status"], ...(change.target.value === "active" ? { end: null } : {}) })}><option value="">请选择</option><option value="active">当前婚姻</option><option value="divorced">已离婚</option></select></label>
              <PartialDateField label={`第${number}段婚姻开始日期`} value={event.start} onChange={(start) => updateMarriage(event.key, { start })} />
              <PartialDateField label={`第${number}段婚姻结束日期`} value={event.end} onChange={(end) => updateMarriage(event.key, { end })} />
              {marriageEvents.length > 1 && <button className="button secondary-button" type="button" onClick={() => setMarriageEvents((current) => current.filter(({ key }) => key !== event.key))}>移除第{number}段婚姻事件</button>}
            </fieldset>;
          })}
        </div>
        <div className="button-row">
          {onRequestQuickCreate && <button className="button secondary-button" type="button" onClick={() => quickCreate("配偶", (created) => updateMarriage(marriageEvents[marriageEvents.length - 1]!.key, { spouseId: created.id }))}>快速新建配偶</button>}
          <button className="button secondary-button" type="button" onClick={() => setMarriageEvents((current) => [...current, emptyMarriageEvent(nextMarriageKey.current++)])}>新增婚姻事件</button>
          <button className="button primary-button" type="button" disabled={staged.busy} onClick={stageMarriages}>生成婚姻关系预览</button>
        </div>
      </section>

      <section className="family-relation-section family-children-section" aria-labelledby="family-children-title">
        <h4 id="family-children-title">子女</h4>
        {detail.children.length === 0 ? <p className="text-secondary">暂无子女记录。</p> : detail.children.map((entry) => relationRow(entry, "子女"))}
        <fieldset className="parent-role-choice">
          <legend>新增子女时的明确父母角色</legend>
          <label><input type="radio" name="current-parent-role" aria-label="当前人物作为父亲" checked={childParentRole === "father"} onChange={() => setChildParentRole("father")} />当前人物作为父亲</label>
          <label><input type="radio" name="current-parent-role" aria-label="当前人物作为母亲" checked={childParentRole === "mother"} onChange={() => setChildParentRole("mother")} />当前人物作为母亲</label>
          <small className="text-secondary">性别提示：{currentGender}。角色必须由管理员明确选择，系统不会据此默认或改写。</small>
        </fieldset>
        <div className="child-candidate-list" role="group" aria-label="子女候选多选">
          {childCandidates.map((entry) => <label key={entry.id}>
            <input
              type="checkbox"
              aria-label={`选择子女 ${entry.displayName}`}
              checked={selectedChildren.has(entry.id)}
              onChange={(event) => setSelectedChildren((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(entry.id); else next.delete(entry.id);
                return next;
              })}
            />
            <span>{entry.personCode}｜{entry.displayName}</span>
          </label>)}
        </div>
        <div className="button-row">
          {onRequestQuickCreate && <button className="button secondary-button" type="button" onClick={() => quickCreate("子女", (created) => setSelectedChildren((current) => new Set(current).add(created.id)))}>快速新建子女</button>}
          <button
            className="button primary-button"
            type="button"
            disabled={!childParentRole || selectedChildren.size === 0 || planning || staged.busy}
            onClick={() => void planAndStage([...selectedChildren].map((childId) => familyIntent(detail.person.id, childId, childParentRole as ParentRole)))}
          >生成子女关系预览</button>
        </div>
      </section>
    </div>

    {correction && <section className="relation-correction" aria-labelledby="relation-correction-title">
      <h4 id="relation-correction-title">更正{correctionLabel}关系</h4>
      <label><span>{correctionLabel}更正为</span><select className="field-control" aria-label={`${correctionLabel}更正为`} value={correction.replacementId} onChange={(event) => setCorrection((current) => current ? { ...current, replacementId: event.target.value } : current)}><option value="">请选择</option>{availablePeople.filter(({ id }) => id !== correction.relation.person.id).map((entry) => <option key={entry.id} value={entry.id}>{entry.personCode}｜{entry.displayName}</option>)}</select></label>
      {correctionNeedsRole && <fieldset className="parent-role-choice"><legend>更正后当前人物的角色</legend><label><input type="radio" name="correction-parent-role" aria-label="更正后当前人物作为父亲" checked={correction.parentRole === "father"} onChange={() => setCorrection((current) => current ? { ...current, parentRole: "father" } : current)} />当前人物作为父亲</label><label><input type="radio" name="correction-parent-role" aria-label="更正后当前人物作为母亲" checked={correction.parentRole === "mother"} onChange={() => setCorrection((current) => current ? { ...current, parentRole: "mother" } : current)} />当前人物作为母亲</label></fieldset>}
      <div className="button-row">
        <button className="button secondary-button" type="button" onClick={() => setCorrection(null)}>取消更正</button>
        {onRequestQuickCreate && <button className="button secondary-button" type="button" onClick={() => quickCreate("更正人物", (created) => setCorrection((current) => current ? { ...current, replacementId: created.id } : current))}>快速新建更正人物</button>}
        <button className="button primary-button" type="button" disabled={!correctionReady || planning || staged.busy} onClick={stageCorrection}>预览{correctionLabel}更正</button>
      </div>
    </section>}

    {pendingPlan && <section className="ambiguity-resolution" aria-labelledby="ambiguity-resolution-title">
      <h4 id="ambiguity-resolution-title">请选择另一位父母，或暂时跳过</h4>
      {pendingPlan.family.filter(({ plan }) => plan.status === "ambiguous").map(({ key, plan }) => <fieldset key={key}>
        <legend>{plan.explicit.childName}的候选</legend>
        {plan.candidates.map((candidate) => <label key={candidate.personId}>
          <input type="radio" name={`resolution-${key}`} aria-label={`为${plan.explicit.childName}选择${candidate.personName}`} checked={resolutions[key] === candidate.personId} onChange={() => setResolutions((current) => ({ ...current, [key]: candidate.personId }))} />
          <span><strong>{candidate.personName}</strong>{candidate.marriageEpisodes.map((episode) => <small className="text-secondary" key={episode.id}>{episode.status === "active" ? "当前婚姻" : "已离婚"}：{marriageRange(episode.start, episode.end)}</small>)}<small className="text-secondary">{candidate.reason}</small></span>
        </label>)}
        <label><input type="radio" name={`resolution-${key}`} aria-label={`暂时跳过${plan.explicit.childName}的另一位父母`} checked={resolutions[key] === skipChoice} onChange={() => setResolutions((current) => ({ ...current, [key]: skipChoice }))} />暂时跳过另一位父母</label>
      </fieldset>)}
      <div className="button-row"><button className="button secondary-button" type="button" onClick={() => setPendingPlan(null)}>返回修改</button><button className="button primary-button" type="button" disabled={pendingPlan.family.some(({ key, plan }) => plan.status === "ambiguous" && !resolutions[key]) || staged.busy} onClick={stageResolvedPlan}>生成关系预览</button></div>
    </section>}

    {staged.preview && <MutationReviewDialog preview={staged.preview} busy={staged.busy} onCancel={staged.cancel} onConfirm={(ids, warnings) => void staged.confirm(ids, warnings)} />}
  </section>;
}
