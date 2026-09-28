import React, { useEffect, useMemo, useState, type JSX } from "react";
import type { ConversationDraftPreview } from "../../../../shared/chat";

export function MutationDraftPreview({ preview, onConfirm }: { preview: ConversationDraftPreview; onConfirm(selectedChangeIds: string[]): void }): JSX.Element {
  const [selected, setSelected] = useState(() => new Set(preview.changes.map((change) => change.id)));
  useEffect(() => setSelected(new Set(preview.changes.map((change) => change.id))), [preview.id]);
  const resolved = preview.unresolvedReferences.length === 0 && preview.conflicts.length === 0;
  const selectable = useMemo(() => new Map(preview.changes.map((change) => [change.id, change])), [preview]);
  const toggle = (id: string): void => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const validSelection = [...selected].every((id) => {
    const change = selectable.get(id);
    return Boolean(change && change.dependsOnChangeIds.every((dependency) => selected.has(dependency)));
  });
  return (
    <section aria-label="变更草稿预览">
      <h3>待确认变更（版本 {preview.version}）</h3>
      <ul>{preview.changes.map((change) => <li key={change.id}><label><input type="checkbox" checked={selected.has(change.id)} onChange={() => toggle(change.id)} />{change.summary}</label>
        <ul>{change.fieldChanges.map((field) => <li key={field.field}>{field.field}: {JSON.stringify(field.before)} → {JSON.stringify(field.after)}</li>)}</ul>
      </li>)}</ul>
      {preview.unresolvedReferences.map((entry) => <p role="alert" key={entry.reference}>{entry.reference}：{entry.reason}</p>)}
      {resolved && <button type="button" disabled={!validSelection || selected.size === 0} onClick={() => onConfirm([...selected])}>确认写入</button>}
    </section>
  );
}
