import React, { useEffect, useRef, useState, type JSX } from "react";
import type { MergeApi, MergeHistoryDto } from "../../../../shared/contracts";
type Check = { kind: "checking" } | { kind: "allowed" } | { kind: "blocked"; text: string } | { kind: "error"; text: string };
const blockedText = (value: { blockingEntityIds: string[]; reasons: Array<{ entityId: string; entityType: string; expectedVersion: number; actualVersion: number | null }> }): string => `不可撤销：${value.blockingEntityIds.join("、")}（${value.reasons.map((reason) => `${reason.entityType}:${reason.entityId} expected ${reason.expectedVersion} actual ${reason.actualVersion ?? "missing"}`).join("；")}）`;
export function MergeHistory({ api, onMutationComplete }: { api: MergeApi; onMutationComplete?(): void | Promise<void> }): JSX.Element {
  const [history, setHistory] = useState<MergeHistoryDto[]>([]); const [checks, setChecks] = useState<Record<string, Check>>({}); const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const load = async (): Promise<void> => {
    const activeRequest = ++requestId.current;
    try {
      const result = await api.history();
      if (activeRequest !== requestId.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setHistory(result.value); setError(null);
      const active = result.value.filter((entry) => entry.status === "active");
      setChecks(Object.fromEntries(active.map((entry) => [entry.id, { kind: "checking" }] as const)));
      const resolved = await Promise.all(active.map(async (entry): Promise<readonly [string, Check]> => {
        try {
          const checked = await api.canUnmerge({ mergeId: entry.id });
          return [entry.id, !checked.ok ? { kind: "error", text: checked.error.message } : checked.value.allowed ? { kind: "allowed" } : { kind: "blocked", text: blockedText(checked.value) }];
        } catch { return [entry.id, { kind: "error", text: "无法检查撤销条件" }]; }
      }));
      if (activeRequest === requestId.current) setChecks(Object.fromEntries(resolved));
    } catch { if (activeRequest === requestId.current) setError("无法读取合并历史"); }
  };
  useEffect(() => { void load(); return () => { requestId.current += 1; }; }, [api]);
  const reverse = async (id: string): Promise<void> => {
    try {
      const checked = await api.canUnmerge({ mergeId: id });
      if (!checked.ok || !checked.value.allowed) { setChecks((current) => ({ ...current, [id]: !checked.ok ? { kind: "error", text: checked.error.message } : { kind: "blocked", text: blockedText(checked.value) } })); return; }
      const result = await api.unmerge({ mergeId: id });
      if (!result.ok) setChecks((current) => ({ ...current, [id]: { kind: "error", text: result.error.message } }));
      else if (onMutationComplete) await onMutationComplete();
      else await load();
    } catch { setChecks((current) => ({ ...current, [id]: { kind: "error", text: "无法撤销合并" } })); }
  };
  return <section className="detail-card merge-history"><h2>合并历史</h2>{error && <p className="error-banner" role="alert">{error}</p>}{!error && history.length === 0 && <p className="text-secondary">暂无合并记录。</p>}{history.map((entry) => { const check = checks[entry.id]; return <div className="merge-history-row" key={entry.id}><span>{entry.status === "active" ? "已合并" : "已撤销"}</span><code>{entry.primaryPersonId} ← {entry.secondaryPersonId}</code>{entry.status === "active" && check?.kind === "checking" && <span className="text-secondary">检查中</span>}{entry.status === "active" && check?.kind === "allowed" && <><span>可撤销</span><button className="button secondary-button" onClick={() => void reverse(entry.id)}>撤销合并</button></>}{(check?.kind === "blocked" || check?.kind === "error") && <p className="text-secondary">{check.text}</p>}</div>; })}</section>;
}
