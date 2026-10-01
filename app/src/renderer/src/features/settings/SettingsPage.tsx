import React, { type JSX } from "react";
import type { FamilyAgentApi, PersonListItem, WorkspaceLineageReadModel } from "../../../../shared/contracts";
import type { PreparedMutationRefresh } from "../../app/WorkspaceContext";
import { LineageSettings } from "../lineages/LineageSettings";
import { DataManagementPage } from "./DataManagementPage";
import { ModelSettings } from "./ModelSettings";
import { PrivacyWarning } from "./PrivacyWarning";

export function SettingsPage({ api, people, lineages, refreshToken, prepareMutation, onChanged }: {
  api: FamilyAgentApi;
  people: PersonListItem[];
  lineages: WorkspaceLineageReadModel[];
  refreshToken?: number;
  prepareMutation?(targetWorkspaceId?: string): PreparedMutationRefresh;
  onChanged?(): void;
}): JSX.Element {
  return <section className="feature-page settings-page" aria-labelledby="settings-title">
    <header className="page-heading"><div><p className="eyebrow">可追溯与可恢复</p><h1 id="settings-title">设置与数据</h1><p>管理支系说明、在线模型、本地隐私、历史、备份与恢复。</p></div></header>
    <LineageSettings lineages={lineages} people={people} api={api.lineages} mutations={api.mutations} prepareMutation={prepareMutation} onChanged={onChanged} />
    <section className="settings-section" aria-labelledby="privacy-title"><h2 id="privacy-title">隐私边界</h2><p>完整家谱与媒体默认保存在本机。在线功能只发送完成当前请求所需的最少上下文。</p><PrivacyWarning /></section>
    <ModelSettings api={api.modelSettings} />
    <DataManagementPage api={api.dataManagement} refreshToken={refreshToken} prepareMutation={prepareMutation} />
  </section>;
}
