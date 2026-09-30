import React, { useEffect, useMemo, useState, type FormEvent, type JSX } from "react";
import type { AppResult, FactMutationReceipt, LineageApi, PersonListItem, WorkspaceLineageMembershipReadModel, WorkspaceLineageReadModel } from "../../../../shared/contracts";
import type { PreparedMutationRefresh } from "../../app/WorkspaceContext";

type MembershipForm = {
  lineageRole: "blood" | "married_in" | "associated";
  isPrimary: boolean;
  declaredGeneration: string;
  generationMarker: string;
};

const emptyMembership = (): MembershipForm => ({ lineageRole: "blood", isPrimary: false, declaredGeneration: "", generationMarker: "" });
const fromMembership = (membership: WorkspaceLineageMembershipReadModel): MembershipForm => ({
  lineageRole: membership.role,
  isPrimary: membership.isPrimary,
  declaredGeneration: membership.declaredGeneration === null ? "" : String(membership.declaredGeneration),
  generationMarker: membership.generationMarker ?? ""
});
const generationLabel = (membership: WorkspaceLineageMembershipReadModel): string => {
  const value = membership.generation;
  if (value.conflict) return `世代冲突：声明第${value.declared}代，计算第${value.computed}代`;
  return value.displayed === null ? "世代：未确定" : `世代：第${value.displayed}代（${value.source === "declared" ? "声明" : "计算"}）`;
};

