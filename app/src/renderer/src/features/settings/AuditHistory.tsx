import React, { useCallback, useEffect, useState, type JSX } from "react";
import type { AuditOperationGroupDto, DataManagementApi } from "../../../../shared/contracts";
import type { PreparedMutationRefresh } from "../../app/WorkspaceContext";
import { formatPartialDate } from "../people/format-partial-date";

export interface AuditHistoryProps {
  api: DataManagementApi;
  refreshToken?: number;
  prepareMutation?(): PreparedMutationRefresh;
}

const statusLabel: Record<AuditOperationGroupDto["status"], string> = {
  available: "可撤销",
  undone: "已撤销",
  blocked: "不可撤销"
};

type AffectedEntity = AuditOperationGroupDto["affectedEntities"][number];

const affectedEntityLabel = (entity: AffectedEntity): string => {
  if (entity.entityType !== "parent_child" || entity.originKind !== "spouse_default") {
    return `${entity.entityType}:${entity.entityId}`;
  }
  const source = entity.inferredFromMarriage;
  if (!source) return "系统自动补全亲子关系（来源婚姻详情暂不可用）";
  const status = source.status === "active" ? "存续" : "已离婚";
  const date = source.start
    ? source.status === "active" && source.end === null
      ? `${formatPartialDate(source.start)} 至今`
      : source.end
        ? `${formatPartialDate(source.start)} 至 ${formatPartialDate(source.end)}`
        : formatPartialDate(source.start)
    : null;
  return `系统自动补全亲子关系：${source.spouseAName} 与 ${source.spouseBName}；${status}${date ? `；${date}` : ""}`;
};

export function AuditHistory({ api, refreshToken, prepareMutation }: AuditHistoryProps): JSX.Element {
  const [groups, setGroups] = useState<AuditOperationGroupDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<AuditOperationGroupDto | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [refreshWarning, setRefreshWarning] = useState<PreparedMutationRefresh | null>(null);
  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await api.listAudit();
      if (result.ok) { setGroups(result.value); setError(null); }
      else setError(result.error.message);
    } catch { setError("无法读取操作历史"); }
  }, [api]);

  useEffect(() => { void load(); }, [load, refreshToken]);
  const undo = async (operationGroupId: string): Promise<void> => {
    const preparedRefresh = prepareMutation?.();
    setBusyId(operationGroupId);
    setRefreshWarning(null);
    let result: Awaited<ReturnType<DataManagementApi["undoOperationGroup"]>>;
    try {
      result = await api.undoOperationGroup({ operationGroupId });
    } catch { setError("无法撤销操作，请稍后重试。"); setBusyId(null); return; }
    if (!result.ok) { setError(result.error.message); setBusyId(null); return; }
    setPendingUndo(null);
    setConfirmed(false);
    if (!preparedRefresh) await load();
    else {
      try {
        const outcome = await preparedRefresh.complete();
        if (outcome.status === "refresh-failed") setRefreshWarning(preparedRefresh);
      } catch { setRefreshWarning(preparedRefresh); }
    }
    setBusyId(null);
  };

  const retryRefresh = async (): Promise<void> => {
    const preparedRefresh = refreshWarning;
    if (!preparedRefresh) return;
    try {
      const outcome = await preparedRefresh.retry();
      if (outcome.status !== "refresh-failed") setRefreshWarning(null);
    } catch { /* Keep the sanitized committed warning visible. */ }
  };

  return <section aria-labelledby="audit-history-title">
    <h2 id="audit-history-title">操作历史</h2>
    {error && <p role="alert">{error}</p>}
    {refreshWarning && <div role="alert"><p>撤销已提交，但界面刷新失败。请勿重复撤销。</p><button type="button" onClick={() => void retryRefresh()}>重新刷新界面</button></div>}
    {groups.length === 0 ? <p>暂无操作记录</p> : <ul>
      {groups.map((group) => <li key={group.id}>
        <p>{group.kind} · {group.createdAt} · {statusLabel[group.status]}</p>
        {group.affectedEntities.length
          ? <><p>影响：</p><ul>{group.affectedEntities.map((entity) => <li key={`${entity.entityType}:${entity.entityId}`}>{affectedEntityLabel(entity)}</li>)}</ul></>
          : <p>影响：无</p>}
        {group.reason && <p>{group.reason}</p>}
        {group.undoable && <button type="button" aria-label={`撤销 ${group.id}`} disabled={busyId !== null} onClick={() => { setPendingUndo(group); setConfirmed(false); }}>{busyId === group.id ? "撤销中" : "撤销"}</button>}
      </li>)}
    </ul>}
    {pendingUndo && <div className="modal-backdrop"><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-label="确认撤销操作">
      <h3>确认撤销操作</h3>
      <p>操作：{pendingUndo.kind}</p>
      <p>将影响以下实体：</p>
      <ul>{pendingUndo.affectedEntities.map((entity) => <li key={`${entity.entityType}:${entity.entityId}`}>{affectedEntityLabel(entity)}</li>)}</ul>
      <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我确认撤销以上 {pendingUndo.affectedEntities.length} 个受影响实体</label>
      <div className="button-row"><button type="button" className="button danger-button" disabled={!confirmed || busyId !== null} onClick={() => void undo(pendingUndo.id)}>确认撤销</button><button type="button" className="button secondary-button" disabled={busyId !== null} onClick={() => { setPendingUndo(null); setConfirmed(false); }}>取消</button></div>
    </section></div>}
  </section>;
}
