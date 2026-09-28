import React, { useEffect, useState, type JSX } from "react";
import type { MergeApi, MergeHistoryDto } from "../../../../shared/contracts";
type Check = { kind: "checking" } | { kind: "allowed" } | { kind: "blocked"; text: string } | { kind: "error"; text: string };
export function MergeHistory({ api }: { api: MergeApi }): JSX.Element {
  const [history, setHistory] = useState<MergeHistoryDto[]>([]); const [checks, setChecks] = useState<Record<string, Check>>({});
  const load = async (): Promise<void> => {
    const result = await api.history(); if (!result.ok) return;
    setHistory(result.value); const active = result.value.filter((entry) => entry.status === "active"); setChecks(Object.fromEntries(active.map((entry) => [entry.id, { kind: "checking" }] as const)));
    await Promise.all(active.map(async (entry) => { const checked = await api.canUnmerge({ mergeId: entry.id }); setChecks((current) => ({ ...current, [entry.id]: !checked.ok ? { kind: "error", text: checked.error.message } : checked.value.allowed ? { kind: "allowed" } : { kind: "blocked", text: `不可撤销：${checked.value.blockingEntityIds.join("、")}（${checked.value.reasons.map((reason) => `${reason.entityType}:${reason.entityId}`).join("；")}）` } })); }));
  };
  useEffect(() => { void load(); }, [api]);
  const reverse = async (id: string): Promise<void> => { const checked = await api.canUnmerge({ mergeId: id }); if (!checked.ok || !checked.value.allowed) { setChecks((current) => ({ ...current, [id]: !checked.ok ? { kind: "error", text: checked.error.message } : { kind: "blocked", text: `不可撤销：${checked.value.blockingEntityIds.join("、")}` } })); return; } const result = await api.unmerge({ mergeId: id }); if (!result.ok) setChecks((current) => ({ ...current, [id]: { kind: "error", text: result.error.message } })); else await load(); };
  return <section className="detail-card merge-history"><h2>合并历史</h2>{history.length === 0 && <p className="text-secondary">暂无合并记录。</p>}{history.map((entry) => { const check = checks[entry.id]; return <div className="merge-history-row" key={entry.id}><span>{entry.status === "active" ? "已合并" : "已撤销"}</span><code>{entry.primaryPersonId} ← {entry.secondaryPersonId}</code>{entry.status === "active" && check?.kind === "checking" && <span className="text-secondary">检查中</span>}{entry.status === "active" && check?.kind === "allowed" && <><span>可撤销</span><button className="button secondary-button" onClick={() => void reverse(entry.id)}>撤销合并</button></>}{(check?.kind === "blocked" || check?.kind === "error") && <p className="text-secondary">{check.text}</p>}</div>; })}</section>;
}
