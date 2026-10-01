import React, { useMemo, useState, type FormEvent, type JSX } from "react";
import { Link } from "react-router-dom";
import type { FamilyAgentApi, PersonCandidate, PersonListItem } from "../../../../shared/contracts";
import type { ConversationDraftPreview } from "../../../../shared/chat";
import { MutationDraftPreview } from "../chat/MutationDraftPreview";
import { OnlineModelDisclosure } from "../chat/OnlineModelDisclosure";
import { ImportPage } from "./ImportPage";

type EntryMode = "manual" | "spreadsheet" | "conversation";
interface EntryCenterPageProps { workspaceId: string; api: FamilyAgentApi; people: PersonListItem[]; onChanged(): void; }

const sessionId = (): string => globalThis.crypto?.randomUUID?.() ?? `session-${Date.now().toString(36)}`;

function ConversationEntry({ api, people, onChanged }: Pick<EntryCenterPageProps, "api" | "people" | "onChanged">): JSX.Element {
  const [text, setText] = useState("");
  const [pendingDisclosure, setPendingDisclosure] = useState(false);
  const [preview, setPreview] = useState<ConversationDraftPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const candidates = useMemo<PersonCandidate[]>(() => people.slice(0, 100).map((person) => ({
    id: person.id, displayName: person.displayName, aliases: person.aliases, gender: person.gender, birth: person.birth, parentHints: []
  })), [people]);

  const requestDisclosure = (event: FormEvent): void => {
    event.preventDefault();
    if (text.trim() && !busy) setPendingDisclosure(true);
  };
  const stage = async (): Promise<void> => {
    const payload = { text: text.trim(), candidatePeople: candidates };
    const currentSession = sessionId();
    setBusy(true); setError(null); setMessage(null);
    try {
      const authorized = await api.chat.authorize({ sessionId: currentSession, operation: "extract", payload });
      if (!authorized.ok) { setError(authorized.error.code === "MODEL_UNAVAILABLE" ? "在线模型当前不可用，表单和表格录入仍可使用。" : authorized.error.message); return; }
      const staged = await api.chat.stageMutation({ sessionId: currentSession, authorizationToken: authorized.value.authorizationToken, payload });
      if (!staged.ok) { setError(staged.error.code === "MODEL_UNAVAILABLE" ? "在线模型当前不可用，表单和表格录入仍可使用。" : staged.error.message); return; }
      setPreview(staged.value);
    } catch {
      setError("在线录入暂时不可用，请稍后重试。");
    } finally {
      setBusy(false);
      setPendingDisclosure(false);
    }
  };
  const confirm = async (selectedChangeIds: string[], acknowledgement: { draftVersion: number; acknowledgedWarningCodes: string[] }): Promise<void> => {
    if (!preview || busy) return;
    const expectedVersions = Object.fromEntries(preview.changes
      .filter((change) => change.kind === "update" && selectedChangeIds.includes(change.id))
      .flatMap((change) => {
        const person = people.find((candidate) => candidate.id === change.entityId);
        return person ? [[person.id, person.rowVersion] as const] : [];
      }));
    setBusy(true); setError(null);
    try {
      const result = await api.chat.confirm({
        draftId: preview.id,
        draftVersion: acknowledgement.draftVersion,
        selectedChangeIds,
        expectedVersions,
        acknowledgedWarningCodes: acknowledgement.acknowledgedWarningCodes
      });
      if (!result.ok) { setError(result.error.message); return; }
      setMessage(`已确认写入 ${result.value.changedEntityIds.length} 项变更`);
      setPreview(null); setText(""); onChanged();
    } catch {
      setError("无法确认本次变更，请稍后重试。");
    } finally { setBusy(false); }
  };
  return <section className="content-card" aria-labelledby="conversation-entry-title">
    <h2 id="conversation-entry-title">对话录入</h2>
    <p>模型只生成候选草稿；你选择并确认的变更才会写入。</p>
    <form onSubmit={requestDisclosure}><label>家族资料描述<textarea className="field-control" aria-label="家族资料描述" value={text} onChange={(event) => setText(event.target.value)} /></label><button className="button primary-button" type="submit" disabled={busy || !text.trim()}>生成变更草稿</button></form>
    {pendingDisclosure && <OnlineModelDisclosure busy={busy} onCancel={() => setPendingDisclosure(false)} onConfirm={() => void stage()} />}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {message && <p className="success-message" role="status">{message}</p>}
    {preview && <MutationDraftPreview preview={preview} onConfirm={(ids, acknowledgement) => void confirm(ids, acknowledgement)} />}
  </section>;
}

export function EntryCenterPage({ workspaceId, api, people, onChanged }: EntryCenterPageProps): JSX.Element {
  const [mode, setMode] = useState<EntryMode>("manual");
  return <section className="feature-page entry-center" aria-labelledby="entry-center-title">
    <header className="page-heading"><div><p className="eyebrow">可靠录入</p><h1 id="entry-center-title">录入中心</h1><p>选择表单、表格或受控对话；所有事实写入都经过校验。</p></div></header>
    <nav className="segmented-nav" aria-label="录入方式">
      <button className="button secondary-button" aria-pressed={mode === "manual"} type="button" onClick={() => setMode("manual")}>表单录入</button>
      <button className="button secondary-button" aria-pressed={mode === "spreadsheet"} type="button" onClick={() => setMode("spreadsheet")}>表格导入</button>
      <button className="button secondary-button" aria-pressed={mode === "conversation"} type="button" onClick={() => setMode("conversation")}>对话录入</button>
    </nav>
    {mode === "manual" && <section className="content-card"><h2>表单录入</h2><p>在人物库新增人物、修正资料，并建立亲子、婚姻与离婚事实。</p><Link className="button-link" to={`/workspace/${workspaceId}/people`}>前往人物库</Link></section>}
    {mode === "spreadsheet" && <ImportPage api={api.imports} onCommitted={onChanged} />}
    {mode === "conversation" && <ConversationEntry api={api} people={people} onChanged={onChanged} />}
  </section>;
}
