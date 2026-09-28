import { useState, type JSX } from "react";
import type { DuplicateCandidateDto, MergeApi, MergePreviewDto } from "../../../../shared/contracts";
import { DuplicateCandidates } from "./DuplicateCandidates";
import { MergePreview } from "./MergePreview";
export function MergePanel({ personId, api, onMerged }: { personId: string; api: MergeApi; onMerged(): void }): JSX.Element {
  const [candidates, setCandidates] = useState<DuplicateCandidateDto[] | null>(null); const [preview, setPreview] = useState<MergePreviewDto | null>(null); const [error, setError] = useState<string | null>(null);
  const find = async (): Promise<void> => { const result = await api.findDuplicateCandidates({ personId }); if (result.ok) setCandidates(result.value); else setError(result.error.message); };
  const open = async (candidate: DuplicateCandidateDto): Promise<void> => { const result = await api.preview({ primaryPersonId: personId, secondaryPersonId: candidate.person.id }); if (result.ok) setPreview(result.value); else setError(result.error.message); };
  if (preview) return <MergePreview preview={preview} api={api} onCancel={() => setPreview(null)} onMerged={onMerged} />;
  return <>{error && <div className="error-banner">{error}</div>}<button className="button secondary-button" onClick={() => void find}>查找疑似重复</button>{candidates && <DuplicateCandidates candidates={candidates} onPreview={(candidate) => void open(candidate)} />}</>;
}
