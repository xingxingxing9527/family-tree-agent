import OpenAI from "openai";
import type { Response, ResponseCreateParamsNonStreaming, ResponseFunctionToolCall, Tool } from "openai/resources/responses/responses";
import { z } from "zod";
import { QUERY_TOOL_SCHEMAS } from "../application/query/query-tool-registry.js";
import { conversationMutationDraftSchema, modelAnswerSchema, type ModelContinuation, type QueryToolName, type ToolResult } from "../../shared/chat.js";
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
const MAX_CALLS_PER_RESPONSE = 4;
const MAX_CONTINUATION_ITEMS = 32;
const MAX_CONTINUATION_CHARS = 64_000;
const MAX_OUTPUT_TOKENS = 2_000;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object");

const assertCompleted = (response: Response): void => {
  if (response.status !== "completed") throw new ModelProtocolError("The model response was not completed");
  if (response.output.some((item) => item.type === "message" && Array.isArray((item as { content?: unknown[] }).content)
    && ((item as { content: Array<{ type?: string }> }).content.some((content) => content.type === "refusal")))) {
    throw new ModelProtocolError("The model refused the request");
  }
};

const boundedContinuation = (previous: ModelContinuation | undefined, output: Response["output"]): ModelContinuation | undefined => {
  if (previous && previous.provider !== "openai-responses") throw new ModelProtocolError("Unsupported model continuation");
  const prior = previous?.items ?? [];
  const current = output.filter((item) => item.type === "reasoning" || item.type === "function_call");
  const items = [...prior, ...current];
  if (items.length === 0) return undefined;
  if (items.length > MAX_CONTINUATION_ITEMS || safeJson(items).length > MAX_CONTINUATION_CHARS) throw new ModelProtocolError("Model continuation exceeds the allowed size");
  return { provider: "openai-responses", items };
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
        candidatePeople: input.candidatePeople, neededCandidateIds: [], toolResults: []
      });
      const response = await this.client.responses.create({
        model: this.model,
        store: false,
        instructions: EXTRACT_FACTS_INSTRUCTIONS,
        input: JSON.stringify({ text: minimized.question, candidatePeople: minimized.candidatePeople }),
        max_output_tokens: MAX_OUTPUT_TOKENS,
        text: { format: { type: "json_schema", name: "conversation_mutation_draft", strict: true, schema: jsonSchema(conversationMutationDraftSchema) } }
      });
      assertCompleted(response);
      return conversationMutationDraftSchema.parse(JSON.parse(response.output_text));
    } catch (error) { throw this.mapError(error); }
  }

  async continueWithTools(input: { question: string; viewpointId: string; selectedPersonId: string | null; toolResults: ToolResult[]; continuation?: ModelContinuation }) {
    try {
      const minimized = minimizeConversationContext({ ...input, candidatePeople: [], neededCandidateIds: [] });
      const responseInput: ResponseCreateParamsNonStreaming["input"] = [{
        role: "user", content: JSON.stringify({ question: minimized.question, viewpointId: minimized.viewpointId, selectedPersonId: minimized.selectedPersonId })
      }];
      if (input.continuation) {
        if (input.continuation.provider !== "openai-responses" || input.continuation.items.length > MAX_CONTINUATION_ITEMS || safeJson(input.continuation.items).length > MAX_CONTINUATION_CHARS) {
          throw new ModelProtocolError("Invalid model continuation");
        }
        for (const item of input.continuation.items) {
          if (!isRecord(item) || (item.type !== "reasoning" && item.type !== "function_call")) throw new ModelProtocolError("Invalid model continuation item");
          responseInput.push(item as never);
        }
      }
      for (const result of minimized.toolResults) {
        if (!input.continuation?.items.some((item) => isRecord(item) && item.type === "function_call" && item.call_id === result.callId)) {
          responseInput.push({ type: "function_call", call_id: result.callId, name: result.name, arguments: JSON.stringify(result.arguments) });
        }
        responseInput.push({ type: "function_call_output", call_id: result.callId, output: safeJson(result.output) });
      }
      const response = await this.client.responses.create({
        model: this.model,
        store: false,
        instructions: ANSWER_QUESTION_INSTRUCTIONS,
        input: responseInput,
        tools: strictTools,
        parallel_tool_calls: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: MAX_OUTPUT_TOKENS,
        text: { format: { type: "json_schema", name: "family_answer", strict: true, schema: jsonSchema(modelAnswerSchema) } }
      });
      assertCompleted(response);
      const continuation = boundedContinuation(input.continuation, response.output);
      const calls = response.output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call").map((call) => {
        if ("status" in call && call.status !== "completed") throw new ModelProtocolError("The model returned an incomplete tool call");
        if (!isToolName(call.name)) throw new ModelProtocolError("The model requested an unknown tool");
        if (!call.call_id || call.call_id.length > 200) throw new ModelProtocolError("The model returned an invalid call ID");
        let raw: unknown;
        try { raw = JSON.parse(call.arguments); } catch { throw new ModelProtocolError("The model returned malformed tool arguments"); }
        const normalized = call.name === "summarize_lineage" && raw && typeof raw === "object" && (raw as Record<string, unknown>).generation === null
          ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([key]) => key !== "generation")) : raw;
        const parsed = QUERY_TOOL_SCHEMAS[call.name].safeParse(normalized);
        if (!parsed.success) throw new ModelProtocolError("The model returned invalid tool arguments");
        return { callId: call.call_id, name: call.name, arguments: parsed.data };
      });
      if (calls.length > MAX_CALLS_PER_RESPONSE || new Set(calls.map((call) => call.callId)).size !== calls.length) throw new ModelProtocolError("The model returned too many or duplicate tool calls");
      if (calls.length > 0) return { answer: null, toolCalls: calls, continuation };
      if (!response.output_text) throw new ModelProtocolError("The model returned an empty terminal response");
      return { answer: modelAnswerSchema.parse(JSON.parse(response.output_text)).answer, toolCalls: [], continuation };
    } catch (error) { throw this.mapError(error); }
  }

  private mapError(error: unknown): Error {
    if (error instanceof ModelProtocolError || error instanceof z.ZodError || error instanceof SyntaxError) {
      return error instanceof ModelProtocolError ? error : new ModelProtocolError();
    }
    return new ModelUnavailableError();
  }
}
