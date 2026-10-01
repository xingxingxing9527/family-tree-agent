import React, { useMemo, useState, type JSX } from "react";
import type { MutationDisposition, MutationPreview } from "../../../../shared/mutations";

const labels: Record<MutationDisposition, string> = { create: "新增", update: "更新", unchanged: "未变化", blocked: "阻断问题" };

export function MutationReviewDialog({ preview, busy = false, onCancel, onConfirm }: {
  preview: MutationPreview;
  busy?: boolean;
  onCancel(): void;
  onConfirm(selectedChangeIds: string[], acknowledgedWarningCodes: string[]): void;
}): JSX.Element {
  const actionable = useMemo(() => preview.changes.filter((change) => change.disposition === "create" || change.disposition === "update"), [preview]);
  const [selected, setSelected] = useState(() => new Set(actionable.map((change) => change.id)));
  const warnings = useMemo(() => preview.issues.filter((issue) => issue.severity === "warning" && selected.has(issue.changeId)), [preview, selected]);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const warningCodes = [...new Set(warnings.map((warning) => warning.code))];
  const ready = selected.size > 0 && warningCodes.every((code) => acknowledged.has(code));

  return <div className="modal-backdrop"><section className="confirmation-dialog mutation-review" role="dialog" aria-modal="true" aria-label="确认写入">
    <h2>确认写入</h2>
    <p>写入前请核对系统识别出的变化。确认后会作为一个操作整体保存并可从历史记录撤销。</p>
    {(["create", "update", "unchanged", "blocked"] as const).map((disposition) => {
      const changes = preview.changes.filter((change) => change.disposition === disposition);
      if (changes.length === 0) return null;
      return <section key={disposition}><h3>{labels[disposition]}</h3><ul>{changes.map((change) => <li key={change.id}>
        {(disposition === "create" || disposition === "update") && <input
          aria-label={`选择 ${change.summary}`}
          type="checkbox"
          checked={selected.has(change.id)}
          onChange={(event) => setSelected((current) => {
            const next = new Set(current);
            if (event.target.checked) next.add(change.id); else next.delete(change.id);
            return next;
          })}
        />}
        <span>{change.summary}</span>
        {preview.issues.filter((issue) => issue.changeId === change.id && issue.severity === "error").map((issue) => <p role="alert" key={`${issue.code}:${issue.message}`}>{issue.message}</p>)}
      </li>)}</ul></section>;
    })}
    {warnings.length > 0 && <section><h3>提醒</h3><ul>{warnings.map((warning) => <li key={`${warning.changeId}:${warning.code}:${warning.message}`}>{warning.message}</li>)}</ul>
      {warningCodes.map((code) => <label key={code}><input type="checkbox" aria-label={`我已阅读 ${code} 提醒`} checked={acknowledged.has(code)} onChange={(event) => setAcknowledged((current) => {
        const next = new Set(current); if (event.target.checked) next.add(code); else next.delete(code); return next;
      })} />我已阅读 {code} 提醒</label>)}
    </section>}
    <div className="button-row"><button type="button" className="button secondary-button" disabled={busy} onClick={onCancel}>返回修改</button><button type="button" className="button primary-button" disabled={busy || !ready} onClick={() => onConfirm([...selected], warningCodes)}>确认写入</button></div>
  </section></div>;
}
