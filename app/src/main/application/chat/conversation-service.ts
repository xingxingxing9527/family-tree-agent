import type { ConversationAnswer, QueryToolName, ToolResult } from "../../../shared/chat.js";
import type { RelationshipResultDto } from "../../../shared/contracts.js";
import type { ModelAdapter } from "../../llm/model-adapter.js";
import { ModelProtocolError } from "../../llm/model-adapter.js";
import { QUERY_TOOL_SCHEMAS, type QueryToolRegistry } from "../query/query-tool-registry.js";

const names = ["search_people", "get_person", "list_relatives", "calculate_relationship", "summarize_lineage", "search_wiki"] as const;
const isName = (value: string): value is QueryToolName => (names as readonly string[]).includes(value);
const MAX_RESULT_CHARS = 32_000;

export class ConversationService {
  private readonly maxTurns: number;
  constructor(private readonly model: ModelAdapter, private readonly registry: QueryToolRegistry, options: { maxTurns?: number } = {}) {
    this.maxTurns = options.maxTurns ?? 4;
  }

  async ask(input: { question: string; viewpointId: string; selectedPersonId: string | null }): Promise<ConversationAnswer> {
    const toolResults: ToolResult[] = [];
    const toolTrace: ConversationAnswer["toolTrace"] = [];
    const matched = new Set<string>(); const sources = new Set<string>();
    let relationship: RelationshipResultDto | null = null;
    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      const modelTurn = await this.model.continueWithTools({ ...input, toolResults });
      if (modelTurn.toolCalls.length === 0) {
        if (modelTurn.answer === null) throw new ModelProtocolError("The model returned neither an answer nor a tool call");
        return { answer: modelTurn.answer, matchedPersonIds: [...matched], sourceIds: [...sources], relationship, toolTrace };
      }
      for (const call of modelTurn.toolCalls) {
        if (!isName(call.name)) throw new ModelProtocolError("Unknown query tool");
        const parsed = QUERY_TOOL_SCHEMAS[call.name].safeParse(call.arguments);
        if (!parsed.success) throw new ModelProtocolError("Invalid query tool arguments");
        const output = (this.registry.tools[call.name] as (args: never) => unknown)(parsed.data as never);
        if (JSON.stringify(output).length > MAX_RESULT_CHARS) throw new ModelProtocolError("Query tool result exceeds the allowed size");
        toolResults.push({ callId: call.callId, name: call.name, arguments: parsed.data, output });
        toolTrace.push({ name: call.name, arguments: parsed.data });
        this.collectEvidence(output, matched, sources);
        if (call.name === "calculate_relationship") relationship = output as RelationshipResultDto;
      }
    }
    throw new ModelProtocolError("The model exceeded the tool-loop limit");
  }

  private collectEvidence(value: unknown, people: Set<string>, sources: Set<string>): void {
    if (Array.isArray(value)) { value.forEach((entry) => this.collectEvidence(entry, people, sources)); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && ("displayName" in record || "gender" in record)) people.add(record.id);
    if (typeof record.personId === "string") people.add(record.personId);
    if (Array.isArray(record.pathPersonIds)) record.pathPersonIds.forEach((id) => typeof id === "string" && people.add(id));
    if (Array.isArray(record.sourceIds)) record.sourceIds.forEach((id) => typeof id === "string" && sources.add(id));
    if (Array.isArray(record.sources)) record.sources.forEach((source) => {
      if (source && typeof source === "object" && typeof (source as { id?: unknown }).id === "string") sources.add((source as { id: string }).id);
    });
    Object.values(record).forEach((nested) => this.collectEvidence(nested, people, sources));
  }
}
