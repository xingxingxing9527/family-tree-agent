import React, { useState, type JSX } from "react";
import type { FamilyAgentApi, MarriageReadModel } from "../../../../shared/contracts";
import type { PartialDate } from "../../../../shared/domain";
import { PartialDateField } from "../people/PartialDateField";
import { formatPartialDate } from "../people/format-partial-date";

interface MarriageHistoryProps {
  marriages: MarriageReadModel[];
  api: FamilyAgentApi["relations"];
  onChanged(): Promise<void>;
}

export function MarriageHistory({ marriages, api, onChanged }: MarriageHistoryProps): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<PartialDate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const divorce = async (marriage: MarriageReadModel): Promise<void> => {
    if (busy) return;
    setError(null); setBusy(true);
    try {
      const result = await api.divorce({ marriageId: marriage.id, endDate, expectedVersion: marriage.rowVersion });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setEditingId(null);
      setEndDate(null);
      await onChanged();
    } catch { setError("无法登记离婚，请稍后重试。"); }
    finally { setBusy(false); }
  };

  return (
    <section className="marriage-history" aria-labelledby="marriage-history-title">
      <h3 id="marriage-history-title">婚姻历史</h3>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {marriages.length === 0 && <p className="text-secondary">暂无婚姻记录。</p>}
      {marriages.map((marriage) => (
        <article className="marriage-record" key={marriage.id}>
          <div className="section-heading-row">
            <strong>{marriage.spouse.displayName}</strong>
            <span className={`status-badge ${marriage.status}`}>{marriage.status === "active" ? "当前婚姻" : "已离婚"}</span>
          </div>
          <dl className="detail-grid compact">
            <div><dt>开始日期（原始录入）</dt><dd>{formatPartialDate(marriage.start)}</dd></div>
            <div><dt>结束日期（原始录入）</dt><dd>{formatPartialDate(marriage.end)}</dd></div>
          </dl>
          {marriage.status === "active" && editingId !== marriage.id && (
            <button className="button secondary-button" type="button" onClick={() => setEditingId(marriage.id)}>登记离婚</button>
          )}
          {editingId === marriage.id && (
            <div className="divorce-form">
              <PartialDateField label="离婚日期" value={endDate} onChange={setEndDate} />
              <div className="button-row">
                <button className="button secondary-button" type="button" onClick={() => setEditingId(null)}>取消</button>
                <button className="button primary-button" type="button" disabled={busy} onClick={() => void divorce(marriage)}>{busy ? "保存中…" : "确认离婚"}</button>
              </div>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
