import React, { useRef, useState, type FormEvent, type JSX } from "react";
import type { ConversationAnswer } from "../../../../shared/chat";
import { OnlineModelDisclosure } from "./OnlineModelDisclosure";

export type QuickAction = "attribute" | "count" | "relationship" | "lineage";

export interface ChatAnswer {
  conclusion: string;
  matchedPeople: Array<{ id: string; displayName: string; hint: string }>;
  sources: Array<{ id: string; title: string }>;
  relationshipPath: string[];
}

export interface ChatPanelProps {
  answer?: ChatAnswer | ConversationAnswer | null;
  onQuickAction?(action: QuickAction): void;
  onSend?(question: string): Promise<void | ConversationAnswer>;
  onSelectCandidate?(personId: string): void;
  onOpenPerson?(personId: string): void;
}

const actions: Array<{ id: QuickAction; label: string }> = [
  { id: "attribute", label: "人物属性" },
  { id: "count", label: "成员统计" },
  { id: "relationship", label: "关系查询" },
  { id: "lineage", label: "支系世代" }
];
const quickQuestions: Record<QuickAction, string> = {
  attribute: "请说明当前选中人物的基本资料。",
  count: "当前视角人物有几个孩子？",
  relationship: "当前视角人物和选中人物是什么关系？",
  lineage: "请说明当前视角人物所属支系和世代。"
};

const isConversationAnswer = (answer: ChatAnswer | ConversationAnswer): answer is ConversationAnswer => "answer" in answer;

const genderLabel = (gender: "male" | "female" | "unknown"): string => gender === "male" ? "男" : gender === "female" ? "女" : "性别未知";

export function ChatPanel({ answer = null, onQuickAction = () => undefined, onSend = async () => undefined, onSelectCandidate = () => undefined, onOpenPerson = () => undefined }: ChatPanelProps): JSX.Element {
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [latestAnswer, setLatestAnswer] = useState<ConversationAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!sending && question.trim()) setPending(question.trim());
  };
  const send = async (): Promise<void> => {
    if (!pending || sending) return;
    const activeRequest = ++requestId.current;
    const sentQuestion = pending;
    setSending(true);
    setError(null);
    try {
      const result = await onSend(sentQuestion);
      if (activeRequest !== requestId.current) return;
      if (result) setLatestAnswer(result);
      setPending(null);
      setQuestion("");
    } catch (caught) {
      if (activeRequest === requestId.current) setError(caught instanceof Error && caught.message ? caught.message.slice(0, 300) : "无法完成在线问答");
    } finally {
      if (activeRequest === requestId.current) setSending(false);
    }
  };
  const displayedAnswer = answer ?? latestAnswer;
  const conclusion = displayedAnswer ? (isConversationAnswer(displayedAnswer) ? displayedAnswer.conclusion ?? displayedAnswer.answer : displayedAnswer.conclusion) : null;
  const structured = displayedAnswer && isConversationAnswer(displayedAnswer) ? displayedAnswer : null;
  const legacy = displayedAnswer && !isConversationAnswer(displayedAnswer) ? displayedAnswer : null;
  return (
    <section className="chat-panel" aria-label="家谱问答">
      <header>
        <h2>家谱问答</h2>
        <p>选择结构化问题；查询只读取已确认的家谱事实。</p>
      </header>
      <nav aria-label="快捷问题">
        {actions.map((action) => (
          <button type="button" key={action.id} disabled={sending} onClick={() => { setQuestion(quickQuestions[action.id]); onQuickAction(action.id); }}>{action.label}</button>
        ))}
      </nav>
      <form onSubmit={submit}><label>问题<input aria-label="对话问题" disabled={sending} value={question} onChange={(event) => setQuestion(event.target.value)} /></label><button type="submit" disabled={sending || !question.trim()}>发送</button></form>
      {pending && <OnlineModelDisclosure busy={sending} onCancel={() => setPending(null)} onConfirm={() => void send()} />}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {displayedAnswer && (
        <section className={`chat-answer ${structured?.status ?? "answered"}`} aria-live="polite">
          <div className="answer-heading"><h3>结论</h3>{structured && <span className="answer-status">{structured.status === "needs_disambiguation" ? "需要确认人物" : structured.status === "insufficient" ? "资料不足" : "已核对"}</span>}</div>
          <p>{conclusion}</p>
          {structured?.viewpoint && <p className="answer-viewpoint">回答视角：{structured.viewpoint.displayName}</p>}
          {(structured?.candidates ?? []).length ? <section className="candidate-section"><h3>需要确认人物</h3><div className="candidate-grid">{structured!.candidates.map((candidate) => {
            const parent = candidate.parentHints[0];
            const detail = [genderLabel(candidate.gender), candidate.birth ? `${candidate.birth.year} 年` : null, parent ? `${parent.role === "father" ? "父亲" : "母亲"}：${parent.displayName}` : null].filter(Boolean).join(" · ");
            return <article className="candidate-card" key={candidate.id}><strong>{candidate.displayName}</strong><span>{detail}</span><button type="button" onClick={() => onSelectCandidate(candidate.id)}>选择{candidate.displayName}（{detail}）</button></article>;
          })}</div></section> : null}
          {(structured?.missingFacts ?? []).length ? <section className="missing-facts"><h3>需要补充</h3><ul>{structured!.missingFacts.map((fact, index) => <li key={`${fact.code}:${fact.personId ?? "none"}:${index}`}><span>{fact.message}</span>{fact.personId && <button type="button" onClick={() => onOpenPerson(fact.personId!)}>前往补录</button>}</li>)}</ul></section> : null}
          {!isConversationAnswer(displayedAnswer) && <><h3>命中的人物</h3>{displayedAnswer.matchedPeople.length > 0
            ? <ul>{displayedAnswer.matchedPeople.map((person) => <li key={person.id}><strong>{person.displayName}</strong>{person.hint ? `（${person.hint}）` : ""}</li>)}</ul>
            : <p>没有命中人物。</p>}</>}
          <h3>来源</h3>
          {structured ? ((structured.evidence ?? []).length ? <ul>{structured.evidence.map((entry) => <li key={entry.id}>{entry.title}</li>)}</ul> : <p>没有记录来源。</p>)
            : (legacy && legacy.sources.length > 0 ? <ul>{legacy.sources.map((source) => <li key={source.id}>{source.title}</li>)}</ul> : <p>没有记录来源。</p>)}
          <h3>关系路径</h3>
          <p>{structured ? ((structured.relationshipPath ?? []).length ? structured.relationshipPath.map((entry) => entry.displayName).join(" → ") : "无需关系路径。") : (displayedAnswer.relationshipPath.length > 0 ? displayedAnswer.relationshipPath.join(" → ") : "无需关系路径。")}</p>
        </section>
      )}
    </section>
  );
}
