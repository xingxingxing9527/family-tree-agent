import React, { useEffect, useRef, useState, type JSX } from "react";
import type { MergeApi, MergeHistoryDto } from "../../../../shared/contracts";
import type { PreparedMutationRefresh } from "../../app/WorkspaceContext";
type Check = { kind: "checking" } | { kind: "allowed" } | { kind: "blocked"; text: string } | { kind: "error"; text: string };
const blockedText = (value: { blockingEntityIds: string[]; reasons: Array<{ entityId: string; entityType: string; expectedVersion: number; actualVersion: number | null }> }): string => `不可撤销：${value.blockingEntityIds.join("、")}（${value.reasons.map((reason) => `${reason.entityType}:${reason.entityId} expected ${reason.expectedVersion} actual ${reason.actualVersion ?? "missing"}`).join("；")}）`;
export function MergeHistory({ api, prepareMutation }: { api: MergeApi; prepareMutation?(): PreparedMutationRefresh }): JSX.Element {
  const [history, setHistory] = useState<MergeHistoryDto[]>([]); const [checks, setChecks] = useState<Record<string, Check>>({}); const [error, setError] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<PreparedMutationRefresh | null>(null);
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
    const preparedRefresh = prepareMutation?.();
    setRefreshWarning(null);
    let checked: Awaited<ReturnType<MergeApi["canUnmerge"]>>;
    try {
      checked = await api.canUnmerge({ mergeId: id });
    } catch { setChecks((current) => ({ ...current, [id]: { kind: "error", text: "无法撤销合并" } })); return; }
    if (!checked.ok || !checked.value.allowed) { setChecks((current) => ({ ...current, [id]: !checked.ok ? { kind: "error", text: checked.error.message } : { kind: "blocked", text: blockedText(checked.value) } })); return; }
    let result: Awaited<ReturnType<MergeApi["unmerge"]>>;
    try {
      result = await api.unmerge({ mergeId: id });
    } catch { setChecks((current) => ({ ...current, [id]: { kind: "error", text: "无法撤销合并" } })); return; }
    if (!result.ok) { setChecks((current) => ({ ...current, [id]: { kind: "error", text: result.error.message } })); return; }
    if (!preparedRefresh) await load();
    else {
      try {
        const outcome = await preparedRefresh.complete();
        if (outcome.status === "refresh-failed") setRefreshWarning(preparedRefresh);
      } catch { setRefreshWarning(preparedRefresh); }
    }
  };
  const retryRefresh = async (): Promise<void> => {
    const preparedRefresh = refreshWarning;
    if (!preparedRefresh) return;
    try {
      const outcome = await preparedRefresh.retry();
      if (outcome.status !== "refresh-failed") setRefreshWarning(null);
    } catch { /* Keep the sanitized committed warning visible. */ }
  };
  return <section className="detail-card merge-history"><h2>合并历史</h2>{error && <p className="error-banner" role="alert">{error}</p>}{refreshWarning && <div className="error-banner" role="alert"><p>撤销合并已提交，但界面刷新失败。请勿重复撤销合并。</p><button type="button" className="button secondary-button" onClick={() => void retryRefresh()}>重新刷新界面</button></div>}{!error && history.length === 0 && <p className="text-secondary">暂无合并记录。</p>}{history.map((entry) => { const check = checks[entry.id]; return <div className="merge-history-row" key={entry.id}><span>{entry.status === "active" ? "已合并" : "已撤销"}</span><code>{entry.primaryPersonId} ← {entry.secondaryPersonId}</code>{entry.status === "active" && check?.kind === "checking" && <span className="text-secondary">检查中</span>}{entry.status === "active" && check?.kind === "allowed" && <><span>可撤销</span><button className="button secondary-button" onClick={() => void reverse(entry.id)}>撤销合并</button></>}{(check?.kind === "blocked" || check?.kind === "error") && <p className="text-secondary">{check.text}</p>}</div>; })}</section>;
}
