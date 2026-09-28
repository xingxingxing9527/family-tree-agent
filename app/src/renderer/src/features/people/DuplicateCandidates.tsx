import type { DuplicateCandidateDto } from "../../../../shared/contracts";
import type { JSX } from "react";

export function DuplicateCandidates({ candidates, onPreview }: { candidates: DuplicateCandidateDto[]; onPreview(candidate: DuplicateCandidateDto): void }): JSX.Element {
  return <section className="detail-card"><h2>疑似重复</h2>{candidates.length === 0 ? <p className="text-secondary">没有足够证据的候选项。</p> : candidates.map((candidate) => <div className="merge-history-row" key={candidate.person.id}><strong>{candidate.person.displayName}</strong><span>评分 {candidate.score}：{candidate.reasons.map((reason) => reason.detail).join("；")}</span><button className="button secondary-button" onClick={() => onPreview(candidate)}>查看合并预览</button></div>)}</section>;
}
