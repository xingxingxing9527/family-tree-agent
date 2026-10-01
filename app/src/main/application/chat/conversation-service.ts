import type { ConversationAnswer } from "../../../shared/chat.js";
import type { ModelAdapter } from "../../llm/model-adapter.js";
import type { QueryToolRegistry } from "../query/query-tool-registry.js";
import { AnswerCoordinator } from "./answer-coordinator.js";

export class ConversationService {
  private readonly coordinator: AnswerCoordinator;

  constructor(model: ModelAdapter, registry: QueryToolRegistry, options: { maxTurns?: number } = {}) {
    this.coordinator = new AnswerCoordinator(model, registry, options);
  }

  ask(input: { question: string; viewpointId: string; selectedPersonId: string | null }): Promise<ConversationAnswer> {
    return this.coordinator.ask(input);
  }
}
