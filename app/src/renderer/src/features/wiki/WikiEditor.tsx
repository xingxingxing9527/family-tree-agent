import React, { useEffect, useState, type FormEvent, type JSX } from "react";
import type { AppResult, WikiEntryReadModel } from "../../../../shared/contracts";

export interface WikiLinkOption { id: string; displayName?: string; title?: string; }
interface WikiEditorApi {
  create(input: { title: string; body: string; personIds: string[]; sourceIds: string[] }): Promise<AppResult<WikiEntryReadModel>>;
  update(input: { wikiEntryId: string; title: string; body: string; personIds: string[]; sourceIds: string[]; expectedVersion: number }): Promise<AppResult<WikiEntryReadModel>>;
  remove(input: { wikiEntryId: string; expectedVersion: number }): Promise<AppResult<null>>;
}
interface WikiEditorProps {
  api: WikiEditorApi;
  people: WikiLinkOption[];
  sources: WikiLinkOption[];
  entry?: WikiEntryReadModel | null;
  onSaved?(entry: WikiEntryReadModel): void;
  onDeleted?(wikiEntryId: string): void;
}

export function WikiEditor({ api, people, sources, entry = null, onSaved = () => undefined, onDeleted = () => undefined }: WikiEditorProps): JSX.Element {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [body, setBody] = useState(entry?.body ?? "");
  const [personIds, setPersonIds] = useState<string[]>(entry?.personIds ?? []);
  const [sourceIds, setSourceIds] = useState<string[]>(entry?.sourceIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setTitle(entry?.title ?? "");
    setBody(entry?.body ?? "");
    setPersonIds(entry?.personIds ?? []);
    setSourceIds(entry?.sourceIds ?? []);
    setError(null);
    setConfirmDelete(false);
  }, [entry?.id, entry?.rowVersion]);

  const toggle = (id: string, values: string[], setValues: (next: string[]) => void): void => setValues(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = entry
        ? await api.update({ wikiEntryId: entry.id, title, body, personIds, sourceIds, expectedVersion: entry.rowVersion })
        : await api.create({ title, body, personIds, sourceIds });
      if (!result.ok) { setError(result.error.message); return; }
      onSaved(result.value);
      if (!entry) { setTitle(""); setBody(""); setPersonIds([]); setSourceIds([]); }
    } catch {
      setError("无法保存词条，请稍后重试。");
    } finally { setSaving(false); }
  };
  const remove = async (): Promise<void> => {
    if (!entry || !confirmDelete || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.remove({ wikiEntryId: entry.id, expectedVersion: entry.rowVersion });
      if (!result.ok) { setError(result.error.message); return; }
      onDeleted(entry.id);
    } catch {
      setError("无法删除词条，请稍后重试。");
    } finally { setSaving(false); }
  };

  return <form className="content-card" onSubmit={(event) => void save(event)} aria-label="家谱词条编辑器">
    <h2>{entry ? "编辑词条" : "新建词条"}</h2>
    <label>词条标题<input className="field-control" aria-label="词条标题" required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>词条正文<textarea className="field-control" aria-label="词条正文" value={body} onChange={(event) => setBody(event.target.value)} /></label>
    <fieldset><legend>关联人物</legend>{people.map((person) => <label key={person.id}><input type="checkbox" aria-label={`关联人物：${person.displayName ?? person.id}`} checked={personIds.includes(person.id)} onChange={() => toggle(person.id, personIds, setPersonIds)} />{person.displayName}</label>)}</fieldset>
    <fieldset><legend>关联来源</legend>{sources.map((source) => <label key={source.id}><input type="checkbox" aria-label={`关联来源：${source.title ?? source.id}`} checked={sourceIds.includes(source.id)} onChange={() => toggle(source.id, sourceIds, setSourceIds)} />{source.title}</label>)}</fieldset>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="button-row"><button className="button primary-button" type="submit" disabled={saving}>{saving ? "保存中…" : "保存词条"}</button>
      {entry && !confirmDelete && <button className="button danger-button" type="button" onClick={() => setConfirmDelete(true)}>删除词条</button>}
      {entry && confirmDelete && <><span>将删除词条“{entry.title}”</span><button className="button danger-button" type="button" disabled={saving} onClick={() => void remove()}>确认删除词条</button><button className="button secondary-button" type="button" onClick={() => setConfirmDelete(false)}>取消</button></>}
    </div>
  </form>;
}
