import React, { useState, type FormEvent, type JSX } from "react";
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
  onSend?(question: string): Promise<void>;
}

const actions: Array<{ id: QuickAction; label: string }> = [
  { id: "attribute", label: "人物属性" },
  { id: "count", label: "成员统计" },
  { id: "relationship", label: "关系查询" },
  { id: "lineage", label: "支系世代" }
];

const isConversationAnswer = (answer: ChatAnswer | ConversationAnswer): answer is ConversationAnswer => "answer" in answer;

export function ChatPanel({ answer = null, onQuickAction = () => undefined, onSend = async () => undefined }: ChatPanelProps): JSX.Element {
  const [question, setQuestion] = useState(""); const [pending, setPending] = useState<string | null>(null); const [sending, setSending] = useState(false);
  const submit = (event: FormEvent): void => { event.preventDefault(); if (question.trim()) setPending(question.trim()); };
  const send = async (): Promise<void> => { if (!pending) return; setSending(true); try { await onSend(pending); setPending(null); } finally { setSending(false); } };
  const conclusion = answer ? (isConversationAnswer(answer) ? answer.answer : answer.conclusion) : null;
  const sourceIds = answer && isConversationAnswer(answer) ? answer.sourceIds : [];
  const pathIds = answer && isConversationAnswer(answer) ? answer.relationship?.signature.pathPersonIds ?? [] : [];
  return (
    <aside className="chat-panel" aria-label="家谱问答">
      <header>
        <h2>家谱问答</h2>
        <p>选择结构化问题；查询只读取已确认的家谱事实。</p>
      </header>
      <nav aria-label="快捷问题">
        {actions.map((action) => (
          <button type="button" key={action.id} onClick={() => onQuickAction(action.id)}>{action.label}</button>
        ))}
      </nav>
      <form onSubmit={submit}><label>问题<input aria-label="对话问题" value={question} onChange={(event) => setQuestion(event.target.value)} /></label><button type="submit">发送</button></form>
      {pending && <OnlineModelDisclosure busy={sending} onCancel={() => setPending(null)} onConfirm={() => void send()} />}
      {answer && (
        <section aria-live="polite">
          <h3>结论</h3>
          <p>{conclusion}</p>
          {!isConversationAnswer(answer) && <><h3>命中的人物</h3>{answer.matchedPeople.length > 0
            ? <ul>{answer.matchedPeople.map((person) => <li key={person.id}><strong>{person.displayName}</strong>{person.hint ? `（${person.hint}）` : ""}</li>)}</ul>
            : <p>没有命中人物。</p>}</>}
          <h3>来源</h3>
          {isConversationAnswer(answer) ? (sourceIds.length ? <ul>{sourceIds.map((id) => <li key={id}>{id}</li>)}</ul> : <p>没有记录来源。</p>)
            : (answer.sources.length > 0 ? <ul>{answer.sources.map((source) => <li key={source.id}>{source.title}</li>)}</ul> : <p>没有记录来源。</p>)}
          <h3>关系路径</h3>
          <p>{isConversationAnswer(answer) ? (pathIds.length ? pathIds.join(" → ") : "无需关系路径。") : (answer.relationshipPath.length > 0 ? answer.relationshipPath.join(" → ") : "无需关系路径。")}</p>
        </section>
      )}
    </aside>
  );
}
