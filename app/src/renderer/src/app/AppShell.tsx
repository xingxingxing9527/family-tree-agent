import React, { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import type { ConversationAnswer } from "../../../shared/chat";
import type { PersonSearchCandidate, WorkspaceSnapshotDto, WorkspaceSummary } from "../../../shared/contracts";
import { ChatPage } from "../features/chat/ChatPage";
import { EntryCenterPage } from "../features/import/EntryCenterPage";
import { PeoplePage } from "../features/people/PeoplePage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { FamilyTreePage } from "../features/tree/FamilyTreePage";
import { WikiPage } from "../features/wiki/WikiPage";
import { ViewpointProvider, useViewpoint } from "./ViewpointContext";
import { useApi } from "./ApiContext";
import { useWorkspace, type MutationRefreshOutcome, type PreparedMutationRefresh } from "./WorkspaceContext";
import "./app-shell.css";

type Area = "tree" | "people" | "entry" | "chat" | "wiki" | "settings";
const primaryAreas: Array<{ id: Area; label: string }> = [
  { id: "tree", label: "家谱树" }, { id: "people", label: "人物" }, { id: "entry", label: "录入" }, { id: "chat", label: "问答" }
];
const secondaryAreas: Array<{ id: Area; label: string }> = [
  { id: "wiki", label: "家族 Wiki" }, { id: "settings", label: "设置与数据" }
];
const areas = [...primaryAreas, ...secondaryAreas];
const conversationSessionId = (): string => globalThis.crypto?.randomUUID?.() ?? `chat-${Date.now().toString(36)}`;

function searchIdentityHint(person: PersonSearchCandidate): string {
  const father = person.parentHints.find(({ role }) => role === "father");
  const mother = person.parentHints.find(({ role }) => role === "mother");
  const parents = [father ? `父：${father.displayName}` : null, mother ? `母：${mother.displayName}` : null]
    .filter((value): value is string => Boolean(value));
  if (parents.length > 0) return parents.join(" · ");
  const fallback = [
    "父母信息未录入",
    person.birth ? `${person.birth.year} 年生` : null,
    person.gender === "male" ? "男" : person.gender === "female" ? "女" : null
  ].filter((value): value is string => Boolean(value));
  return fallback.join(" · ");
}

function WorkspaceBody({ workspace, snapshot, refreshSnapshot }: { workspace: WorkspaceSummary; snapshot: WorkspaceSnapshotDto; refreshSnapshot(): void }): JSX.Element {
  const api = useApi();
  const { viewpointId, setViewpointId } = useViewpoint();
  const location = useLocation();
  const navigate = useNavigate();
  const workspaceState = useWorkspace();
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<PersonSearchCandidate[] | null>(null);
  const searchId = useRef(0);
  const segment = location.pathname.split("/").filter(Boolean).at(-1) as Area | undefined;
  const activeArea = areas.some((entry) => entry.id === segment) ? segment : null;
  const personIds = useMemo(() => new Set(snapshot.people.map((person) => person.id)), [snapshot.people]);

  useEffect(() => {
    setSelectedPersonId((current) => current && personIds.has(current) ? current : null);
  }, [personIds]);

  const runSearch = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const query = search.trim();
    if (!query) { setSearchResults(null); return; }
    const activeRequest = ++searchId.current;
    setSearching(true);
    try {
      const result = await api.query.searchPeople({ query, limit: 20 });
      if (activeRequest !== searchId.current) return;
      if (result.ok) setSearchResults(result.value);
      else workspaceState.reportError(result.error.message);
    } catch { if (activeRequest === searchId.current) workspaceState.reportError("无法搜索当前谱册"); }
    finally { if (activeRequest === searchId.current) setSearching(false); }
  };

  const ask = async (question: string): Promise<ConversationAnswer> => {
    if (!viewpointId || !personIds.has(viewpointId)) throw new Error("请先选择当前视角人物");
    const sessionId = conversationSessionId();
    const payload = { question, viewpointId, selectedPersonId: selectedPersonId && personIds.has(selectedPersonId) ? selectedPersonId : null };
    const authorized = await api.chat.authorize({ sessionId, operation: "ask", payload });
    if (!authorized.ok) throw new Error(authorized.error.code === "MODEL_UNAVAILABLE" ? "在线模型当前不可用，结构化浏览仍可使用。" : "无法授权本次在线问答");
    const answer = await api.chat.ask({ sessionId, authorizationToken: authorized.value.authorizationToken, payload });
    if (!answer.ok) throw new Error(answer.error.code === "MODEL_UNAVAILABLE" ? "在线模型当前不可用，结构化浏览仍可使用。" : "无法完成本次在线问答");
    return answer.value;
  };

  const prepareMutation = useCallback((targetWorkspaceId?: string): PreparedMutationRefresh => {
    const target = targetWorkspaceId ?? workspace.id;
    const prepared = workspaceState.prepareMutation(workspace.id, target);
    const finish = async (refresh: () => Promise<MutationRefreshOutcome>): Promise<MutationRefreshOutcome> => {
      let outcome: MutationRefreshOutcome;
      try { outcome = await refresh(); }
      catch { outcome = { status: "refresh-failed" }; }
      if (outcome.status === "refreshed" && target !== workspace.id) {
        navigate(`/workspace/${outcome.workspace.id}/settings`, { replace: true });
      }
      return outcome;
    };
    return {
      complete: () => finish(prepared.complete),
      retry: () => finish(prepared.retry)
    };
  }, [navigate, workspace.id, workspaceState]);

  if (!activeArea) return <Navigate to={`/workspace/${workspace.id}/tree`} replace />;
  return <div className="app-shell">
    <header className="top-bar">
      <Link className="brand" to="/">家谱智能体</Link>
      <div className="workspace-identity"><span>当前谱册</span><strong>{workspace.name}</strong></div>
      <form className="global-search" role="search" onSubmit={(event) => void runSearch(event)}><label className="sr-only" htmlFor="people-global-search">搜索人物</label><input id="people-global-search" aria-label="搜索当前谱册人物" placeholder="搜索人物、别名…" value={search} onChange={(event) => setSearch(event.target.value)} /><button type="submit" disabled={searching || !search.trim()}>{searching ? "搜索中" : "搜索"}</button></form>
      <label className="viewpoint-control">当前视角<select aria-label="共享当前视角" value={viewpointId ?? ""} onChange={(event) => setViewpointId(event.target.value || null)}><option value="">未选择</option>{snapshot.people.map((person) => <option value={person.id} key={person.id}>{person.displayName}</option>)}</select></label>
    </header>
    {searchResults && <section className="search-results" aria-label="人物搜索结果"><div className="section-heading-row"><strong>人物搜索结果</strong><button type="button" onClick={() => setSearchResults(null)}>关闭</button></div>{searchResults.length === 0 ? <p>没有匹配人物。</p> : <ul>{searchResults.map((person) => <li key={person.id}><button type="button" aria-label={`查看${person.displayName}（${person.personCode}）`} onClick={() => { setSelectedPersonId(person.id); setSearchResults(null); navigate(`/workspace/${workspace.id}/people`); }}><span className="search-person-heading"><strong>{person.displayName}</strong><small>{person.personCode}</small></span><span className="search-person-family">{searchIdentityHint(person)}</span>{person.aliases.length > 0 && <span className="search-person-aliases">别名：{person.aliases.join("、")}</span>}</button></li>)}</ul>}</section>}
    <div className="shell-grid">
      <aside className="shell-nav">
        <nav className="primary-nav" aria-label="一级导航">{primaryAreas.map((entry) => <Link className={entry.id === activeArea ? "active" : ""} aria-current={entry.id === activeArea ? "page" : undefined} key={entry.id} to={`/workspace/${workspace.id}/${entry.id}`}>{entry.label}</Link>)}</nav>
        <nav className="secondary-nav" aria-label="次级导航">{secondaryAreas.map((entry) => <Link className={entry.id === activeArea ? "active" : ""} aria-current={entry.id === activeArea ? "page" : undefined} key={entry.id} to={`/workspace/${workspace.id}/${entry.id}`}>{entry.label}</Link>)}</nav>
      </aside>
      <main className="workspace-content" key={`${workspace.id}:${activeArea}:${activeArea === "settings" ? "persistent" : workspaceState.mutationEpoch}`}>
        {activeArea === "tree" && <FamilyTreePage api={api} people={snapshot.people} lineages={snapshot.lineages} onDataChanged={refreshSnapshot} onOpenLineageSettings={() => navigate(`/workspace/${workspace.id}/settings`)} onAskAbout={(personId) => { setSelectedPersonId(personId); navigate(`/workspace/${workspace.id}/chat`); }} />}
        {activeArea === "people" && <PeoplePage workspace={workspace} api={api} initialSelectedPersonId={selectedPersonId} onDataChanged={refreshSnapshot} prepareMutation={prepareMutation} onSelectedPersonChange={setSelectedPersonId} onUseAsViewpoint={setViewpointId} onAskAbout={(personId) => { setSelectedPersonId(personId); navigate(`/workspace/${workspace.id}/chat`); }} />}
        {activeArea === "entry" && <EntryCenterPage workspaceId={workspace.id} api={api} people={snapshot.people} onChanged={refreshSnapshot} />}
        {activeArea === "chat" && <ChatPage people={snapshot.people} selectedPersonId={selectedPersonId} onSelectedPersonChange={setSelectedPersonId} onSend={ask} onOpenPerson={(personId) => { setSelectedPersonId(personId); navigate(`/workspace/${workspace.id}/people`); }} />}
        {activeArea === "wiki" && <WikiPage api={api.wiki} query={api.query} people={snapshot.people.map((person) => ({ id: person.id, displayName: person.displayName }))} sources={snapshot.sources.map((source) => ({ id: source.id, title: source.title }))} />}
        {activeArea === "settings" && <SettingsPage api={api} people={snapshot.people} lineages={snapshot.lineages} refreshToken={workspaceState.mutationEpoch} prepareMutation={prepareMutation} onChanged={refreshSnapshot} />}
      </main>
    </div>
  </div>;
}

