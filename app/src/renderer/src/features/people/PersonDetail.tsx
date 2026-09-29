import React, { type JSX } from "react";
import type { DesktopApi, PersonDetailReadModel } from "../../../../shared/contracts";
import { MarriageHistory } from "../relations/MarriageHistory";
import { formatPartialDate } from "./format-partial-date";
import { MediaGallery } from "./MediaGallery";

interface PersonDetailProps {
  detail: PersonDetailReadModel;
  relationsApi: DesktopApi["relations"];
  mediaApi: DesktopApi["media"];
  onEdit(): void;
  onChanged(): Promise<void>;
}

export function PersonDetail({ detail, relationsApi, mediaApi, onEdit, onChanged }: PersonDetailProps): JSX.Element {
  const gender = detail.person.gender === "male" ? "男" : detail.person.gender === "female" ? "女" : "未知";
  return (
    <section className="detail-card" aria-labelledby="person-detail-title">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow text-secondary">人物详情</p>
          <h2 id="person-detail-title" className="text-primary">{detail.person.displayName}</h2>
        </div>
        <button className="button secondary-button" type="button" onClick={onEdit}>编辑人物</button>
      </div>
      <dl className="detail-grid">
        <div><dt>别名</dt><dd>{detail.aliases.join("、") || "未记录"}</dd></div>
        <div><dt>性别</dt><dd>{gender}</dd></div>
        <div><dt>出生</dt><dd>{formatPartialDate(detail.person.birth)}</dd></div>
        <div><dt>去世</dt><dd>{formatPartialDate(detail.person.death)}</dd></div>
        <div className="detail-wide"><dt>备注</dt><dd>{detail.person.notes || "未记录"}</dd></div>
      </dl>
      <div className="family-summary">
        <section>
          <h3>父母</h3>
          {detail.parents.length > 0 ? (
            <ul className="relation-list" aria-label="已记录父母">
              {detail.parents.map((entry) => (
                <li key={entry.relationId} data-relation-id={entry.relationId}>
                  {entry.person.displayName}（{entry.role === "father" ? "父亲" : "母亲"}）
                </li>
              ))}
            </ul>
          ) : <p>未记录</p>}
        </section>
        <section>
          <h3>子女</h3>
          <p>{detail.children.map((entry) => entry.person.displayName).join("、") || "未记录"}</p>
        </section>
      </div>
      <MarriageHistory marriages={detail.marriages} api={relationsApi} onChanged={onChanged} />
      <MediaGallery personId={detail.person.id} media={mediaApi} />
    </section>
  );
}
