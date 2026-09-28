import { useEffect, useState, type JSX } from "react";
import type { MergeApi, MergeHistoryDto } from "../../../../shared/contracts";
export function MergeHistory({ api }: { api: MergeApi }): JSX.Element {
  const [history, setHistory] = useState<MergeHistoryDto[]>([]); const [status, setStatus] = useState<Record<string, string>>({});
  const load = async (): Promise<void> => { const result = await api.history(); if (result.ok) setHistory(result.value); };
  useEffect(() => { void load(); }, [api]);
  const reverse = async (id: string): Promise<void> => { const check = await api.canUnmerge({ mergeId: id }); if (!check.ok) { setStatus({ ...status, [id]: check.error.message }); return; } if (!check.value.allowed) { setStatus({ ...status, [id]: `不可撤销：${check.value.blockingEntityIds.join("、")}` }); return; } const result = await api.unmerge({ mergeId: id }); setStatus({ ...status, [id]: result.ok ? "已撤销" : result.error.message }); if (result.ok) await load(); };
  return <section className="detail-card merge-history"><h2>合并历史</h2>{history.length === 0 && <p className="text-secondary">暂无合并记录。</p>}{history.map((entry) => <div className="merge-history-row" key={entry.id}><span>{entry.status === "active" ? "已合并" : "已撤销"}</span><code>{entry.primaryPersonId} ← {entry.secondaryPersonId}</code>{entry.status === "active" && <button className="button secondary-button" onClick={() => void reverse(entry.id)}>检查并撤销</button>}{status[entry.id] && <p className="text-secondary">{status[entry.id]}</p>}</div>)}</section>;
}
