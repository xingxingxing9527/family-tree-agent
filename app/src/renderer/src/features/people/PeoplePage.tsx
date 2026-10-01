import React, { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { FamilyAgentApi, PersonDetailReadModel, PersonDraft, PersonListItem, WorkspaceSummary } from "../../../../shared/contracts";
import type { PreparedMutationRefresh } from "../../app/WorkspaceContext";
import { RelationshipEditor } from "../relations/RelationshipEditor";
import { PersonDetail } from "./PersonDetail";
import { PersonEditor } from "./PersonEditor";
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

export function PeoplePage({ workspace, api, initialSelectedPersonId = null, onDataChanged = noop, prepareMutation, onSelectedPersonChange = noop }: PeoplePageProps): JSX.Element {
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [selected, setSelected] = useState<PersonDetailReadModel | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const listRequestId = useRef(0);
  const detailRequestId = useRef(0);

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
    const activeRequest = ++detailRequestId.current;
    try {
      const result = await api.people.get({ personId });
      if (activeRequest !== detailRequestId.current) return;
      if (result.ok) { setSelected(result.value); onSelectedPersonChange(result.value.person.id); setError(null); }
      else setError(result.error.message);
    } catch { if (activeRequest === detailRequestId.current) setError("无法读取人物详情"); }
  }, [api, onSelectedPersonChange, workspace.id]);

  useEffect(() => {
    setSelected(null);
    void loadPeople();
    if (initialSelectedPersonId) void loadDetail(initialSelectedPersonId);
    else onSelectedPersonChange(null);
    return () => { listRequestId.current += 1; detailRequestId.current += 1; };
  }, [initialSelectedPersonId, loadDetail, loadPeople, onSelectedPersonChange, workspace.id]);

  const personSaved = async (detail: PersonDetailReadModel): Promise<void> => {
    setSelected(detail);
    setCreating(false);
    setEditing(false);
    await loadPeople();
    onDataChanged();
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
        <button className="button primary-button" type="button" onClick={() => { setCreating(true); setEditing(false); }}>新增人物</button>
      </header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="people-layout">
        <aside className="people-list" aria-label="人物列表">
          <h2>人物库</h2>
          {loading && <p role="status">正在加载人物…</p>}
          {!loading && people.length === 0 && <p className="text-secondary">还没有人物，请先新增一位。</p>}
          {people.map((person) => (
            <button
              className={`person-card ${selected?.person.id === person.id ? "selected" : ""}`}
              type="button"
              key={person.id}
              aria-label={`查看${person.displayName}`}
              onClick={() => { setCreating(false); setEditing(false); void loadDetail(person.id); }}
            >
              <strong>{person.displayName}</strong>
              <span className="text-secondary">{person.aliases.join("、") || "无别名"}</span>
            </button>
          ))}
        </aside>
        <div className="people-content">
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
            <><PersonDetail detail={selected} peopleApi={api.people} relationsApi={api.relations} mutations={api.mutations} mediaApi={api.media} onEdit={() => setEditing(true)} onChanged={relationsChanged} /><MergePanel personId={selected.person.id} api={api.merges} onMerged={() => void relationsChanged()} /></>
          )}
          {!creating && !editing && !selected && <section className="empty-state"><h2>选择人物</h2><p className="text-secondary">从左侧人物库打开详情，或新增第一位家庭成员。</p></section>}
          {people.length >= 2 && <RelationshipEditor people={people} peopleApi={api.people} relationsApi={api.relations} mutations={api.mutations} onSaved={relationsChanged} />}
          <MergeHistory api={api.merges} prepareMutation={prepareMutation} />
        </div>
      </div>
    </section>
  );
}
