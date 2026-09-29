import React, { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import type { QueryApi, WikiApi, WikiEntryReadModel, WikiSearchHit } from "../../../../shared/contracts";
import { WikiEditor, type WikiLinkOption } from "./WikiEditor";

interface WikiPageProps {
  api: WikiApi;
  query: Pick<QueryApi, "searchWiki">;
  people: WikiLinkOption[];
  sources: WikiLinkOption[];
}

export function WikiPage({ api, query, people, sources }: WikiPageProps): JSX.Element {
  const [entries, setEntries] = useState<WikiEntryReadModel[]>([]);
  const [hits, setHits] = useState<WikiSearchHit[] | null>(null);
  const [selected, setSelected] = useState<WikiEntryReadModel | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const activeRequest = ++requestId.current;
    setLoading(true);
    try {
      const result = await api.list({ limit: 100, offset: 0 });
      if (activeRequest !== requestId.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setEntries(result.value);
      setError(null);
    } catch {
      if (activeRequest === requestId.current) setError("无法读取 Wiki 词条");
    } finally {
      if (activeRequest === requestId.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); return () => { requestId.current += 1; }; }, [load]);

  const runSearch = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const term = search.trim();
    if (!term) { setHits(null); await load(); return; }
    const activeRequest = ++requestId.current;
    setLoading(true); setError(null);
    try {
      const result = await query.searchWiki({ query: term, limit: 50 });
      if (activeRequest !== requestId.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setHits(result.value);
    } catch {
      if (activeRequest === requestId.current) setError("无法搜索 Wiki 词条");
    } finally {
      if (activeRequest === requestId.current) setLoading(false);
    }
  };
  const open = async (wikiEntryId: string): Promise<void> => {
    const activeRequest = ++requestId.current;
    setLoading(true); setError(null);
    try {
      const result = await api.get({ wikiEntryId });
      if (activeRequest !== requestId.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setSelected(result.value);
    } catch {
      if (activeRequest === requestId.current) setError("无法打开 Wiki 词条");
    } finally {
      if (activeRequest === requestId.current) setLoading(false);
    }
  };
  const saved = (entry: WikiEntryReadModel): void => {
    setSelected(entry);
    setEntries((current) => [...current.filter((candidate) => candidate.id !== entry.id), entry].sort((left, right) => left.title.localeCompare(right.title)));
  };
  const deleted = (wikiEntryId: string): void => {
    setSelected(null);
    setEntries((current) => current.filter((entry) => entry.id !== wikiEntryId));
    setHits((current) => current?.filter((hit) => hit.wikiEntryId !== wikiEntryId) ?? null);
  };
  const listed = hits ?? entries.map((entry) => ({ wikiEntryId: entry.id, title: entry.title, excerpt: entry.body.slice(0, 160), sourceIds: entry.sourceIds }));

  return <section className="feature-page wiki-page" aria-labelledby="wiki-title">
    <header className="page-heading"><div><p className="eyebrow">叙事资料</p><h1 id="wiki-title">家族 Wiki</h1><p>记录人物生平、家族故事与来源；自由文本不会自动成为家谱事实。</p></div></header>
    <form className="search-bar" role="search" onSubmit={(event) => void runSearch(event)}>
      <label className="sr-only" htmlFor="wiki-search">搜索家族 Wiki</label>
      <input id="wiki-search" className="field-control" aria-label="搜索家族 Wiki" value={search} onChange={(event) => setSearch(event.target.value)} />
      <button className="button secondary-button" type="submit">搜索</button>
      <button className="button secondary-button" type="button" onClick={() => { setSelected(null); setHits(null); }}>新建词条</button>
    </form>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {loading && <p role="status">正在加载词条…</p>}
    <div className="wiki-layout">
      <aside className="content-card" aria-label="Wiki 词条列表">
        <h2>{hits ? "搜索结果" : "全部词条"}</h2>
        {!loading && listed.length === 0 && <p className="empty-copy">还没有匹配的词条</p>}
        {listed.map((entry) => <button className="list-row" type="button" aria-label={`打开词条：${entry.title}`} key={entry.wikiEntryId} onClick={() => void open(entry.wikiEntryId)}><strong>{entry.title}</strong><span>{entry.excerpt || "无正文"}</span></button>)}
      </aside>
      <WikiEditor api={api} people={people} sources={sources} entry={selected} onSaved={saved} onDeleted={deleted} />
    </div>
  </section>;
}
