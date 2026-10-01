import React, { useEffect, useMemo, useState, type JSX } from "react";
import type { ConversationDraftChangeDto, ConversationDraftPreview } from "../../../../shared/chat";
import type { ParentCompletionMarriageEpisodeDto } from "../../../../shared/contracts";
import { formatPartialDate } from "../people/format-partial-date";

function pruneUnsafeSelections(preview: ConversationDraftPreview, selected: Set<string>): Set<string> {
  const next = new Set(selected);
  const changes = new Map(preview.changes.map((change) => [change.id, change]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const changeId of [...next]) {
      const change = changes.get(changeId);
      if (!change || change.dependsOnChangeIds.every((dependencyId) => next.has(dependencyId))) continue;
      next.delete(changeId);
      changed = true;
    }
  }
  return next;
}

function initialSelection(preview: ConversationDraftPreview): Set<string> {
  const selected = new Set<string>();
  const selectedGroups = new Set<string>();
  for (const change of preview.changes) {
    if (!(change.selectedByDefault ?? true)) continue;
    if (change.selectionGroupId) {
      if (selectedGroups.has(change.selectionGroupId)) continue;
      selectedGroups.add(change.selectionGroupId);
    }
    selected.add(change.id);
  }
  return pruneUnsafeSelections(preview, selected);
}

const originLabel = (change: ConversationDraftChangeDto): string => change.originKind === "spouse_default" ? "系统自动补全" : "人工录入";

const marriageEpisodeLabel = (episode: ParentCompletionMarriageEpisodeDto): string => {
  if (episode.status === "active") return `存续，${formatPartialDate(episode.start)} 至今`;
  return `已离异，${formatPartialDate(episode.start)} 至 ${formatPartialDate(episode.end)}`;
};

export function MutationDraftPreview({ preview, onConfirm }: {
  preview: ConversationDraftPreview;
  onConfirm(selectedChangeIds: string[], acknowledgement: { draftVersion: number; acknowledgedWarningCodes: string[] }): void;
}): JSX.Element {
  const [selected, setSelected] = useState(() => initialSelection(preview));
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);
  useEffect(() => {
    setSelected(initialSelection(preview));
    setWarningsAcknowledged(false);
  }, [preview.id, preview.version]);
  const selectable = useMemo(() => new Map(preview.changes.map((change) => [change.id, change])), [preview]);
  const toggle = (id: string, checked: boolean): void => {
    setWarningsAcknowledged(false);
    setSelected((current) => {
      const next = new Set(current);
      const change = selectable.get(id);
      if (!checked) next.delete(id);
      else {
        if (change?.selectionGroupId) {
          for (const candidate of preview.changes) {
            if (candidate.selectionGroupId === change.selectionGroupId) next.delete(candidate.id);
          }
        }
        next.add(id);
      }
      return pruneUnsafeSelections(preview, next);
    });
  };
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
      <ul>{preview.changes.map((change) => {
        const dependencyReady = change.dependsOnChangeIds.every((dependencyId) => selected.has(dependencyId));
        const badge = originLabel(change);
        const accessibleName = change.originKind ? `选择${badge}：${change.summary}` : change.summary;
        const completion = change.parentCompletion;
        const showCandidates = completion?.status === "ambiguous" && !completion.candidatePersonId && completion.candidates.length > 0;
        return <li key={change.id}>
          <label><input
            type="checkbox"
            aria-label={accessibleName}
            checked={selected.has(change.id)}
            disabled={!dependencyReady}
            onChange={(event) => toggle(change.id, event.currentTarget.checked)}
          /><span className={`mutation-origin mutation-origin-${change.originKind ?? "explicit"}`}>{badge}</span>{change.summary}</label>
          {completion && <p role={completion.status === "conflict" ? "alert" : "status"}>{completion.reason}</p>}
          {showCandidates && <section aria-label="可选配偶候选">
            <p>可选择一位已确认婚姻配偶，或跳过系统自动补全：</p>
            <ul>{completion.candidates.map((candidate) => <li key={candidate.personId}>
              <strong>{candidate.personName}</strong>：{candidate.reason}
              {candidate.marriageEpisodes.length > 0 && <span>；婚姻记录：{candidate.marriageEpisodes.map(marriageEpisodeLabel).join("；")}</span>}
            </li>)}</ul>
          </section>}
          <ul>{change.fieldChanges.map((field) => <li key={field.field}>{field.field}: {JSON.stringify(field.before)} → {JSON.stringify(field.after)}</li>)}</ul>
        </li>;
      })}</ul>
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