export function LineageSettings({ lineages, people, api, prepareMutation, onChanged }: {
  lineages: WorkspaceLineageReadModel[];
  people: PersonListItem[];
  api: LineageApi;
  prepareMutation?(): PreparedMutationRefresh;
  onChanged?(): void;
}): JSX.Element {
  const names = useMemo(() => new Map(people.map((person) => [person.id, person.displayName])), [people]);
  const [lineageName, setLineageName] = useState("");
  const [founderPersonId, setFounderPersonId] = useState(people[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const [selectedLineageId, setSelectedLineageId] = useState(lineages[0]?.id ?? "");
  const [memberPersonId, setMemberPersonId] = useState(people[0]?.id ?? "");
  const [newMembership, setNewMembership] = useState<MembershipForm>(emptyMembership);
  const [editingLineageId, setEditingLineageId] = useState<string | null>(null);
  const [lineageEdit, setLineageEdit] = useState({ name: "", founderPersonId: "", description: "" });
  const [editingMembershipId, setEditingMembershipId] = useState<string | null>(null);
  const [membershipEdit, setMembershipEdit] = useState<MembershipForm>(emptyMembership);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!people.some((person) => person.id === founderPersonId)) setFounderPersonId(people[0]?.id ?? "");
    if (!people.some((person) => person.id === memberPersonId)) setMemberPersonId(people[0]?.id ?? "");
  }, [founderPersonId, memberPersonId, people]);
  useEffect(() => {
    if (!lineages.some((lineage) => lineage.id === selectedLineageId)) setSelectedLineageId(lineages[0]?.id ?? "");
  }, [lineages, selectedLineageId]);

  const mutate = async (operation: () => Promise<AppResult<FactMutationReceipt>>, successMessage: string): Promise<boolean> => {
    if (pending) return false;
    setPending(true);
    setMessage(null);
    const prepared = prepareMutation?.();
    try {
      const result = await operation();
      if (!result.ok) { setMessage(result.error.message); return false; }
      if (prepared) await prepared.complete();
      onChanged?.();
      setMessage(successMessage);
      return true;
    } catch {
      setMessage("支系资料保存失败，请稍后重试");
      return false;
    } finally { setPending(false); }
  };

  const createLineage = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const saved = await mutate(() => api.createLineage({ name: lineageName, founderPersonId, description: description.trim() || null }), "支系已创建");
    if (saved) { setLineageName(""); setDescription(""); }
  };

  const addMembership = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const saved = await mutate(() => api.addMembership({
      lineageId: selectedLineageId,
      personId: memberPersonId,
      lineageRole: newMembership.lineageRole,
      isPrimary: newMembership.isPrimary,
      declaredGeneration: newMembership.declaredGeneration ? Number(newMembership.declaredGeneration) : null,
      generationMarker: newMembership.generationMarker.trim() || null
    }), "人物归属已添加");
    if (saved) setNewMembership(emptyMembership());
  };

  const openLineageEdit = (lineage: WorkspaceLineageReadModel): void => {
    setEditingLineageId(lineage.id);
    setLineageEdit({ name: lineage.name, founderPersonId: lineage.founderPersonId, description: lineage.description ?? "" });
  };

  const saveLineage = async (lineage: WorkspaceLineageReadModel): Promise<void> => {
    if (await mutate(() => api.updateLineage({
      lineageId: lineage.id,
      expectedVersion: lineage.rowVersion,
      patch: { name: lineageEdit.name, founderPersonId: lineageEdit.founderPersonId, description: lineageEdit.description.trim() || null }
    }), "支系已更新")) setEditingLineageId(null);
  };

  const openMembershipEdit = (membership: WorkspaceLineageMembershipReadModel): void => {
    setEditingMembershipId(membership.id);
    setMembershipEdit(fromMembership(membership));
  };

  const saveMembership = async (membership: WorkspaceLineageMembershipReadModel): Promise<void> => {
    if (await mutate(() => api.updateMembership({
      membershipId: membership.id,
      expectedVersion: membership.rowVersion,
      patch: {
        lineageRole: membershipEdit.lineageRole,
        isPrimary: membershipEdit.isPrimary,
        declaredGeneration: membershipEdit.declaredGeneration ? Number(membershipEdit.declaredGeneration) : null,
        generationMarker: membershipEdit.generationMarker.trim() || null
      }
    }), "人物归属已更新")) setEditingMembershipId(null);
  };

  return <section className="settings-section lineage-settings" aria-labelledby="lineage-settings-title">
    <h2 id="lineage-settings-title">支系与世代</h2>
    <div className="explanation-grid">
      <article><h3>录入原点</h3><p>创建谱册后用于引导录入和默认打开位置。</p></article>
      <article><h3>当前视角</h3><p>只改变称谓和界面标签，不修改人物或关系事实。</p></article>
      <article><h3>支系始祖</h3><p>每个支系独立计算世代；声明世代和字辈都属于这条支系归属。</p></article>
    </div>
    {message && <p role="status" className="status-copy">{message}</p>}
    <form className="lineage-form" onSubmit={(event) => void createLineage(event)}>
      <h3>创建支系</h3>
      <label>支系名称<input value={lineageName} maxLength={200} required onChange={(event) => setLineageName(event.target.value)} /></label>
      <label>支系始祖<select value={founderPersonId} required onChange={(event) => setFounderPersonId(event.target.value)}><option value="">请选择人物</option>{people.map((person) => <option value={person.id} key={person.id}>{person.displayName}</option>)}</select></label>
      <label>支系说明<textarea value={description} maxLength={10_000} onChange={(event) => setDescription(event.target.value)} /></label>
      <button className="button secondary-button" type="submit" disabled={pending || !lineageName.trim() || !founderPersonId}>创建支系</button>
      {people.length === 0 && <p className="empty-copy">请先在人物库创建始祖人物。</p>}
    </form>

    {lineages.length === 0 ? <p className="empty-copy">当前谱册还没有支系记录。</p> : <div className="lineage-list">{lineages.map((lineage) => <article className="lineage-card" key={lineage.id} aria-labelledby={`lineage-${lineage.id}`}>
      {editingLineageId === lineage.id ? <div className="lineage-form compact-form">
        <label>支系名称<input value={lineageEdit.name} onChange={(event) => setLineageEdit((current) => ({ ...current, name: event.target.value }))} /></label>
        <label>支系始祖<select value={lineageEdit.founderPersonId} onChange={(event) => setLineageEdit((current) => ({ ...current, founderPersonId: event.target.value }))}>{people.map((person) => <option value={person.id} key={person.id}>{person.displayName}</option>)}</select></label>
        <label>支系说明<textarea value={lineageEdit.description} onChange={(event) => setLineageEdit((current) => ({ ...current, description: event.target.value }))} /></label>
        <div className="button-row"><button type="button" disabled={pending} onClick={() => void saveLineage(lineage)}>保存支系</button><button type="button" onClick={() => setEditingLineageId(null)}>取消</button></div>
      </div> : <div className="section-heading-row"><div><h3 id={`lineage-${lineage.id}`}>{lineage.name}</h3><p>始祖：{names.get(lineage.founderPersonId) ?? lineage.founderPersonId} · 成员：{lineage.memberCount}{lineage.description ? ` · ${lineage.description}` : ""}</p></div><div className="button-row"><button type="button" onClick={() => openLineageEdit(lineage)}>编辑支系</button><button type="button" disabled={pending} onClick={() => void mutate(() => api.archiveLineage({ lineageId: lineage.id, expectedVersion: lineage.rowVersion }), "支系已归档")}>归档支系</button></div></div>}
      <ul className="membership-list" aria-label={`${lineage.name}成员归属`}>{lineage.memberships.map((membership) => {
        const personName = names.get(membership.personId) ?? membership.personId;
        const founder = membership.personId === lineage.founderPersonId;
        return <li key={membership.id} aria-label={`${personName}在${lineage.name}的归属`}>
          {editingMembershipId === membership.id ? <div className="membership-edit-grid">
            <label>归属角色<select value={membershipEdit.lineageRole} onChange={(event) => setMembershipEdit((current) => ({ ...current, lineageRole: event.target.value as MembershipForm["lineageRole"] }))}><option value="blood">血缘成员</option><option value="married_in">婚入成员</option><option value="associated">关联成员</option></select></label>
            <label>声明世代<input type="number" min="1" max="10000" value={membershipEdit.declaredGeneration} onChange={(event) => setMembershipEdit((current) => ({ ...current, declaredGeneration: event.target.value }))} /></label>
            <label>字辈<input maxLength={50} value={membershipEdit.generationMarker} onChange={(event) => setMembershipEdit((current) => ({ ...current, generationMarker: event.target.value }))} /></label>
            <label className="check-control"><input type="checkbox" checked={membershipEdit.isPrimary} onChange={(event) => setMembershipEdit((current) => ({ ...current, isPrimary: event.target.checked }))} />主归属</label>
            <div className="button-row"><button type="button" disabled={pending} onClick={() => void saveMembership(membership)}>保存归属</button><button type="button" onClick={() => setEditingMembershipId(null)}>取消</button></div>
          </div> : <>
            <div><strong>{personName}</strong>{membership.isPrimary && <span className="tag">主归属</span>}</div>
            <span>角色：{membership.role === "blood" ? "血缘成员" : membership.role === "married_in" ? "婚入成员" : "关联成员"}</span>
            <span>字辈：{membership.generationMarker ?? "未录入"}</span>
            <span className={membership.generation.conflict ? "warning-copy" : undefined}>{generationLabel(membership)}</span>
            <div className="button-row"><button type="button" onClick={() => openMembershipEdit(membership)} aria-label={`编辑${personName}在${lineage.name}的归属`}>编辑归属</button><button type="button" disabled={pending || founder} title={founder ? "始祖归属不能移除" : undefined} onClick={() => void mutate(() => api.removeMembership({ membershipId: membership.id, expectedVersion: membership.rowVersion }), "人物归属已移除")} aria-label={`移除${personName}在${lineage.name}的归属`}>移除归属</button></div>
          </>}
        </li>;
      })}</ul>
    </article>)}</div>}

    {lineages.length > 0 && people.length > 0 && <form className="lineage-form" onSubmit={(event) => void addMembership(event)}>
      <h3>添加人物归属</h3>
      <label>所属支系<select value={selectedLineageId} onChange={(event) => setSelectedLineageId(event.target.value)}>{lineages.map((lineage) => <option value={lineage.id} key={lineage.id}>{lineage.name}</option>)}</select></label>
      <label>归属人物<select value={memberPersonId} onChange={(event) => setMemberPersonId(event.target.value)}>{people.map((person) => <option value={person.id} key={person.id}>{person.displayName}</option>)}</select></label>
      <label>归属角色<select value={newMembership.lineageRole} onChange={(event) => setNewMembership((current) => ({ ...current, lineageRole: event.target.value as MembershipForm["lineageRole"] }))}><option value="blood">血缘成员</option><option value="married_in">婚入成员</option><option value="associated">关联成员</option></select></label>
      <label>声明世代<input type="number" min="1" max="10000" value={newMembership.declaredGeneration} onChange={(event) => setNewMembership((current) => ({ ...current, declaredGeneration: event.target.value }))} /></label>
      <label>字辈<input maxLength={50} value={newMembership.generationMarker} onChange={(event) => setNewMembership((current) => ({ ...current, generationMarker: event.target.value }))} /></label>
      <label className="check-control"><input type="checkbox" checked={newMembership.isPrimary} onChange={(event) => setNewMembership((current) => ({ ...current, isPrimary: event.target.checked }))} />设为主归属</label>
      <button className="button secondary-button" type="submit" disabled={pending || !selectedLineageId || !memberPersonId}>添加归属</button>
    </form>}
  </section>;
}
