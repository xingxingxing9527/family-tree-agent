import React, { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { FamilyAgentApi, PersonDetailReadModel, PersonDraft, PersonListItem } from "../../../../shared/contracts";
import type { RelativeQuickCreateRequest } from "../relations/FamilyRelationsPanel";
import { PersonDetail } from "../people/PersonDetail";
import { PersonEditor } from "../people/PersonEditor";
import type { TreeSelection } from "./FamilyTreeCanvas";

interface TreeContextDrawerProps {
  selection: TreeSelection;
  api: FamilyAgentApi;
  onClose(): void;
  onDataChanged(): void | Promise<void>;
  onUseAsViewpoint?(personId: string): void;
  onAskAbout?(personId: string): void;
}

function draftFromDetail(detail: PersonDetailReadModel): PersonDraft {
  return {
    displayName: detail.person.displayName,
    aliases: detail.aliases,
    gender: detail.person.gender,
    birth: detail.person.birth,
    death: detail.person.death,
    notes: detail.person.notes,
    sourceDescription: "家谱树修订"
  };
}

export function TreeContextDrawer({ selection, api, onClose, onDataChanged, onUseAsViewpoint, onAskAbout }: TreeContextDrawerProps): JSX.Element {
  const [detail, setDetail] = useState<PersonDetailReadModel | null>(null);
  const [editing, setEditing] = useState(false);
  const [relativeCreation, setRelativeCreation] = useState<RelativeQuickCreateRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const relativeCreationSection = useRef<HTMLElement | null>(null);
  const selectedPersonId = selection.kind === "person" ? selection.personId : null;

  const loadDetail = useCallback(async (personId: string): Promise<void> => {
    const activeRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.people.get({ personId });
      if (activeRequest !== requestId.current) return;
      if (result.ok) setDetail(result.value);
      else { setDetail(null); setError(result.error.message); }
    } catch {
      if (activeRequest === requestId.current) { setDetail(null); setError("无法读取人物详情"); }
    } finally {
      if (activeRequest === requestId.current) setLoading(false);
    }
  }, [api.people]);

  useEffect(() => {
    setEditing(false);
    setRelativeCreation(null);
    setDetail(null);
    setError(null);
    if (selectedPersonId) void loadDetail(selectedPersonId);
    return () => { requestId.current += 1; };
  }, [loadDetail, selectedPersonId]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    if (!relativeCreation) return;
    relativeCreationSection.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    relativeCreationSection.current?.querySelector<HTMLInputElement>('input[aria-label="姓名"]')?.focus();
  }, [relativeCreation]);

  const changed = useCallback(async (): Promise<void> => {
    await onDataChanged();
    if (selectedPersonId) await loadDetail(selectedPersonId);
  }, [loadDetail, onDataChanged, selectedPersonId]);

  const personSaved = async (saved: PersonDetailReadModel): Promise<void> => {
    setDetail(saved);
    setEditing(false);
    setRelativeCreation(null);
    await onDataChanged();
  };

  const relativePersonSaved = (saved: PersonDetailReadModel): void => {
    const request = relativeCreation;
    if (!request || request.ownerPersonId !== selectedPersonId) return;
    setRelativeCreation(null);
    void request.onCreated({ ...saved.person, aliases: saved.aliases });
  };

  return <aside className="tree-context-drawer" role="complementary" aria-label="人物与关系编辑">
    <header className="tree-context-drawer-header">
      <div><p className="eyebrow">家谱快捷编辑</p><h2>{selection.kind === "person" ? "人物资料与关系" : "关系资料"}</h2></div>
      <button className="button secondary-button" type="button" aria-label="关闭人物与关系编辑" onClick={onClose}>关闭</button>
    </header>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {loading && <p role="status">正在读取人物详情…</p>}
    {selection.kind !== "person" && <section className="empty-state"><h3>关系编辑</h3><p>请选择婚姻或亲子关系后进行修改。</p></section>}
    {relativeCreation && <section ref={relativeCreationSection} className="relative-person-creation" aria-labelledby="tree-relative-person-creation-title">
      <h2 id="tree-relative-person-creation-title">快速新建关系人物：{relativeCreation.purpose}</h2>
      <PersonEditor api={api.people} mutations={api.mutations} onSaved={relativePersonSaved} onMutationPersisted={onDataChanged} onCancel={() => setRelativeCreation(null)} />
    </section>}
    {selection.kind === "person" && editing && detail && <PersonEditor
      key={`${detail.person.id}:${detail.person.rowVersion}`}
      api={api.people}
      mutations={api.mutations}
      personId={detail.person.id}
      expectedVersion={detail.person.rowVersion}
      initialValue={draftFromDetail(detail)}
      onSaved={(saved) => void personSaved(saved)}
      onCancel={() => setEditing(false)}
    />}
    {selection.kind === "person" && !editing && !relativeCreation && detail && <PersonDetail
      key={`${detail.person.id}:${detail.person.rowVersion}`}
      detail={detail}
      peopleApi={api.people}
      relationsApi={api.relations}
      mutations={api.mutations}
      mediaApi={api.media}
      onEdit={() => setEditing(true)}
      onChanged={changed}
      onRequestQuickCreate={setRelativeCreation}
      onUseAsViewpoint={onUseAsViewpoint}
      onAskAbout={onAskAbout}
    />}
  </aside>;
}

