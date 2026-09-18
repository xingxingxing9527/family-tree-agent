import React, { useMemo, useState, type JSX } from "react";
import type { DesktopApi, DomainWarningDto, MarriageDraft, ParentChildDraft, PersonListItem } from "../../../../shared/contracts";
import type { PartialDate } from "../../../../shared/domain";
import { PartialDateField } from "../people/PartialDateField";

interface RelationshipEditorProps {
  people: PersonListItem[];
  peopleApi: DesktopApi["people"];
  relationsApi: DesktopApi["relations"];
  onSaved(): Promise<void>;
}

type PendingMutation =
  | { kind: "parentChild"; draft: ParentChildDraft; warnings: DomainWarningDto[] }
  | { kind: "marriage"; draft: MarriageDraft; warnings: DomainWarningDto[] };

export function RelationshipEditor({ people, peopleApi, relationsApi, onSaved }: RelationshipEditorProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PersonListItem[]>(people);
  const [parentId, setParentId] = useState("");
  const [childId, setChildId] = useState("");
  const [parentRole, setParentRole] = useState<"father" | "mother">("father");
  const [parentSource, setParentSource] = useState("表单录入");
  const [spouseAId, setSpouseAId] = useState("");
  const [spouseBId, setSpouseBId] = useState("");
  const [marriageStart, setMarriageStart] = useState<PartialDate | null>(null);
  const [marriageSource, setMarriageSource] = useState("表单录入");
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(() => {
    const selectedIds = new Set([parentId, childId, spouseAId, spouseBId]);
    const combined = [...people];
    for (const result of searchResults) if (!combined.some((person) => person.id === result.id)) combined.push(result);
    return combined.filter((person) => !query || selectedIds.has(person.id) || person.displayName.includes(query) || person.aliases.some((alias) => alias.includes(query)));
  }, [people, searchResults, query, parentId, childId, spouseAId, spouseBId]);

  const search = async (value: string): Promise<void> => {
    setQuery(value);
    const result = await peopleApi.list({ query: value || undefined, limit: 100, offset: 0 });
    if (result.ok) setSearchResults(result.value);
  };

  const personOptions = (excludeId = ""): JSX.Element[] => options
    .filter((person) => person.id !== excludeId)
    .map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>);

  const complete = async (kind: PendingMutation["kind"], draft: ParentChildDraft | MarriageDraft, confirmWarnings: boolean): Promise<void> => {
    setError(null);
    setMessage(null);
    const result = kind === "parentChild"
      ? await relationsApi.addParentChild({ draft: draft as ParentChildDraft, confirmWarnings })
      : await relationsApi.addMarriage({ draft: draft as MarriageDraft, confirmWarnings });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (!result.value.saved) {
      setPending({ kind, draft: draft as never, warnings: result.value.warnings } as PendingMutation);
      return;
    }
    setPending(null);
    setMessage(kind === "parentChild" ? "亲子关系已保存" : "婚姻已保存");
    await onSaved();
  };

  const parentDraft: ParentChildDraft = { parentId, childId, parentRole, sourceDescription: parentSource };
  const marriageDraft: MarriageDraft = { spouseAId, spouseBId, start: marriageStart, sourceDescription: marriageSource };

  return (
    <section className="relationship-card" aria-labelledby="relationship-editor-title">
      <h2 id="relationship-editor-title">添加关系</h2>
      <label>
        <span>按姓名或别名搜索</span>
        <input className="field-control" aria-label="关系人物搜索" value={query} onChange={(event) => void search(event.target.value)} />
      </label>
      {message && <p className="success-message" role="status">{message}</p>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {pending && (
        <div className="warning-banner" role="alert">
          <strong>请确认以下提醒</strong>
          <ul>{pending.warnings.map((warning) => <li key={`${warning.code}:${warning.message}`}>{warning.message}</li>)}</ul>
          <div className="button-row">
            <button className="button secondary-button" type="button" onClick={() => setPending(null)}>返回修改</button>
            <button className="button primary-button" type="button" onClick={() => void complete(pending.kind, pending.draft, true)}>确认保存</button>
          </div>
        </div>
      )}
      <div className="relationship-columns">
        <form onSubmit={(event) => { event.preventDefault(); void complete("parentChild", parentDraft, false); }}>
          <h3>亲子关系</h3>
          <label><span>父母人物</span><select className="field-control" aria-label="父母人物" required value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">请选择</option>{personOptions(childId)}</select></label>
          <label><span>子女人物</span><select className="field-control" aria-label="子女人物" required value={childId} onChange={(event) => setChildId(event.target.value)}><option value="">请选择</option>{personOptions(parentId)}</select></label>
          <label><span>父母角色</span><select className="field-control" aria-label="父母角色" value={parentRole} onChange={(event) => setParentRole(event.target.value as "father" | "mother")}><option value="father">父亲</option><option value="mother">母亲</option></select></label>
          <label><span>来源说明</span><input className="field-control" aria-label="亲子关系来源" required value={parentSource} onChange={(event) => setParentSource(event.target.value)} /></label>
          <button className="button primary-button" type="submit">保存亲子关系</button>
        </form>
        <form onSubmit={(event) => { event.preventDefault(); void complete("marriage", marriageDraft, false); }}>
          <h3>婚姻</h3>
          <label><span>配偶一</span><select className="field-control" aria-label="配偶一" required value={spouseAId} onChange={(event) => setSpouseAId(event.target.value)}><option value="">请选择</option>{personOptions(spouseBId)}</select></label>
          <label><span>配偶二</span><select className="field-control" aria-label="配偶二" required value={spouseBId} onChange={(event) => setSpouseBId(event.target.value)}><option value="">请选择</option>{personOptions(spouseAId)}</select></label>
          <PartialDateField label="结婚日期" value={marriageStart} onChange={setMarriageStart} />
          <label><span>来源说明</span><input className="field-control" aria-label="婚姻来源" required value={marriageSource} onChange={(event) => setMarriageSource(event.target.value)} /></label>
          <button className="button primary-button" type="submit">保存婚姻</button>
        </form>
      </div>
    </section>
  );
}
