import React, { useCallback, useEffect, useState, type JSX } from "react";
import type { ChildrenCountStatusDto, FamilyAgentApi, PersonDetailReadModel } from "../../../../shared/contracts";
import type { MutationApi } from "../../../../shared/mutations";
import { FamilyRelationsPanel, type RelativeQuickCreateRequest } from "../relations/FamilyRelationsPanel";
import { MarriageHistory } from "../relations/MarriageHistory";
import { MutationReviewDialog } from "../mutations/MutationReviewDialog";
import { useStagedMutation } from "../mutations/useStagedMutation";
import { formatPartialDate } from "./format-partial-date";
import { MediaGallery } from "./MediaGallery";

interface PersonDetailProps {
  detail: PersonDetailReadModel;
  peopleApi: FamilyAgentApi["people"];
  relationsApi: FamilyAgentApi["relations"];
  mutations?: MutationApi;
  mediaApi: FamilyAgentApi["media"];
  onEdit(): void;
  onChanged(): Promise<void>;
  onRequestQuickCreate?(request: RelativeQuickCreateRequest): void;
  onUseAsViewpoint?(personId: string): void;
  onAskAbout?(personId: string): void;
}

export function PersonDetail({ detail, peopleApi, relationsApi, mutations, mediaApi, onEdit, onChanged, onRequestQuickCreate, onUseAsViewpoint, onAskAbout }: PersonDetailProps): JSX.Element {
  const gender = detail.person.gender === "male" ? "男" : detail.person.gender === "female" ? "女" : "未知";
  const [childrenStatus, setChildrenStatus] = useState<ChildrenCountStatusDto | null>(null);
  useEffect(() => {
    if (typeof peopleApi.getChildrenCountStatus !== "function") return undefined;
    let current = true;
    void peopleApi.getChildrenCountStatus({ personId: detail.person.id }).then((result) => { if (current && result.ok) setChildrenStatus(result.value); });
    return () => { current = false; };
  }, [detail.person.id, detail.person.rowVersion, peopleApi]);
  const completenessCommitted = useCallback(async (): Promise<void> => { await onChanged(); }, [onChanged]);
  const staged = useStagedMutation(mutations, completenessCommitted);
  const changeCompleteness = (): void => {
    if (!childrenStatus || !mutations) return;
    void staged.stage([{
      type: "person.childrenCompleteness.set",
      personId: detail.person.id,
      complete: childrenStatus.completeness !== "complete",
      sourceDescription: "管理员核对",
      expectedVersion: detail.person.rowVersion
    }]);
  };
  return (
    <section className="detail-card" aria-labelledby="person-detail-title">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow text-secondary">人物详情</p>
          <h2 id="person-detail-title" className="text-primary">{detail.person.displayName}</h2>
        </div>
        <div className="button-row">
          {onUseAsViewpoint && <button className="button secondary-button" type="button" onClick={() => onUseAsViewpoint(detail.person.id)}>设为当前视角</button>}
          {onAskAbout && <button className="button secondary-button" type="button" onClick={() => onAskAbout(detail.person.id)}>询问此人</button>}
          <button className="button secondary-button" type="button" onClick={onEdit}>编辑人物</button>
        </div>
      </div>
      <dl className="detail-grid">
        <div><dt>人物编号</dt><dd>{detail.person.personCode}</dd></div>
        <div><dt>别名</dt><dd>{detail.aliases.join("、") || "未记录"}</dd></div>
        <div><dt>性别</dt><dd>{gender}</dd></div>
        <div><dt>出生</dt><dd>{formatPartialDate(detail.person.birth)}</dd></div>
        <div><dt>去世</dt><dd>{formatPartialDate(detail.person.death)}</dd></div>
        <div className="detail-wide"><dt>备注</dt><dd>{detail.person.notes || "未记录"}</dd></div>
      </dl>
      <FamilyRelationsPanel
        detail={detail}
        peopleApi={peopleApi}
        relationsApi={relationsApi}
        mutations={mutations}
        onChanged={onChanged}
        onRequestQuickCreate={onRequestQuickCreate}
      />
      {childrenStatus && <section className="children-completeness" aria-labelledby="children-completeness-title">
        <h3 id="children-completeness-title">子女资料完整度</h3>
        <p>{childrenStatus.completeness === "complete" ? "已确认完整" : "可能仍待补充"} · 已记录 {childrenStatus.count} 人</p>
        {mutations && <button type="button" className="button secondary-button" disabled={staged.busy} onClick={changeCompleteness}>{childrenStatus.completeness === "complete" ? "改为仍待补充" : "确认子女资料完整"}</button>}
      </section>}
      {staged.error && <div className="error-banner" role="alert">{staged.error}</div>}
      <MarriageHistory marriages={detail.marriages} api={relationsApi} mutations={mutations} onChanged={onChanged} />
      <MediaGallery personId={detail.person.id} media={mediaApi} />
      {staged.preview && <MutationReviewDialog preview={staged.preview} busy={staged.busy} onCancel={staged.cancel} onConfirm={(ids, warnings) => void staged.confirm(ids, warnings)} />}
    </section>
  );
}
