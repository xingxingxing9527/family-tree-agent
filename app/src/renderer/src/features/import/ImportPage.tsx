import React, { useMemo, useState, type FormEvent, type JSX } from "react";
import type { ImportApi, ImportCommitReportDto, ImportPlanDto, ImportSheetDto } from "../../../../shared/contracts";
import { FieldMappingStep } from "./FieldMappingStep";
import { ImportPreview } from "./ImportPreview";
import "./import.css";

interface ImportPageProps { api: ImportApi; }

export function ImportPage({ api }: ImportPageProps): JSX.Element {
  const [fileToken, setFileToken] = useState("");
  const [fileName, setFileName] = useState("");
  const [sourceKey, setSourceKey] = useState("");
  const [csvEntityType, setCsvEntityType] = useState<ImportSheetDto>("People");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<ImportPlanDto | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [report, setReport] = useState<ImportCommitReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isCsv = /\.csv$/i.test(fileName);
  const selectedActionIds = useMemo(() => plan?.actions
    .filter((action) => (action.kind === "create" || action.kind === "update") && !excluded.has(action.id) && action.dependsOnActionIds.every((dependency) => !excluded.has(dependency)))
    .map((action) => action.id) ?? [], [excluded, plan]);

  const preview = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setReport(null);
    const result = await api.parse({ fileToken, sourceKey, ...(isCsv ? { csvEntityType, fieldMapping: mapping } : {}) });
    if (!result.ok) { setError(result.error.message); return; }
    setPlan(result.value);
    setExcluded(new Set());
    setConfirmed(false);
  };

  const commit = async (): Promise<void> => {
    if (!plan || !confirmed) return;
    const result = await api.commit({ planId: plan.id, selectedActionIds });
    if (!result.ok) { setError(result.error.message); return; }
    setReport(result.value);
  };

  const selectFile = async (): Promise<void> => {
    setError(null); const result = await api.selectFile();
    if (!result.ok) { setError(result.error.message); return; }
    setFileToken(result.value.fileToken); setFileName(result.value.fileName); setPlan(null); setReport(null);
  };
  const exportTemplate = async (): Promise<void> => {
    const result = await api.exportTemplate();
    if (!result.ok) setError(result.error.message);
  };

  const toggle = (id: string): void => setExcluded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <main className="import-shell">
      <header><h1>表格导入</h1><p className="text-secondary">先预览、逐行核对，再一次性写入当前谱册。</p></header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <form className="import-card" onSubmit={(event) => void preview(event)}>
        <label><span>导入文件</span><output className="field-control" aria-label="已选导入文件">{fileName || "未选择"}</output></label>
        <button className="button secondary-button" type="button" onClick={() => void selectFile()}>选择导入文件</button>
        <label><span>来源键</span><input className="field-control" aria-label="来源键" required value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} /></label>
        {isCsv && <FieldMappingStep entityType={csvEntityType} mapping={mapping} onEntityTypeChange={setCsvEntityType} onMappingChange={setMapping} />}
        <button className="button primary-button" type="submit" disabled={!fileToken}>解析并预览</button>
      </form>
      <section className="import-card template-export">
        <h2>固定模板</h2>
        <p className="text-secondary">选择保存位置后将创建固定 XLSX 模板。</p>
        <button className="button secondary-button" type="button" onClick={() => void exportTemplate()}>导出模板</button>
      </section>
      {plan && <>
        <ImportPreview plan={plan} excludedActionIds={excluded} onToggleAction={toggle} />
        <label className="confirmation"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已核对变更和问题，并确认写入所选行</label>
        <button className="button primary-button" type="button" disabled={!confirmed} onClick={() => void commit()}>确认导入 {selectedActionIds.length} 行</button>
      </>}
      {report && <section className="import-card" aria-label="导入报告">
        <h2>导入报告</h2>
        <p>已写入 {report.rows.filter((row) => row.disposition === "committed").length} 行；操作组 {report.operationGroupId ?? "无写入"}</p>
        <ul className="issue-list">
          {report.rows.map((row) => <li key={row.actionId}>
            {row.sheet} 第 {row.row} 行 · {row.disposition} · 实体 {row.entityId ?? "无"} · 问题 {row.issueCodes.length ? row.issueCodes.join(", ") : "无"} · 操作组 {row.operationGroupId ?? "无"}
          </li>)}
        </ul>
      </section>}
    </main>
  );
}