export function AppShell({ workspace }: { workspace: WorkspaceSummary }): JSX.Element {
  const api = useApi();
  const { mutationEpoch } = useWorkspace();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestId = useRef(0);
  const refreshSnapshot = useCallback(() => setRefreshVersion((current) => current + 1), []);

  useEffect(() => {
    const activeRequest = ++requestId.current;
    setSnapshot((current) => current?.workspaceId === workspace.id ? current : null);
    setError(null);
    void api.query.workspaceSnapshot().then((result) => {
      if (activeRequest !== requestId.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      if (result.value.workspaceId !== workspace.id) { setError("谱册数据已切换，请返回首页后重试"); return; }
      setSnapshot(result.value);
    }).catch(() => { if (activeRequest === requestId.current) setError("无法读取当前谱册"); });
    return () => { requestId.current += 1; };
  }, [api, mutationEpoch, refreshVersion, workspace.id]);

  if (error) return <main className="state-page"><section className="state-card" role="alert"><h1>无法打开谱册</h1><p>{error}</p><Link className="button-link" to="/">返回首页</Link></section></main>;
  if (!snapshot) return <main className="state-page"><section className="state-card" role="status"><h1>正在打开谱册</h1><p>正在读取隔离后的谱册资料…</p></section></main>;
  const validPersonIds = snapshot.people.map((person) => person.id);
  return <ViewpointProvider workspaceId={workspace.id} visiblePersonIds={[]} validPersonIds={validPersonIds} fallbackViewpointId={workspace.originPersonId ?? validPersonIds[0] ?? null} query={api.query}>
    <WorkspaceBody workspace={workspace} snapshot={snapshot} refreshSnapshot={refreshSnapshot} />
  </ViewpointProvider>;
}
