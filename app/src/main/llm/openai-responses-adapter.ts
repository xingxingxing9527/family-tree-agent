import OpenAI from "openai";
import type { Response, ResponseCreateParamsNonStreaming, ResponseFunctionToolCall, Tool } from "openai/resources/responses/responses";
import { z } from "zod";
import { QUERY_TOOL_SCHEMAS } from "../application/query/query-tool-registry.js";
import { conversationMutationDraftSchema, modelAnswerSchema, type QueryToolName, type ToolResult } from "../../shared/chat.js";
import type { PersonCandidate } from "../../shared/contracts.js";
import { ANSWER_QUESTION_INSTRUCTIONS } from "./prompts/answer-question.js";
import { EXTRACT_FACTS_INSTRUCTIONS } from "./prompts/extract-facts.js";
import { ModelProtocolError, ModelUnavailableError, type ModelAdapter } from "./model-adapter.js";
import { minimizeConversationContext } from "../application/chat/context-minimizer.js";

interface ResponsesClient { responses: { create(body: ResponseCreateParamsNonStreaming): Promise<Response> } }
const toolNames = ["search_people", "get_person", "list_relatives", "calculate_relationship", "summarize_lineage", "search_wiki"] as const;
const isToolName = (value: string): value is QueryToolName => (toolNames as readonly string[]).includes(value);
const jsonSchema = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _dialect, ...strictSchema } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return strictSchema;
};
const nullableGenerationSchema = {
  type: "object", additionalProperties: false, required: ["lineageId", "generation"],
  properties: { lineageId: { type: "string" }, generation: { anyOf: [{ type: "integer" }, { type: "null" }] } }
};
const strictTools: Tool[] = toolNames.map((name) => ({
  type: "function",
  name,
  strict: true,
  description: `Read-only family data query: ${name}`,
  parameters: name === "summarize_lineage" ? nullableGenerationSchema : jsonSchema(QUERY_TOOL_SCHEMAS[name])
}));

const safeJson = (value: unknown): string => {
  const text = JSON.stringify(value);
  if (text.length > 32_000) throw new ModelProtocolError("Tool output exceeds the online context limit");
  return text;
};

export class OpenAIResponsesAdapter implements ModelAdapter {
  private readonly client: ResponsesClient;
  private readonly model: string;
  constructor(input: { apiKey: string; model: string; client?: ResponsesClient }) {
    if (!input.apiKey.trim()) throw new Error("An API key is required");
    this.model = input.model;
    this.client = input.client ?? new OpenAI({ apiKey: input.apiKey });
  }

  async extractDraft(input: { text: string; candidatePeople: PersonCandidate[] }) {
    try {
      const minimized = minimizeConversationContext({
        question: input.text, viewpointId: "draft-extraction", selectedPersonId: null,
        candidatePeople: input.candidatePeople, neededCandidateIds: input.candidatePeople.map((person) => person.id), toolResults: []
      });
      const response = await this.client.responses.create({
        model: this.model,
        store: false,
        instructions: EXTRACT_FACTS_INSTRUCTIONS,
        input: JSON.stringify({ text: minimized.question, candidatePeople: minimized.candidatePeople }),
        text: { format: { type: "json_schema", name: "conversation_mutation_draft", strict: true, schema: jsonSchema(conversationMutationDraftSchema) } }
      });
      return conversationMutationDraftSchema.parse(JSON.parse(response.output_text));
    } catch (error) { throw this.mapError(error); }
  }

  async continueWithTools(input: { question: string; viewpointId: string; selectedPersonId: string | null; toolResults: ToolResult[] }) {
    try {
      const minimized = minimizeConversationContext({ ...input, candidatePeople: [], neededCandidateIds: [] });
      const responseInput: ResponseCreateParamsNonStreaming["input"] = [{
        role: "user", content: JSON.stringify({ question: minimized.question, viewpointId: minimized.viewpointId, selectedPersonId: minimized.selectedPersonId })
      }];
      for (const result of minimized.toolResults) {
        responseInput.push({ type: "function_call", call_id: result.callId, name: result.name, arguments: JSON.stringify(result.arguments) });
        responseInput.push({ type: "function_call_output", call_id: result.callId, output: safeJson(result.output) });
      }
      const response = await this.client.responses.create({
        model: this.model,
        store: false,
        instructions: ANSWER_QUESTION_INSTRUCTIONS,
        input: responseInput,
        tools: strictTools,
        text: { format: { type: "json_schema", name: "family_answer", strict: true, schema: jsonSchema(modelAnswerSchema) } }
      });
      const calls = response.output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call").map((call) => {
        if (!isToolName(call.name)) throw new ModelProtocolError("The model requested an unknown tool");
        let raw: unknown;
        try { raw = JSON.parse(call.arguments); } catch { throw new ModelProtocolError("The model returned malformed tool arguments"); }
        const normalized = call.name === "summarize_lineage" && raw && typeof raw === "object" && (raw as Record<string, unknown>).generation === null
          ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([key]) => key !== "generation")) : raw;
        const parsed = QUERY_TOOL_SCHEMAS[call.name].safeParse(normalized);
        if (!parsed.success) throw new ModelProtocolError("The model returned invalid tool arguments");
        return { callId: call.call_id, name: call.name, arguments: parsed.data };
      });
      if (calls.length > 0) return { answer: null, toolCalls: calls };
      if (!response.output_text) throw new ModelProtocolError("The model returned an empty terminal response");
      return { answer: modelAnswerSchema.parse(JSON.parse(response.output_text)).answer, toolCalls: [] };
    } catch (error) { throw this.mapError(error); }
  }

  private mapError(error: unknown): Error {
    if (error instanceof ModelProtocolError || error instanceof z.ZodError || error instanceof SyntaxError) {
      return error instanceof ModelProtocolError ? error : new ModelProtocolError();
    }
    return new ModelUnavailableError();
  }
}
