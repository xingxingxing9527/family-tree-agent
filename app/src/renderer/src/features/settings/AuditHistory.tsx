import React, { useCallback, useEffect, useState, type JSX } from "react";
import type { AuditOperationGroupDto, DataManagementApi } from "../../../../shared/contracts";

export interface AuditHistoryProps { api: DataManagementApi; }

export function AuditHistory({ api }: AuditHistoryProps): JSX.Element {
  const [groups, setGroups] = useState<AuditOperationGroupDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<AuditOperationGroupDto | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await api.listAudit();
      if (result.ok) { setGroups(result.value); setError(null); }
      else setError(result.error.message);
    } catch { setError("无法读取操作历史"); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  const undo = async (operationGroupId: string): Promise<void> => {
    setBusyId(operationGroupId);
    try {
      const result = await api.undoOperationGroup({ operationGroupId });
      if (!result.ok) setError(result.error.message);
      else { setPendingUndo(null); setConfirmed(false); await load(); }
    } catch { setError("无法撤销操作，请稍后重试。"); }
    finally { setBusyId(null); }
  };

  return <section aria-labelledby="audit-history-title">
    <h2 id="audit-history-title">操作历史</h2>
    {error && <p role="alert">{error}</p>}
    {groups.length === 0 ? <p>暂无操作记录</p> : <ul>
      {groups.map((group) => <li key={group.id}>
        <p>{group.kind} · {group.createdAt} · {group.status}</p>
        <p>影响：{group.affectedEntities.length ? group.affectedEntities.map((entity) => `${entity.entityType}:${entity.entityId}`).join("、") : "无"}</p>
        {group.reason && <p>{group.reason}</p>}
        {group.undoable && <button type="button" aria-label={`撤销 ${group.id}`} disabled={busyId !== null} onClick={() => { setPendingUndo(group); setConfirmed(false); }}>{busyId === group.id ? "撤销中" : "撤销"}</button>}
      </li>)}
    </ul>}
    {pendingUndo && <div className="modal-backdrop"><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-label="确认撤销操作">
      <h3>确认撤销操作</h3>
      <p>操作：{pendingUndo.kind}</p>
      <p>将影响以下实体：</p>
      <ul>{pendingUndo.affectedEntities.map((entity) => <li key={`${entity.entityType}:${entity.entityId}`}>{entity.entityType}:{entity.entityId}</li>)}</ul>
      <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我确认撤销以上 {pendingUndo.affectedEntities.length} 个受影响实体</label>
      <div className="button-row"><button type="button" className="button danger-button" disabled={!confirmed || busyId !== null} onClick={() => void undo(pendingUndo.id)}>确认撤销</button><button type="button" className="button secondary-button" disabled={busyId !== null} onClick={() => { setPendingUndo(null); setConfirmed(false); }}>取消</button></div>
    </section></div>}
  </section>;
}
