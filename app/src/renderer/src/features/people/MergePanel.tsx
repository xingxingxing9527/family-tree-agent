import React, { useState, type JSX } from "react";
import type { DuplicateCandidateDto, MergeApi, MergePreviewDto } from "../../../../shared/contracts";
import { DuplicateCandidates } from "./DuplicateCandidates";
import { MergePreview } from "./MergePreview";
export function MergePanel({ personId, api, onMerged }: { personId: string; api: MergeApi; onMerged(): void }): JSX.Element {
  const [candidates, setCandidates] = useState<DuplicateCandidateDto[] | null>(null);
  const [preview, setPreview] = useState<MergePreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const find = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.findDuplicateCandidates({ personId });
      if (result.ok) setCandidates(result.value); else setError(result.error.message);
    } catch { setError("无法查找疑似重复人物"); }
    finally { setBusy(false); }
  };
  const open = async (candidate: DuplicateCandidateDto): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.preview({ primaryPersonId: personId, secondaryPersonId: candidate.person.id });
      if (result.ok) setPreview(result.value); else setError(result.error.message);
    } catch { setError("无法生成合并预览"); }
    finally { setBusy(false); }
  };
  if (preview) return <MergePreview preview={preview} api={api} onCancel={() => setPreview(null)} onMerged={onMerged} />;
  return <>{error && <div className="error-banner" role="alert">{error}</div>}<button className="button secondary-button" disabled={busy} onClick={() => void find()}>{busy ? "查找中…" : "查找疑似重复"}</button>{candidates && <DuplicateCandidates candidates={candidates} onPreview={(candidate) => void open(candidate)} />}</>;
}
