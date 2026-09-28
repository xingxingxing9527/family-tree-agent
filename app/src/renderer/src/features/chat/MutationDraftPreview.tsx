import React, { useEffect, useMemo, useState, type JSX } from "react";
import type { ConversationDraftPreview } from "../../../../shared/chat";

export function MutationDraftPreview({ preview, onConfirm }: {
  preview: ConversationDraftPreview;
  onConfirm(selectedChangeIds: string[], acknowledgement: { draftVersion: number; acknowledgedWarningCodes: string[] }): void;
}): JSX.Element {
  const [selected, setSelected] = useState(() => new Set(preview.changes.map((change) => change.id)));
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);
  useEffect(() => { setSelected(new Set(preview.changes.map((change) => change.id))); setWarningsAcknowledged(false); }, [preview.id]);
  const selectable = useMemo(() => new Map(preview.changes.map((change) => [change.id, change])), [preview]);
  const toggle = (id: string): void => { setWarningsAcknowledged(false); setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }); };
  const validSelection = [...selected].every((id) => {
    const change = selectable.get(id);
    return Boolean(change && change.dependsOnChangeIds.every((dependency) => selected.has(dependency)));
  });
  const selectedWarnings = preview.warnings.filter((warning) => !warning.changeId || selected.has(warning.changeId));
  const selectedConflicts = preview.conflicts.filter((conflict) => !conflict.changeId || selected.has(conflict.changeId));
  const acknowledgedWarningCodes = [...new Set(selectedWarnings.map((warning) => warning.code))];
  const resolved = preview.unresolvedReferences.length === 0 && selectedConflicts.length === 0;
  return (
    <section aria-label="变更草稿预览">
      <h3>待确认变更（版本 {preview.version}）</h3>
      <ul>{preview.changes.map((change) => <li key={change.id}><label><input type="checkbox" checked={selected.has(change.id)} onChange={() => toggle(change.id)} />{change.summary}</label>
        <ul>{change.fieldChanges.map((field) => <li key={field.field}>{field.field}: {JSON.stringify(field.before)} → {JSON.stringify(field.after)}</li>)}</ul>
      </li>)}</ul>
      {preview.warnings.map((warning, index) => <p role="alert" key={`${warning.changeId ?? "draft"}:${warning.code}:${warning.occurrence ?? index}`}>警告 {warning.code}：{warning.message}</p>)}
      {preview.conflicts.map((conflict, index) => <p role="alert" key={`${conflict.changeId ?? "draft"}:${conflict.code}:${conflict.occurrence ?? index}`}>冲突 {conflict.code}：{conflict.message}</p>)}
      {preview.unresolvedReferences.map((entry) => <p role="alert" key={entry.reference}>{entry.reference}：{entry.reason}</p>)}
      {resolved && selectedWarnings.length > 0 && <label><input type="checkbox" checked={warningsAcknowledged} onChange={(event) => setWarningsAcknowledged(event.currentTarget.checked)} />已阅读并确认以上警告</label>}
      {resolved && <button type="button" disabled={!validSelection || selected.size === 0 || (selectedWarnings.length > 0 && !warningsAcknowledged)} onClick={() => onConfirm([...selected], {
        draftVersion: preview.version,
        acknowledgedWarningCodes
      })}>确认写入</button>}
    </section>
  );
}
