import type { ConversationMutationDraft, ModelTurn, ToolResult } from "../../shared/chat.js";
import type { PersonCandidate, RelationshipResultDto } from "../../shared/contracts.js";
import type { ModelAdapter } from "./model-adapter.js";

const emptyDraft = (): ConversationMutationDraft => ({
  candidatePeople: [], parentChildFacts: [], marriages: [], sources: [], fieldConfidence: [], unresolvedReferences: []
});

const resultFor = (results: ToolResult[], name: ToolResult["name"]): ToolResult | undefined => results.find((result) => result.name === name);

/** Non-packaged Playwright seam. It still exercises disclosure, tool validation, queries and evidence collection. */
export class DeterministicE2EAdapter implements ModelAdapter {
  async extractDraft(_input: { text: string; candidatePeople: PersonCandidate[] }): Promise<ConversationMutationDraft> {
    return emptyDraft();
  }

  async continueWithTools(input: { question: string; viewpointId: string; selectedPersonId: string | null; toolResults: ToolResult[] }): Promise<ModelTurn> {
    const subjectId = input.selectedPersonId ?? input.viewpointId;
    const relationshipQuestion = /关系|称呼|叫.*什么/.test(input.question) && input.selectedPersonId !== null;
    if (relationshipQuestion) {
      if (!resultFor(input.toolResults, "calculate_relationship")) return {
        answer: null,
        toolCalls: [{ callId: "e2e-relationship", name: "calculate_relationship", arguments: { viewpointId: input.viewpointId, targetId: subjectId } }]
      };
      if (!resultFor(input.toolResults, "get_person")) return {
        answer: null,
        toolCalls: [{ callId: "e2e-person-source", name: "get_person", arguments: { personId: subjectId } }]
      };
      const relationship = resultFor(input.toolResults, "calculate_relationship")?.output as RelationshipResultDto;
      return { answer: `${relationship.primaryTerm ?? "未找到确定称谓"}；关系路径已列出。`, toolCalls: [] };
    }

    if (!resultFor(input.toolResults, "get_person")) return {
      answer: null,
      toolCalls: [{ callId: "e2e-count-person", name: "get_person", arguments: { personId: subjectId } }]
    };
    if (!resultFor(input.toolResults, "list_relatives")) return {
      answer: null,
      toolCalls: [{ callId: "e2e-count-children", name: "list_relatives", arguments: { personId: subjectId, kinds: ["child"] } }]
    };
    const children = resultFor(input.toolResults, "list_relatives")?.output;
    const count = Array.isArray(children) ? children.length : 0;
    return { answer: `已确认的子女共有 ${count} 人。`, toolCalls: [] };
  }
}
