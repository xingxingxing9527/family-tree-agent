import React, { useState, type FormEvent, type JSX } from "react";

interface LinkOption { id: string; displayName?: string; title?: string; }
interface WikiEditorProps { api: { create(input: { title: string; body: string; personIds: string[]; sourceIds: string[] }): Promise<{ ok: boolean }> ; update: unknown; remove: unknown; get: unknown }; people: LinkOption[]; sources: LinkOption[]; }

export function WikiEditor({ api, people, sources }: WikiEditorProps): JSX.Element {
  const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [personIds, setPersonIds] = useState<string[]>([]); const [sourceIds, setSourceIds] = useState<string[]>([]); const [error, setError] = useState<string | null>(null);
  const toggle = (id: string, values: string[], setValues: (next: string[]) => void): void => setValues(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  const save = async (event: FormEvent): Promise<void> => { event.preventDefault(); const result = await api.create({ title, body, personIds, sourceIds }); if (!result.ok) setError("无法保存词条"); };
  return <form onSubmit={(event) => void save(event)} aria-label="家谱词条编辑器"><label>词条标题<input aria-label="词条标题" required value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>词条正文<textarea aria-label="词条正文" value={body} onChange={(event) => setBody(event.target.value)} /></label><fieldset><legend>关联人物</legend>{people.map((person) => <label key={person.id}><input type="checkbox" aria-label={`关联人物：${person.displayName ?? person.id}`} checked={personIds.includes(person.id)} onChange={() => toggle(person.id, personIds, setPersonIds)} />{person.displayName}</label>)}</fieldset><fieldset><legend>关联来源</legend>{sources.map((source) => <label key={source.id}><input type="checkbox" aria-label={`关联来源：${source.title ?? source.id}`} checked={sourceIds.includes(source.id)} onChange={() => toggle(source.id, sourceIds, setSourceIds)} />{source.title}</label>)}</fieldset>{error && <p role="alert">{error}</p>}<button type="submit">保存词条</button></form>;
}
