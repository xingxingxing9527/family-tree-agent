import React, { useCallback, useEffect, useState, type JSX } from "react";
import type { DesktopApi, PersonDetailReadModel, PersonDraft, PersonListItem, WorkspaceSummary } from "../../../../shared/contracts";
import { RelationshipEditor } from "../relations/RelationshipEditor";
import { PersonDetail } from "./PersonDetail";
import { PersonEditor } from "./PersonEditor";
import { MergeHistory } from "./MergeHistory";
import { MergePanel } from "./MergePanel";
import "./people.css";

interface PeoplePageProps {
  workspace: WorkspaceSummary;
  api: DesktopApi;
}

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

export function PeoplePage({ workspace, api }: PeoplePageProps): JSX.Element {
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [selected, setSelected] = useState<PersonDetailReadModel | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPeople = useCallback(async (): Promise<void> => {
    const result = await api.people.list({ limit: 100, offset: 0 });
    if (result.ok) setPeople(result.value);
    else setError(result.error.message);
  }, [api]);

  const loadDetail = useCallback(async (personId: string): Promise<void> => {
    const result = await api.people.get({ personId });
    if (result.ok) setSelected(result.value);
    else setError(result.error.message);
  }, [api]);

  useEffect(() => { void loadPeople(); }, [loadPeople]);

  const personSaved = async (detail: PersonDetailReadModel): Promise<void> => {
    setSelected(detail);
    setCreating(false);
    setEditing(false);
    await loadPeople();
  };

  const relationsChanged = async (): Promise<void> => {
    await loadPeople();
    if (selected) await loadDetail(selected.person.id);
  };

  return (
    <main className="people-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow text-secondary">当前谱册</p>
          <h1>{workspace.name}</h1>
        </div>
        <button className="button primary-button" type="button" onClick={() => { setCreating(true); setEditing(false); }}>新增人物</button>
      </header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="people-layout">
        <aside className="people-list" aria-label="人物列表">
          <h2>人物库</h2>
          {people.length === 0 && <p className="text-secondary">还没有人物，请先新增一位。</p>}
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
          {creating && <PersonEditor api={api.people} onSaved={(detail) => void personSaved(detail)} onCancel={() => setCreating(false)} />}
          {editing && selected && (
            <PersonEditor
              key={`${selected.person.id}:${selected.person.rowVersion}`}
              api={api.people}
              personId={selected.person.id}
              expectedVersion={selected.person.rowVersion}
              initialValue={draftFromDetail(selected)}
              onSaved={(detail) => void personSaved(detail)}
              onCancel={() => setEditing(false)}
            />
          )}
          {!creating && !editing && selected && (
            <><PersonDetail detail={selected} relationsApi={api.relations} onEdit={() => setEditing(true)} onChanged={relationsChanged} /><MergePanel personId={selected.person.id} api={api.merges} onMerged={() => void relationsChanged()} /></>
          )}
          {!creating && !editing && !selected && <section className="empty-state"><h2>选择人物</h2><p className="text-secondary">从左侧人物库打开详情，或新增第一位家庭成员。</p></section>}
          {people.length >= 2 && <RelationshipEditor people={people} peopleApi={api.people} relationsApi={api.relations} onSaved={relationsChanged} />}
          <MergeHistory api={api.merges} />
        </div>
      </div>
    </main>
  );
}
