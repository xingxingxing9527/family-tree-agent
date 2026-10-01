import React, { useMemo, useRef, useState, type ChangeEvent, type FormEvent, type JSX } from "react";
import type { ImportApi, ImportCommitReportDto, ImportPlanDto, ImportSheetDto } from "../../../../shared/contracts";
import { startDownload, uploadFile } from "../../api/file-client";
import { isHttpApiGroup } from "../../api/http-client";
import { FieldMappingStep } from "./FieldMappingStep";
import { ImportPreview } from "./ImportPreview";
import "./import.css";

interface ImportPageProps { api: ImportApi; onCommitted?(): void; }

export function ImportPage({ api, onCommitted = () => undefined }: ImportPageProps): JSX.Element {
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
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const webMode = isHttpApiGroup(api);
  const isCsv = /\.csv$/i.test(fileName);
  const selectedActionIds = useMemo(() => plan?.actions
    .filter((action) => (action.kind === "create" || action.kind === "update") && !excluded.has(action.id) && action.dependsOnActionIds.every((dependency) => !excluded.has(dependency)))
    .map((action) => action.id) ?? [], [excluded, plan]);

  const preview = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setReport(null);
    setBusy(true);
    try {
      const result = await api.parse({ fileToken, sourceKey, ...(isCsv ? { csvEntityType, fieldMapping: mapping } : {}) });
      if (!result.ok) { setError(result.error.message); return; }
      setPlan(result.value);
      setExcluded(new Set());
      setConfirmed(false);
    } catch { setError("无法解析导入文件"); }
    finally { setBusy(false); }
  };

  const commit = async (): Promise<void> => {
    if (!plan || !confirmed || busy) return;
    setBusy(true);
    try {
      const result = await api.commit({ planId: plan.id, selectedActionIds });
      if (!result.ok) { setError(result.error.message); return; }
      setReport(result.value);
      onCommitted();
    } catch { setError("无法提交导入结果"); }
    finally { setBusy(false); }
  };

  const selectFile = async (): Promise<void> => {
    if (busy) return;
    if (webMode) { fileInput.current?.click(); return; }
    setError(null); setBusy(true);
    try {
      const result = await api.selectFile();
      if (!result.ok) { setError(result.error.message); return; }
      setFileToken(result.value.fileToken); setFileName(result.value.fileName); setPlan(null); setReport(null);
    } catch { setError("无法选择导入文件"); }
    finally { setBusy(false); }
  };
  const uploadSelected = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await uploadFile("import", file);
      if (!result.ok) { setError(result.error.message); return; }
      setFileToken(result.value.fileToken); setFileName(result.value.fileName); setSourceKey((current) => current || `upload:${result.value.fileName}`); setPlan(null); setReport(null);
    } catch { setError("无法上传导入文件"); }
    finally { setBusy(false); }
  };
  const exportWorkbook = async (kind: "current" | "blank"): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = kind === "current" ? await api.exportCurrentWorkbook() : await api.exportBlankWorkbook();
      if (!result.ok) setError(result.error.message);
      else if (result.value.download) startDownload(result.value.download);
    } catch { setError("无法导出模板"); }
    finally { setBusy(false); }
  };

  const toggle = (id: string): void => setExcluded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section className="import-shell" aria-labelledby="spreadsheet-import-title">
      <header><h2 id="spreadsheet-import-title">表格导入</h2><p className="text-secondary">先预览、逐行核对，再一次性写入当前谱册。</p></header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <form className="import-card" onSubmit={(event) => void preview(event)}>
        <label><span>导入文件</span><output className="field-control" aria-label="已选导入文件">{fileName || "未选择"}</output></label>
        <input ref={fileInput} hidden type="file" accept=".xlsx,.csv" onChange={(event) => void uploadSelected(event)} />
        <button className="button secondary-button" type="button" disabled={busy} onClick={() => void selectFile()}>选择导入文件</button>
        <label><span>来源键</span><input className="field-control" aria-label="来源键" required value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} /></label>
        {isCsv && <FieldMappingStep entityType={csvEntityType} mapping={mapping} onEntityTypeChange={setCsvEntityType} onMappingChange={setMapping} />}
        <button className="button primary-button" type="submit" disabled={busy || !fileToken}>解析并预览</button>
      </form>
      <section className="import-card template-export">
        <h2>中文 Excel</h2>
        <p className="text-secondary">继续维护已有家谱时导出当前家谱；首次录入或只想查看格式时下载空白模板。</p>
        <button className="button secondary-button" type="button" disabled={busy} onClick={() => void exportWorkbook("current")}>导出当前家谱表格</button>
        <button className="button secondary-button" type="button" disabled={busy} onClick={() => void exportWorkbook("blank")}>下载空白导入模板</button>
      </section>
      {plan && <>
        <ImportPreview plan={plan} excludedActionIds={excluded} onToggleAction={toggle} />
        <label className="confirmation"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已核对变更和问题，并确认写入所选行</label>
        <button className="button primary-button" type="button" disabled={busy || !confirmed} onClick={() => void commit()}>确认导入 {selectedActionIds.length} 行</button>
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
    </section>
  );
}
