import React, { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { BackupInspectionDto, DataManagementApi, WorkspaceSummary } from "../../../../shared/contracts";
import { startDownload, uploadFile } from "../../api/file-client";
import { isHttpApiGroup } from "../../api/http-client";
import type { PreparedMutationRefresh } from "../../app/WorkspaceContext";
import { AuditHistory } from "./AuditHistory";
import { PrivacyWarning } from "./PrivacyWarning";

export interface DataManagementPageProps {
  api: DataManagementApi;
  refreshToken?: number;
  prepareMutation?(targetWorkspaceId?: string): PreparedMutationRefresh;
}

export function DataManagementPage({ api, refreshToken, prepareMutation }: DataManagementPageProps): JSX.Element {
  const [targets, setTargets] = useState<WorkspaceSummary[]>([]);
  const [targetId, setTargetId] = useState("");
  const [fileToken, setFileToken] = useState("");
  const [fileName, setFileName] = useState("");
  const [inspection, setInspection] = useState<BackupInspectionDto | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<PreparedMutationRefresh | null>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const isWeb = isHttpApiGroup(api as object);
  const selectedTarget = useMemo(() => targets.find((target) => target.id === targetId) ?? null, [targetId, targets]);

  useEffect(() => {
    let current = true;
    void api.listRestoreTargets().then((result) => {
      if (!current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setTargets(result.value);
      setTargetId((current) => current || result.value[0]?.id || "");
    }).catch(() => { if (current) setError("无法读取恢复目标"); });
    return () => { current = false; };
  }, [api]);

  const run = async (operation: () => Promise<{ ok: boolean; error?: { message: string } }>, success: string): Promise<void> => {
    setError(null); setMessage(null);
    try {
      const result = await operation();
      if (!result.ok) setError(result.error?.message ?? "操作失败");
      else setMessage(success);
    } catch { setError("操作失败，请稍后重试"); }
  };
  const selectRestore = async (): Promise<void> => {
    setError(null); setInspection(null); setConfirmed(false);
    if (isWeb) {
      restoreInputRef.current?.click();
      return;
    }
    try {
      const result = await api.selectRestoreFile();
      if (!result.ok) { setError(result.error.message); return; }
      if (!result.value.selected || !result.value.fileToken || !result.value.fileName) { setFileToken(""); setFileName(""); return; }
      setFileToken(result.value.fileToken); setFileName(result.value.fileName);
    } catch { setError("无法选择备份文件"); }
  };
  const uploadRestore = async (file: File): Promise<void> => {
    setError(null); setInspection(null); setConfirmed(false);
    try {
      const uploaded = await uploadFile("backup", file);
      if (!uploaded.ok) { setError(uploaded.error.message); return; }
      setFileToken(uploaded.value.fileToken);
      setFileName(uploaded.value.fileName);
    } catch { setError("无法上传备份文件"); }
  };
  const createBackup = async (): Promise<void> => {
    setError(null); setMessage(null);
    try {
      const result = await api.createBackup();
      if (!result.ok) { setError(result.error.message); return; }
      if (result.value.download) startDownload(result.value.download);
      setMessage("备份已创建并验证");
    } catch { setError("操作失败，请稍后重试"); }
  };
  const inspect = async (): Promise<void> => {
    if (!fileToken || !targetId) return;
    setError(null); setInspection(null); setConfirmed(false);
    try {
      const result = await api.inspectBackup({ fileToken, targetWorkspaceId: targetId });
      if (!result.ok) { setError(result.error.message); return; }
      setInspection(result.value);
    } catch { setError("无法验证备份文件"); }
  };
  const restore = async (): Promise<void> => {
    if (!inspection || !confirmed) return;
    const preparedRefresh = prepareMutation?.(inspection.targetWorkspaceId);
    setError(null); setMessage(null); setRefreshWarning(null);
    let result: Awaited<ReturnType<DataManagementApi["restoreBackup"]>>;
    try {
      result = await api.restoreBackup({ restoreToken: inspection.restoreToken, targetWorkspaceId: inspection.targetWorkspaceId, confirmReplace: true });
    } catch { setError("无法恢复备份"); return; }
    if (!result.ok) { setError(result.error.message); return; }
    setMessage(result.value.cleanupPending ? "恢复已提交，旧工作区清理待完成" : "恢复完成，自动快照已验证");
    if (!preparedRefresh) return;
    try {
      const outcome = await preparedRefresh.complete();
      if (outcome.status === "refresh-failed") setRefreshWarning(preparedRefresh);
    } catch { setRefreshWarning(preparedRefresh); }
  };

  const retryRefresh = async (): Promise<void> => {
    const preparedRefresh = refreshWarning;
    if (!preparedRefresh) return;
    try {
      const outcome = await preparedRefresh.retry();
      if (outcome.status !== "refresh-failed") setRefreshWarning(null);
    } catch { /* Keep the sanitized committed warning visible. */ }
  };

  return <section className="settings-section" aria-labelledby="data-management-title">
    <header><h2 id="data-management-title">数据管理</h2></header>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {refreshWarning && <div role="alert"><p>恢复已提交，但界面刷新失败。请勿重复恢复。</p><button type="button" onClick={() => void retryRefresh()}>重新刷新界面</button></div>}
    <section aria-labelledby="backup-export-title">
      <h2 id="backup-export-title">备份与导出</h2>
      <PrivacyWarning />
      <button type="button" onClick={() => void createBackup()}>创建备份</button>
      <button type="button" onClick={() => void run(() => api.exportWorkspace(), "资料已导出")}>导出资料</button>
    </section>
    <section aria-labelledby="restore-title">
      <h2 id="restore-title">恢复备份</h2>
      {isWeb && <input
        ref={restoreInputRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void uploadRestore(file);
        }}
      />}
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
    <AuditHistory api={api} refreshToken={refreshToken} prepareMutation={prepareMutation ? () => prepareMutation() : undefined} />
  </section>;
}
