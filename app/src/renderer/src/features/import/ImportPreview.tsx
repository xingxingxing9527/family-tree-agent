import React, { useState, type JSX } from "react";
import type { ImportPlanDto } from "../../../../shared/contracts";

interface ImportPreviewProps {
  plan: ImportPlanDto;
  excludedActionIds: Set<string>;
  onToggleAction(actionId: string): void;
}

const display = (value: unknown): string => value === null ? "空" : typeof value === "object" ? JSON.stringify(value) : String(value);
const sheetLabel: Record<string, string> = { People: "人物信息", ParentChild: "亲子关系", Marriages: "婚姻关系" };
const kindLabel: Record<string, string> = { create: "新增", update: "更新", unchanged: "保持不变", blocked: "阻断" };

export function ImportPreview({ plan, excludedActionIds, onToggleAction }: ImportPreviewProps): JSX.Element {
  const [severity, setSeverity] = useState<"all" | "error" | "warning">("all");
  const issues = severity === "all" ? plan.issues : plan.issues.filter((issue) => issue.severity === severity);
  return (
    <section className="import-preview" aria-label="导入预览">
      <header className="import-summary">
        <h2>导入预览</h2>
        <p>新增 {plan.summary.creates} · 更新 {plan.summary.updates} · 不变 {plan.summary.unchanged} · 阻止 {plan.summary.blocked}</p>
      </header>
      <label>
        <span>问题筛选</span>
        <select className="field-control" aria-label="问题筛选" value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)}>
          <option value="all">全部</option>
          <option value="error">仅错误</option>
          <option value="warning">仅警告</option>
        </select>
      </label>
      <ul className="issue-list">
        {issues.map((issue) => <li className={`issue-${issue.severity}`} key={issue.id}><strong>{issue.code}</strong>：{issue.message}</li>)}
      </ul>
      <div className="action-list">
        {plan.actions.map((action) => {
          const selectable = action.kind === "create" || action.kind === "update";
          const missingPrerequisites = action.dependsOnActionIds.filter((id) => excludedActionIds.has(id));
          const disabled = !selectable || missingPrerequisites.length > 0;
          const sourceSheet = sheetLabel[action.sourceRow.sheet] ?? action.sourceRow.sheet;
          return (
            <article className="import-action" key={action.id}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`包含 ${sourceSheet} 第 ${action.sourceRow.row} 行`}
                  checked={selectable && !excludedActionIds.has(action.id) && missingPrerequisites.length === 0}
                  disabled={disabled}
                  onChange={() => onToggleAction(action.id)}
                />
                <strong>{sourceSheet} 第 {action.sourceRow.row} 行</strong> — {kindLabel[action.kind] ?? action.kind}
              </label>
              {missingPrerequisites.length > 0 && <p className="text-secondary">需要先包含所依赖的人物行。</p>}
              {action.changes.length > 0 && <ul>{action.changes.map((change) => <li key={change.field}>{change.field}: {display(change.before)} → {display(change.after)}</li>)}</ul>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
