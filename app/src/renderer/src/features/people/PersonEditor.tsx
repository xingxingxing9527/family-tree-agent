import React, { useState, type FormEvent, type JSX } from "react";
import type { FamilyAgentApi, DomainWarningDto, PersonDetailReadModel, PersonDraft } from "../../../../shared/contracts";
import { PartialDateField } from "./PartialDateField";
import "./people.css";

interface PersonEditorProps {
  api: FamilyAgentApi["people"];
  personId?: string;
  expectedVersion?: number;
  initialValue?: PersonDraft;
  onSaved?(detail: PersonDetailReadModel): void;
  onCancel?(): void;
}

const emptyDraft: PersonDraft = {
  displayName: "",
  aliases: [],
  gender: "unknown",
  birth: null,
  death: null,
  notes: null,
  sourceDescription: "表单录入"
};

export function PersonEditor({ api, personId, expectedVersion, initialValue = emptyDraft, onSaved, onCancel }: PersonEditorProps): JSX.Element {
  const [draft, setDraft] = useState<PersonDraft>(initialValue);
  const [aliasText, setAliasText] = useState(initialValue.aliases.join("、"));
  const [warnings, setWarnings] = useState<DomainWarningDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const buildDraft = (): PersonDraft => ({
    ...draft,
    displayName: draft.displayName.trim(),
    aliases: aliasText.split(/[、,，]/).map((alias) => alias.trim()).filter(Boolean),
    notes: draft.notes?.trim() || null,
    sourceDescription: draft.sourceDescription.trim() || "表单录入"
  });

  const persist = async (confirmWarnings: boolean): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const value = buildDraft();
    try {
      const result = personId
        ? await api.update({ personId, patch: value, expectedVersion: expectedVersion!, confirmWarnings })
        : await api.save({ draft: value, confirmWarnings });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      if (!result.value.saved) {
        setWarnings(result.value.warnings);
        return;
      }
      setWarnings([]);
      const savedId = result.value.entityId;
      if (!savedId) return;
      const refreshed = await api.get({ personId: savedId });
      if (refreshed.ok) onSaved?.(refreshed.value);
      else setError(refreshed.error.message);
    } catch {
      setError("无法保存人物，请稍后重试。");
    } finally { setSaving(false); }
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void persist(false);
  };

  return (
    <section className="editor-card" aria-labelledby="person-editor-title">
      <h2 id="person-editor-title" className="text-primary">{personId ? "编辑人物" : "新增人物"}</h2>
      <p className="text-secondary form-help">日期一旦填写，历法、年份和月份均为必填项。日期中的“日”可以留空。</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {warnings.length > 0 && (
        <div className="warning-banner" role="alert">
          <strong>请确认以下提醒</strong>
          <ul>{warnings.map((warning) => <li key={`${warning.code}:${warning.message}`}>{warning.message}</li>)}</ul>
          <div className="button-row">
            <button className="button secondary-button" type="button" onClick={() => setWarnings([])}>返回修改</button>
            <button className="button primary-button" type="button" disabled={saving} onClick={() => void persist(true)}>确认保存</button>
          </div>
        </div>
      )}
      <form onSubmit={submit}>
        <label>
          <span>姓名</span>
          <input className="field-control" aria-label="姓名" required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
        </label>
        <label>
          <span>别名</span>
          <input className="field-control" aria-label="别名" value={aliasText} onChange={(event) => setAliasText(event.target.value)} placeholder="多个别名用逗号分隔" />
        </label>
        <label>
          <span>性别</span>
          <select className="field-control" aria-label="性别" value={draft.gender} onChange={(event) => setDraft({ ...draft, gender: event.target.value as PersonDraft["gender"] })}>
            <option value="unknown">未知</option>
            <option value="male">男</option>
            <option value="female">女</option>
          </select>
        </label>
        <PartialDateField label="出生日期" value={draft.birth} onChange={(birth) => setDraft((current) => ({ ...current, birth }))} />
        <PartialDateField label="去世日期" value={draft.death} onChange={(death) => setDraft((current) => ({ ...current, death }))} />
        <label>
          <span>备注</span>
          <textarea className="field-control" aria-label="备注" value={draft.notes ?? ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
        </label>
        <label>
          <span>来源说明</span>
          <input className="field-control" aria-label="来源说明" required value={draft.sourceDescription} onChange={(event) => setDraft({ ...draft, sourceDescription: event.target.value })} />
        </label>
        <div className="button-row">
          {onCancel && <button className="button secondary-button" type="button" onClick={onCancel}>取消</button>}
          <button className="button primary-button" type="submit" disabled={saving}>{saving ? "保存中…" : "保存人物"}</button>
        </div>
      </form>
    </section>
  );
}
