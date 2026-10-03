import React, { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { FamilyAgentApi, PersonDetailReadModel, PersonDraft, PersonListItem, WorkspaceSummary } from "../../../../shared/contracts";
import type { PreparedMutationRefresh } from "../../app/WorkspaceContext";
import type { RelativeQuickCreateRequest } from "../relations/FamilyRelationsPanel";
import { ParentCompletionRepairPanel } from "../relations/ParentCompletionRepairPanel";
import { RelationshipEditor } from "../relations/RelationshipEditor";
import { PersonDetail } from "./PersonDetail";
import { PersonEditor } from "./PersonEditor";
import { formatApproximateAge } from "./format-approximate-age";
import { MergeHistory } from "./MergeHistory";
import { MergePanel } from "./MergePanel";
import "./people.css";

interface PeoplePageProps {
  workspace: WorkspaceSummary;
  api: FamilyAgentApi;
  initialSelectedPersonId?: string | null;
  onDataChanged?(): void;
  prepareMutation?(): PreparedMutationRefresh;
  onSelectedPersonChange?(personId: string | null): void;
  onUseAsViewpoint?(personId: string): void;
  onAskAbout?(personId: string): void;
}

const noop = (): void => undefined;

function draftFromDetail(detail: PersonDetailReadModel): PersonDraft {
  return {
    displayName: detail.person.displayName,
    aliases: detail.aliases,
    gender: detail.person.gender,
    birth: detail.person.birth,
    death: detail.person.death,
    notes: detail.person.notes,
    sourceDescription: "表单修订"
  };
}

export function PeoplePage({ workspace, api, initialSelectedPersonId = null, onDataChanged = noop, prepareMutation, onSelectedPersonChange = noop, onUseAsViewpoint, onAskAbout }: PeoplePageProps): JSX.Element {
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [selected, setSelected] = useState<PersonDetailReadModel | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [relativeCreation, setRelativeCreation] = useState<RelativeQuickCreateRequest | null>(null);
  const [repairingParents, setRepairingParents] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const listRequestId = useRef(0);
  const detailRequestId = useRef(0);
  const selectedPersonId = useRef<string | null>(initialSelectedPersonId);
  const relativeCreationGeneration = useRef(0);
  const relativeCreationSection = useRef<HTMLElement | null>(null);

  const cancelRelativeCreation = useCallback((): void => {
    relativeCreationGeneration.current += 1;
    setRelativeCreation(null);
  }, []);

  const openRelativeCreation = useCallback((request: RelativeQuickCreateRequest): void => {
    if (request.ownerPersonId !== selectedPersonId.current) return;
    relativeCreationGeneration.current += 1;
    setRelativeCreation(request);
    setCreating(false);
    setEditing(false);
  }, []);

  const loadPeople = useCallback(async (): Promise<void> => {
    const activeRequest = ++listRequestId.current;
    setLoading(true);
    try {
      const result = await api.people.list({ limit: 1_000, offset: 0 });
      if (activeRequest !== listRequestId.current) return;
      if (result.ok) { setPeople(result.value); setError(null); }
      else setError(result.error.message);
    } catch { if (activeRequest === listRequestId.current) setError("无法读取人物库"); }
    finally { if (activeRequest === listRequestId.current) setLoading(false); }
  }, [api, workspace.id]);

  const loadDetail = useCallback(async (personId: string): Promise<void> => {
    selectedPersonId.current = personId;
    const activeRequest = ++detailRequestId.current;
    try {
      const result = await api.people.get({ personId });
      if (activeRequest !== detailRequestId.current) return;
      if (result.ok) { setSelected(result.value); onSelectedPersonChange(result.value.person.id); setError(null); }
      else setError(result.error.message);
    } catch { if (activeRequest === detailRequestId.current) setError("无法读取人物详情"); }
  }, [api, onSelectedPersonChange, workspace.id]);

  useEffect(() => {
    cancelRelativeCreation();
    setRepairingParents(false);
    selectedPersonId.current = initialSelectedPersonId;
    setSelected(null);
    void loadPeople();
    if (initialSelectedPersonId) void loadDetail(initialSelectedPersonId);
    else onSelectedPersonChange(null);
    return () => { listRequestId.current += 1; detailRequestId.current += 1; };
  }, [cancelRelativeCreation, initialSelectedPersonId, loadDetail, loadPeople, onSelectedPersonChange, workspace.id]);

  useEffect(() => {
    if (!relativeCreation) return;
    const section = relativeCreationSection.current;
    section?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    section?.querySelector<HTMLInputElement>('input[aria-label="姓名"]')?.focus();
  }, [relativeCreation]);

  const personSaved = async (detail: PersonDetailReadModel): Promise<void> => {
    cancelRelativeCreation();
    selectedPersonId.current = detail.person.id;
    setSelected(detail);
    setCreating(false);
    setEditing(false);
    await loadPeople();
    onDataChanged();
  };

  const relativePersonPersisted = useCallback(async (): Promise<void> => {
    await loadPeople();
    onDataChanged();
  }, [loadPeople, onDataChanged]);

  const relativePersonSaved = (detail: PersonDetailReadModel): void => {
    const request = relativeCreation;
    if (!request) return;
    const generation = relativeCreationGeneration.current;
    setRelativeCreation(null);
    if (generation === relativeCreationGeneration.current && selectedPersonId.current === request.ownerPersonId) {
      void request.onCreated({ ...detail.person, aliases: detail.aliases });
      relativeCreationGeneration.current += 1;
    }
  };

  const relationsChanged = async (): Promise<void> => {
    await loadPeople();
    if (selected) await loadDetail(selected.person.id);
    onDataChanged();
  };

  return (
    <section className="people-shell" aria-labelledby="people-page-title">
      <header className="page-header">
        <div>
          <p className="eyebrow text-secondary">当前谱册</p>
          <h1 id="people-page-title">{workspace.name}</h1>
        </div>
        <div className="button-row">
          <button className="button secondary-button" type="button" onClick={() => setRepairingParents(true)}>检查未完整父母关系</button>
          <button className="button primary-button" type="button" onClick={() => { setCreating(true); setEditing(false); cancelRelativeCreation(); setRepairingParents(false); }}>新增人物</button>
        </div>
      </header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {repairingParents && <ParentCompletionRepairPanel
        relations={api.relations}
        mutations={api.mutations}
        onClose={() => setRepairingParents(false)}
        onCommitted={relationsChanged}
      />}
      <div className="people-layout">
        <aside className="people-list" aria-label="人物列表">
          <h2>人物库</h2>
          {loading && <p role="status">正在加载人物…</p>}
          {!loading && people.length === 0 && <p className="text-secondary">还没有人物，请先新增一位。</p>}
          {people.map((person) => {
            const approximateAge = formatApproximateAge(person.birth, person.death);
            return <button
              className={`person-card ${selected?.person.id === person.id ? "selected" : ""}`}
              type="button"
              key={person.id}
              aria-label={`查看${person.displayName}`}
              onClick={() => { setCreating(false); setEditing(false); cancelRelativeCreation(); setRepairingParents(false); void loadDetail(person.id); }}
            >
              <strong>{person.displayName}</strong>
              <span className="text-secondary">{person.aliases.join("、") || "无别名"}</span>
              {approximateAge && <span className="text-secondary">{approximateAge}</span>}
            </button>
          })}
        </aside>
        <div className="people-content">
          {relativeCreation && <section ref={relativeCreationSection} className="relative-person-creation" aria-labelledby="relative-person-creation-title">
            <h2 id="relative-person-creation-title">快速新建关系人物：{relativeCreation.purpose}</h2>
            <PersonEditor api={api.people} mutations={api.mutations} onSaved={relativePersonSaved} onMutationPersisted={relativePersonPersisted} onCancel={cancelRelativeCreation} />
          </section>}
          {creating && <PersonEditor api={api.people} mutations={api.mutations} onSaved={(detail) => void personSaved(detail)} onCancel={() => setCreating(false)} />}
          {editing && selected && (
            <PersonEditor
              key={`${selected.person.id}:${selected.person.rowVersion}`}
              api={api.people}
              mutations={api.mutations}
              personId={selected.person.id}
              expectedVersion={selected.person.rowVersion}
              initialValue={draftFromDetail(selected)}
              onSaved={(detail) => void personSaved(detail)}
              onCancel={() => setEditing(false)}
            />
          )}
          {!creating && !editing && selected && (
            <><PersonDetail key={selected.person.id} detail={selected} peopleApi={api.people} relationsApi={api.relations} mutations={api.mutations} mediaApi={api.media} onEdit={() => { setEditing(true); cancelRelativeCreation(); }} onChanged={relationsChanged} onRequestQuickCreate={openRelativeCreation} onUseAsViewpoint={onUseAsViewpoint} onAskAbout={onAskAbout} /><MergePanel personId={selected.person.id} api={api.merges} onMerged={() => void relationsChanged()} /></>
          )}
          {!creating && !editing && !selected && <section className="empty-state"><h2>选择人物</h2><p className="text-secondary">从左侧人物库打开详情，或新增第一位家庭成员。</p></section>}
          {people.length >= 2 && <details className="advanced-relations"><summary>高级关系录入</summary><RelationshipEditor people={people} peopleApi={api.people} relationsApi={api.relations} mutations={api.mutations} onSaved={relationsChanged} /></details>}
          <MergeHistory api={api.merges} prepareMutation={prepareMutation} />
        </div>
      </div>
    </section>
  );
}
