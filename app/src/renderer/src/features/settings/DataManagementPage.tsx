import React, { useEffect, useMemo, useState, type JSX } from "react";
import type { BackupInspectionDto, DataManagementApi, WorkspaceSummary } from "../../../../shared/contracts";
import { AuditHistory } from "./AuditHistory";
import { PrivacyWarning } from "./PrivacyWarning";

export interface DataManagementPageProps { api: DataManagementApi; }

export function DataManagementPage({ api }: DataManagementPageProps): JSX.Element {
  const [targets, setTargets] = useState<WorkspaceSummary[]>([]);
  const [targetId, setTargetId] = useState("");
  const [fileToken, setFileToken] = useState("");
  const [fileName, setFileName] = useState("");
  const [inspection, setInspection] = useState<BackupInspectionDto | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedTarget = useMemo(() => targets.find((target) => target.id === targetId) ?? null, [targetId, targets]);

  useEffect(() => {
    void api.listRestoreTargets().then((result) => {
      if (!result.ok) { setError(result.error.message); return; }
      setTargets(result.value);
      setTargetId((current) => current || result.value[0]?.id || "");
    });
  }, [api]);

  const run = async (operation: () => Promise<{ ok: boolean; error?: { message: string } }>, success: string): Promise<void> => {
    setError(null); setMessage(null);
    const result = await operation();
    if (!result.ok) setError(result.error?.message ?? "操作失败");
    else setMessage(success);
  };
  const selectRestore = async (): Promise<void> => {
    setError(null); setInspection(null); setConfirmed(false);
    const result = await api.selectRestoreFile();
    if (!result.ok) { setError(result.error.message); return; }
    if (!result.value.selected || !result.value.fileToken || !result.value.fileName) { setFileToken(""); setFileName(""); return; }
    setFileToken(result.value.fileToken); setFileName(result.value.fileName);
  };
  const inspect = async (): Promise<void> => {
    if (!fileToken || !targetId) return;
    setError(null); setInspection(null); setConfirmed(false);
    const result = await api.inspectBackup({ fileToken, targetWorkspaceId: targetId });
    if (!result.ok) { setError(result.error.message); return; }
    setInspection(result.value);
  };
  const restore = async (): Promise<void> => {
    if (!inspection || !confirmed) return;
    await run(() => api.restoreBackup({ restoreToken: inspection.restoreToken, targetWorkspaceId: inspection.targetWorkspaceId, confirmReplace: true }), "恢复完成，自动快照已验证");
  };

  return <main>
    <header><h1>数据管理</h1></header>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <section aria-labelledby="backup-export-title">
      <h2 id="backup-export-title">备份与导出</h2>
      <PrivacyWarning />
      <button type="button" onClick={() => void run(() => api.createBackup(), "备份已创建并验证")}>创建备份</button>
      <button type="button" onClick={() => void run(() => api.exportWorkspace(), "资料已导出")}>导出资料</button>
    </section>
    <section aria-labelledby="restore-title">
      <h2 id="restore-title">恢复备份</h2>
      <button type="button" onClick={() => void selectRestore()}>选择备份文件</button>
      <output>{fileName || "未选择备份文件"}</output>
      <label>恢复目标谱册
        <select aria-label="恢复目标谱册" value={targetId} onChange={(event) => { setTargetId(event.target.value); setInspection(null); setConfirmed(false); }}>
          <option value="">请选择</option>
          {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
        </select>
      </label>
      <button type="button" disabled={!fileToken || !targetId} onClick={() => void inspect()}>验证备份</button>
      {inspection && <div aria-label="备份验证结果">
        <strong>{inspection.verified ? "验证通过" : "验证失败"}</strong>
        <p>{inspection.manifest.createdAt}</p>
        <p>架构版本 {inspection.manifest.schemaVersion}</p>
        <p>人物 {inspection.manifest.counts.people} · 亲子 {inspection.manifest.counts.parentChild} · 婚姻 {inspection.manifest.counts.marriages} · 词条 {inspection.manifest.counts.wikiEntries} · 审计 {inspection.manifest.counts.auditRows} · 媒体 {inspection.manifest.counts.mediaAssets}</p>
        <p>恢复目标：{selectedTarget?.name ?? inspection.targetWorkspaceId}</p>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我确认用已验证备份替换{selectedTarget?.name ?? "目标谱册"}</label>
        <button type="button" disabled={!confirmed} onClick={() => void restore()}>替换目标谱册</button>
      </div>}
    </section>
    <AuditHistory api={api} />
  </main>;
}
