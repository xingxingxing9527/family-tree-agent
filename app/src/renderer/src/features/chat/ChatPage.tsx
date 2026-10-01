import React, { type JSX } from "react";
import type { ConversationAnswer } from "../../../../shared/chat";
import type { PersonListItem } from "../../../../shared/contracts";
import { useViewpoint } from "../../app/ViewpointContext";
import { ChatPanel } from "./ChatPanel";

interface ChatPageProps {
  people: PersonListItem[];
  selectedPersonId: string | null;
  onSelectedPersonChange(personId: string | null): void;
  onSend(question: string): Promise<void | ConversationAnswer>;
  onOpenPerson?(personId: string): void;
}

export function ChatPage({ people, selectedPersonId, onSelectedPersonChange, onSend, onOpenPerson }: ChatPageProps): JSX.Element {
  const { viewpointId, setViewpointId } = useViewpoint();
  return (
    <section className="feature-page chat-page" aria-labelledby="chat-page-title">
      <header className="page-heading">
        <div>
          <p className="eyebrow text-secondary">基于已确认的家谱资料</p>
          <h1 id="chat-page-title">问答</h1>
          <p className="text-secondary">先确认回答视角和问题人物，再用自然语言查询关系与资料。</p>
        </div>
      </header>
      <section className="chat-context" aria-label="问答上下文">
        <label>
          回答视角
          <select aria-label="回答视角" value={viewpointId ?? ""} onChange={(event) => setViewpointId(event.target.value || null)}>
            <option value="">未选择</option>
            {people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
          </select>
        </label>
        <label>
          问题人物
          <select aria-label="问题人物" value={selectedPersonId ?? ""} onChange={(event) => onSelectedPersonChange(event.target.value || null)}>
            <option value="">未选择</option>
            {people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
          </select>
        </label>
      </section>
      <ChatPanel onSend={onSend} onSelectCandidate={onSelectedPersonChange} onOpenPerson={onOpenPerson} />
    </section>
  );
}
