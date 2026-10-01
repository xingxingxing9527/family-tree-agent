import React, { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type {
  FamilyAgentApi,
  ParentCompletionCandidateDto,
  ParentCompletionScanDto,
  ParentCompletionScanItemDto
} from "../../../../shared/contracts";
import type { MutationApi, MutationIntent } from "../../../../shared/mutations";
import { MutationReviewDialog } from "../mutations/MutationReviewDialog";
import { useStagedMutation } from "../mutations/useStagedMutation";

interface ParentCompletionRepairPanelProps {
  relations: FamilyAgentApi["relations"];
  mutations?: MutationApi;
  onClose(): void;
  onCommitted?(): void | Promise<void>;
}

const roleName = (role: "father" | "mother"): string => role === "father" ? "父亲" : "母亲";
const complementaryRoleName = (role: "father" | "mother"): string => role === "father" ? "母亲" : "父亲";

const classificationName: Record<ParentCompletionScanItemDto["classification"], string> = {
  safe: "可安全补全",
  ambiguous: "存在歧义",
  "no-candidate": "无候选",
  conflict: "存在冲突"
};

function candidateText(item: ParentCompletionScanItemDto, candidate: ParentCompletionCandidateDto): JSX.Element {
  return <li key={candidate.personId}>
    <strong>候选{complementaryRoleName(item.parentRole)}：{candidate.personName}</strong>
    <span>{candidate.reason}</span>
  </li>;
}

export function ParentCompletionRepairPanel({ relations, mutations, onClose, onCommitted }: ParentCompletionRepairPanelProps): JSX.Element {
  const [scan, setScan] = useState<ParentCompletionScanDto | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const result = await relations.scanParentCompletions();
      if (!mounted.current || generation !== requestGeneration.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setScan(result.value);
      setSelected(new Set(result.value.items
        .filter(({ classification }) => classification === "safe")
        .map(({ childId }) => childId)));
    } catch {
      if (mounted.current && generation === requestGeneration.current) {
        setError("无法检查未完整父母关系，请稍后重试");
      }
    } finally {
      if (mounted.current && generation === requestGeneration.current) setLoading(false);
    }
  }, [relations]);

  const mutationCommitted = useCallback(async (): Promise<void> => {
    await load();
    await onCommitted?.();
  }, [load, onCommitted]);
  const staged = useStagedMutation(mutations, mutationCommitted);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, [load]);

  const safeItems = useMemo(
    () => scan?.items.filter(({ classification }) => classification === "safe") ?? [],
    [scan]
  );
  const selectedSafeItems = useMemo(
    () => safeItems.filter(({ childId }) => selected.has(childId)),
    [safeItems, selected]
  );

  const stageRepairs = (): void => {
    if (selectedSafeItems.length === 0 || staged.busy) return;
    const intents: MutationIntent[] = selectedSafeItems.map(({ knownParentId, childId, parentRole }) => ({
      type: "parentFamily.add",
      knownParentId,
      childId,
      parentRole,
      completionPolicy: "spouse-default",
      sourceDescription: "历史未完整父母关系批量修复"
    }));
    void staged.stage(intents);
  };

  return <div className="modal-backdrop"><section className="confirmation-dialog parent-completion-repair" role="dialog" aria-modal="true" aria-label="修复未完整父母关系">
    <div className="section-heading-row">
      <div>
        <h2>检查未完整父母关系</h2>
        <p className="text-secondary">扫描只读取现有事实。只有生成预览并确认后才会写入。</p>
      </div>
      <button className="button secondary-button" type="button" disabled={loading || staged.busy} onClick={onClose}>关闭修复面板</button>
    </div>

    {loading && <p role="status">正在检查未完整父母关系…</p>}
    {error && <div className="error-banner" role="alert">{error}</div>}
    {staged.error && <div className="error-banner" role="alert">{staged.error}</div>}

    {scan && <>
      <dl className="parent-completion-summary" aria-label="扫描统计">
        <div><dt>总计</dt><dd>总计 {scan.counts.total}</dd></div>
        <div><dt>可安全补全</dt><dd>可安全补全 {scan.counts.safe}</dd></div>
        <div><dt>歧义</dt><dd>歧义 {scan.counts.ambiguous}</dd></div>
        <div><dt>无候选</dt><dd>无候选 {scan.counts.noCandidate}</dd></div>
        <div><dt>冲突</dt><dd>冲突 {scan.counts.conflict}</dd></div>
      </dl>

      {scan.items.length === 0
        ? <section className="empty-state"><p>没有需要检查的未完整父母关系。</p></section>
        : <ol className="parent-completion-repair-list" aria-label="未完整父母关系列表">
          {scan.items.map((item) => {
            const safe = item.classification === "safe";
            return <li className={`parent-completion-repair-row parent-completion-${item.classification}`} key={item.childId}>
              <label className="parent-completion-selection">
                <input
                  type="checkbox"
                  aria-label={`选择修复 ${item.childName}`}
                  checked={safe && selected.has(item.childId)}
                  disabled={!safe || staged.busy}
                  onChange={(event) => setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(item.childId); else next.delete(item.childId);
                    return next;
                  })}
                />
                <span>{classificationName[item.classification]}</span>
              </label>
              <div className="parent-completion-details">
                <h3>{item.childName}</h3>
                <p>当前已知{roleName(item.parentRole)}：{item.knownParentName}</p>
                {item.plan.candidates.length > 0 && <ul className="parent-completion-candidates">
                  {item.plan.candidates.map((candidate) => candidateText(item, candidate))}
                </ul>}
                {item.plan.issues.map((issue) => <p className="text-secondary" key={`${issue.code}:${issue.message}`}>{issue.message}</p>)}
              </div>
            </li>;
          })}
        </ol>}

      <div className="button-row parent-completion-actions">
        <button className="button secondary-button" type="button" disabled={loading || staged.busy} onClick={() => void load()}>刷新未完整父母关系</button>
        <button className="button secondary-button" type="button" disabled={safeItems.length === 0 || staged.busy} onClick={() => setSelected(new Set(safeItems.map(({ childId }) => childId)))}>全选安全项</button>
        <button className="button primary-button" type="button" disabled={selectedSafeItems.length === 0 || staged.busy} onClick={stageRepairs}>生成修复预览</button>
      </div>
    </>}

    {staged.preview && <MutationReviewDialog
      preview={staged.preview}
      busy={staged.busy}
      onCancel={staged.cancel}
      onConfirm={(ids, warnings) => void staged.confirm(ids, warnings)}
    />}
  </section></div>;
}
