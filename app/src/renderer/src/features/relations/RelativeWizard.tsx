import React, { useMemo, useState, type JSX } from "react";
import type { FamilyAgentApi, PersonListItem } from "../../../../shared/contracts";
import type { MutationIntent } from "../../../../shared/mutations";
import {
  RELATIVE_TEMPLATES,
  type RelativeIntermediaryRole,
  type RelativePathPlan,
  type RelativeTemplateId
} from "../../../../shared/relative-templates";

interface RelativeWizardProps {
  people: PersonListItem[];
  relationsApi: FamilyAgentApi["relations"];
  onStage(intents: MutationIntent[]): void;
}

export function RelativeWizard({ people, relationsApi, onStage }: RelativeWizardProps): JSX.Element {
  const [anchorId, setAnchorId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [templateId, setTemplateId] = useState<RelativeTemplateId>("sibling");
  const [selected, setSelected] = useState<Partial<Record<RelativeIntermediaryRole, string>>>({});
  const [plan, setPlan] = useState<RelativePathPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);

  const resetPlan = (): void => { setPlan(null); setSelected({}); setError(null); };
  const requestPlan = async (): Promise<void> => {
    if (!anchorId || !targetId || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await relationsApi.planRelativePath({ anchorId, targetId, templateId, selectedIntermediaryIds: selected });
      if (!result.ok) { setError(result.error.message); return; }
      setPlan(result.value);
      setSelected((current) => ({ ...result.value.resolvedIntermediaryIds, ...current }));
    } catch { setError("无法规划亲属关系路径，请稍后重试。"); }
    finally { setBusy(false); }
  };
  const path = plan?.resultingPath.personIds.map((id) => peopleById.get(id)?.displayName ?? "未知人物").join(" → ") ?? "";

  return <section className="relative-wizard" aria-labelledby="relative-wizard-title">
    <h3 id="relative-wizard-title">更多亲属</h3>
    <p className="text-secondary">选择称谓后，系统只会生成可核对的父母与子女基础关系。</p>
    <div className="relationship-columns">
      <label><span>视角人物</span><select className="field-control" aria-label="视角人物" value={anchorId} onChange={(event) => { setAnchorId(event.target.value); resetPlan(); }}><option value="">请选择</option>{people.filter((person) => person.id !== targetId).map((person) => <option key={person.id} value={person.id}>{person.personCode}｜{person.displayName}</option>)}</select></label>
      <label><span>新增亲属人物</span><select className="field-control" aria-label="新增亲属人物" value={targetId} onChange={(event) => { setTargetId(event.target.value); resetPlan(); }}><option value="">请选择</option>{people.filter((person) => person.id !== anchorId).map((person) => <option key={person.id} value={person.id}>{person.personCode}｜{person.displayName}</option>)}</select></label>
      <label><span>关系类型</span><select className="field-control" aria-label="关系类型" value={templateId} onChange={(event) => { setTemplateId(event.target.value as RelativeTemplateId); resetPlan(); }}>{RELATIVE_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}</select></label>
    </div>
    <button className="button secondary-button" type="button" disabled={busy || !anchorId || !targetId} onClick={() => void requestPlan()}>规划关系路径</button>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {plan?.requiredSelections.map((requirement) => <label key={requirement.role}>
      <span>{requirement.label}</span>
      <select
        className="field-control"
        aria-label={`中间人：${requirement.label}`}
        value={selected[requirement.role] ?? ""}
        onChange={(event) => setSelected((current) => ({ ...current, [requirement.role]: event.target.value }))}
      >
        <option value="">请选择</option>
        {requirement.candidateIds.map((id) => peopleById.get(id)).filter((person): person is PersonListItem => Boolean(person)).map((person) => <option key={person.id} value={person.id}>{person.personCode}｜{person.displayName}</option>)}
      </select>
      <small className="text-secondary">{requirement.reason}</small>
    </label>)}
    {plan && plan.requiredSelections.length > 0 && <button className="button secondary-button" type="button" disabled={busy || plan.requiredSelections.some((requirement) => !selected[requirement.role])} onClick={() => void requestPlan()}>更新关系路径</button>}
    {plan && plan.requiredSelections.length === 0 && <div className="relationship-path-preview">
      <strong>{path}</strong>
      <p>互称：视角人物称目标为“{plan.resultingPath.forwardTerm}”；目标称视角人物为“{plan.resultingPath.reverseTerm}”。</p>
      {plan.intents.length > 0
        ? <button className="button primary-button" type="button" onClick={() => onStage(plan.intents)}>进入写入预览</button>
        : <p className="success-message" role="status">路径中的基础关系已经存在，无需重复写入。</p>}
    </div>}
  </section>;
}
