import React, { useCallback, useEffect, useState, type JSX } from "react";
import type { AuditOperationGroupDto, DataManagementApi } from "../../../../shared/contracts";

export interface AuditHistoryProps { api: DataManagementApi; }

export function AuditHistory({ api }: AuditHistoryProps): JSX.Element {
  const [groups, setGroups] = useState<AuditOperationGroupDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const load = useCallback(async (): Promise<void> => {
    const result = await api.listAudit();
    if (result.ok) { setGroups(result.value); setError(null); }
    else setError(result.error.message);
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  const undo = async (operationGroupId: string): Promise<void> => {
    setBusyId(operationGroupId);
    const result = await api.undoOperationGroup({ operationGroupId });
    if (!result.ok) setError(result.error.message);
    else await load();
    setBusyId(null);
  };

  return <section aria-labelledby="audit-history-title">
    <h2 id="audit-history-title">操作历史</h2>
    {error && <p role="alert">{error}</p>}
    {groups.length === 0 ? <p>暂无操作记录</p> : <ul>
      {groups.map((group) => <li key={group.id}>
        <p>{group.kind} · {group.createdAt} · {group.status}</p>
        <p>影响：{group.affectedEntities.length ? group.affectedEntities.map((entity) => `${entity.entityType}:${entity.entityId}`).join("、") : "无"}</p>
        {group.reason && <p>{group.reason}</p>}
        {group.undoable && <button type="button" aria-label={`撤销 ${group.id}`} disabled={busyId !== null} onClick={() => void undo(group.id)}>{busyId === group.id ? "撤销中" : "撤销"}</button>}
      </li>)}
    </ul>}
  </section>;
}
