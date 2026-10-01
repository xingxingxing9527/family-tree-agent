import React, { useMemo, useState, type JSX } from "react";
import type { MutationDisposition, MutationPreview } from "../../../../shared/mutations";

const labels: Record<MutationDisposition, string> = { create: "新增", update: "更新", unchanged: "未变化", blocked: "阻断问题" };
const actionableDisposition = (disposition: MutationDisposition): boolean => disposition === "create" || disposition === "update";

function pruneUnsafeSelections(preview: MutationPreview, selected: Set<string>): Set<string> {
  const next = new Set(selected);
  const changes = new Map(preview.changes.map((change) => [change.id, change]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const changeId of [...next]) {
      const change = changes.get(changeId);
      if (!change) continue;
      const missing = (change.dependsOnChangeIds ?? []).some((dependencyId) => {
        const dependency = changes.get(dependencyId);
        return dependency?.disposition !== "unchanged" && !next.has(dependencyId);
      });
      if (missing) {
        next.delete(changeId);
        changed = true;
      }
    }
  }
  return next;
}

function toggleSelectionGroup(preview: MutationPreview, selected: Set<string>, id: string, checked: boolean): Set<string> {
  const next = new Set(selected);
  const change = preview.changes.find((entry) => entry.id === id);
  const targets = change?.selectionGroupId
    ? preview.changes.filter((entry) => entry.selectionGroupId === change.selectionGroupId && actionableDisposition(entry.disposition))
    : change ? [change] : [];
  for (const target of targets) {
    if (checked) next.add(target.id);
    else next.delete(target.id);
  }
  return pruneUnsafeSelections(preview, next);
}

export function MutationReviewDialog({ preview, busy = false, onCancel, onConfirm }: {
  preview: MutationPreview;
  busy?: boolean;
  onCancel(): void;
  onConfirm(selectedChangeIds: string[], acknowledgedWarningCodes: string[]): void;
}): JSX.Element {
  const actionable = useMemo(() => preview.changes.filter((change) => actionableDisposition(change.disposition)), [preview]);
  const [selected, setSelected] = useState(() => pruneUnsafeSelections(
    preview,
    new Set(actionable.filter((change) => change.selectedByDefault ?? true).map((change) => change.id))
  ));
  const warnings = useMemo(() => preview.issues.filter((issue) => issue.severity === "warning" && selected.has(issue.changeId)), [preview, selected]);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const warningCodes = [...new Set(warnings.map((warning) => warning.code))];
  const completeGroups = preview.changes.every((change) => {
    if (!change.selectionGroupId || !actionableDisposition(change.disposition)) return true;
    const group = preview.changes.filter((entry) => entry.selectionGroupId === change.selectionGroupId && actionableDisposition(entry.disposition));
    const selectedCount = group.filter((entry) => selected.has(entry.id)).length;
    return selectedCount === 0 || selectedCount === group.length;
  });
  const ready = preview.canConfirm && selected.size > 0 && completeGroups && warningCodes.every((code) => acknowledged.has(code));

  return <div className="modal-backdrop"><section className="confirmation-dialog mutation-review" role="dialog" aria-modal="true" aria-label="确认写入">
    <h2>确认写入</h2>
    <p>写入前请核对系统识别出的变化。确认后会作为一个操作整体保存并可从历史记录撤销。</p>
    {(["create", "update", "unchanged", "blocked"] as const).map((disposition) => {
      const changes = preview.changes.filter((change) => change.disposition === disposition);
      if (changes.length === 0) return null;
      return <section key={disposition}><h3>{labels[disposition]}</h3><ul>{changes.map((change) => {
        const dependencyReady = (change.dependsOnChangeIds ?? []).every((dependencyId) => {
          const dependency = preview.changes.find((entry) => entry.id === dependencyId);
          return dependency?.disposition === "unchanged" || selected.has(dependencyId);
        });
        return <li key={change.id}>
        {actionableDisposition(disposition) && <input
          aria-label={`选择 ${change.summary}`}
          type="checkbox"
          checked={selected.has(change.id)}
          disabled={busy || !dependencyReady}
          onChange={(event) => setSelected((current) => toggleSelectionGroup(preview, current, change.id, event.target.checked))}
        />}
        <span className={`mutation-origin mutation-origin-${change.originKind ?? "explicit"}`}>{change.originKind === "spouse_default" ? "系统自动补全" : "人工录入"}</span>
        <span>{change.summary}</span>
        {preview.issues.filter((issue) => issue.changeId === change.id && issue.severity !== "warning").map((issue) => <p role={issue.severity === "error" ? "alert" : "status"} key={`${issue.code}:${issue.message}`}>{issue.message}</p>)}
      </li>;
      })}</ul></section>;
    })}
    {warnings.length > 0 && <section><h3>提醒</h3><ul>{warnings.map((warning) => <li key={`${warning.changeId}:${warning.code}:${warning.message}`}>{warning.message}</li>)}</ul>
      {warningCodes.map((code) => <label key={code}><input type="checkbox" aria-label={`我已阅读 ${code} 提醒`} checked={acknowledged.has(code)} onChange={(event) => setAcknowledged((current) => {
        const next = new Set(current); if (event.target.checked) next.add(code); else next.delete(code); return next;
      })} />我已阅读 {code} 提醒</label>)}
    </section>}
    <div className="button-row"><button type="button" className="button secondary-button" disabled={busy} onClick={onCancel}>返回修改</button><button type="button" className="button primary-button" disabled={busy || !ready} onClick={() => onConfirm([...selected], warningCodes)}>确认写入</button></div>
  </section></div>;
}
