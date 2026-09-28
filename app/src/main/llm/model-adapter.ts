import type { PersonCandidate } from "../../shared/contracts.js";
import type { ConversationMutationDraft, ModelContinuation, ModelTurn, ToolResult } from "../../shared/chat.js";

export interface ModelAdapter {
  extractDraft(input: { text: string; candidatePeople: PersonCandidate[] }): Promise<ConversationMutationDraft>;
  continueWithTools(input: {
    question: string;
    viewpointId: string;
    selectedPersonId: string | null;
    toolResults: ToolResult[];
    continuation?: ModelContinuation;
  }): Promise<ModelTurn>;
}

export class ModelProtocolError extends Error {
  readonly code = "MODEL_PROTOCOL";
  constructor(message = "The model returned an invalid response") { super(message); this.name = "ModelProtocolError"; }
}

export class ModelUnavailableError extends Error {
  readonly code = "MODEL_UNAVAILABLE";
  constructor(message = "The online model is unavailable") { super(message); this.name = "ModelUnavailableError"; }
}
