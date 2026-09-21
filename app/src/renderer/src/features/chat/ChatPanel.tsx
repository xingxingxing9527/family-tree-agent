import React, { type JSX } from "react";

export type QuickAction = "attribute" | "count" | "relationship" | "lineage";

export interface ChatAnswer {
  conclusion: string;
  matchedPeople: Array<{ id: string; displayName: string; hint: string }>;
  sources: Array<{ id: string; title: string }>;
  relationshipPath: string[];
}

export interface ChatPanelProps {
  answer?: ChatAnswer | null;
  onQuickAction?(action: QuickAction): void;
}

const actions: Array<{ id: QuickAction; label: string }> = [
  { id: "attribute", label: "人物属性" },
  { id: "count", label: "成员统计" },
  { id: "relationship", label: "关系查询" },
  { id: "lineage", label: "支系世代" }
];

export function ChatPanel({ answer = null, onQuickAction = () => undefined }: ChatPanelProps): JSX.Element {
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
      {answer && (
        <section aria-live="polite">
          <h3>结论</h3>
          <p>{answer.conclusion}</p>
          <h3>命中的人物</h3>
          {answer.matchedPeople.length > 0
            ? <ul>{answer.matchedPeople.map((person) => <li key={person.id}><strong>{person.displayName}</strong>{person.hint ? `（${person.hint}）` : ""}</li>)}</ul>
            : <p>没有命中人物。</p>}
          <h3>来源</h3>
          {answer.sources.length > 0
            ? <ul>{answer.sources.map((source) => <li key={source.id}>{source.title}</li>)}</ul>
            : <p>没有记录来源。</p>}
          <h3>关系路径</h3>
          <p>{answer.relationshipPath.length > 0 ? answer.relationshipPath.join(" → ") : "无需关系路径。"}</p>
        </section>
      )}
    </aside>
  );
}
