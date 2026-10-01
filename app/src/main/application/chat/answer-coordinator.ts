import type {
  ConversationAnswer,
  ConversationMissingFact,
  ConversationPathPerson,
  ConversationPersonReference,
  ModelContinuation,
  QueryToolName,
  ToolResult
} from "../../../shared/chat.js";
import type { PersonCandidate, PersonQueryReadModel, RelationshipResultDto } from "../../../shared/contracts.js";
import type { ModelAdapter } from "../../llm/model-adapter.js";
import { ModelProtocolError } from "../../llm/model-adapter.js";
import { QUERY_TOOL_SCHEMAS, type QueryToolRegistry } from "../query/query-tool-registry.js";

const names = ["search_people", "get_person", "list_relatives", "calculate_relationship", "summarize_lineage", "search_wiki"] as const;
const isName = (value: string): value is QueryToolName => (names as readonly string[]).includes(value);
const MAX_RESULT_CHARS = 32_000;
const MAX_CALLS_PER_RESPONSE = 4;
const MAX_TOTAL_CALLS = 8;
const MAX_CONTEXT_CHARS = 64_000;
const childrenCountQuestion = /(?:几个|多少(?:个)?|有无)(?:孩子|子女)|(?:孩子|子女)(?:有几个|有多少)/u;

interface AskInput { question: string; viewpointId: string; selectedPersonId: string | null; }

export class AnswerCoordinator {
  private readonly maxTurns: number;

  constructor(private readonly model: ModelAdapter, private readonly registry: QueryToolRegistry, options: { maxTurns?: number } = {}) {
    this.maxTurns = options.maxTurns ?? 4;
  }

  async ask(input: AskInput): Promise<ConversationAnswer> {
    const viewpoint = this.personReference(input.viewpointId);
    const mentioned = typeof this.registry.findMentionedPeople === "function" ? this.registry.findMentionedPeople(input.question) : [];
    const ambiguous = mentioned.find((group) => group.candidates.length > 1
      && (!input.selectedPersonId || !group.candidates.some((candidate) => candidate.id === input.selectedPersonId)));
    if (ambiguous) {
      return this.answer({
        status: "needs_disambiguation",
        conclusion: `找到 ${ambiguous.candidates.length} 位名为“${ambiguous.mention}”的人，请先选择具体人物。`,
        viewpoint,
        candidates: ambiguous.candidates
      });
    }
    if (childrenCountQuestion.test(input.question)) return this.answerChildrenCount(input, viewpoint, mentioned.flatMap((group) => group.candidates));
    return this.askModel(input, viewpoint);
  }

  private answerChildrenCount(input: AskInput, viewpoint: ConversationPersonReference, mentioned: PersonCandidate[]): ConversationAnswer {
    const targetId = mentioned.length === 1 ? mentioned[0]!.id : input.selectedPersonId;
    if (!targetId) {
      return this.answer({
        status: "insufficient",
        conclusion: "请先选择要查询的人物。",
        viewpoint,
        missingFacts: [{ code: "person_selection", message: "缺少明确的问题人物", personId: null }]
      });
    }
    const target = this.person(targetId);
    if (!target) {
      return this.answer({
        status: "insufficient",
        conclusion: "找不到要查询的人物，请重新选择。",
        viewpoint,
        missingFacts: [{ code: "person_selection", message: "问题人物不存在", personId: targetId }]
      });
    }
    const status = this.registry.getChildrenCountStatus(targetId);
    const children = this.registry.tools.list_relatives({ personId: targetId, kinds: ["child"] });
    const people = [target, ...children.map((entry) => this.person(entry.person.id)).filter((person): person is PersonQueryReadModel => Boolean(person))];
    const sourceIds = [...new Set(people.flatMap((person) => person.sources.map((source) => source.id)))];
    const missingFacts: ConversationMissingFact[] = status.completeness === "partial"
      ? [{ code: "children_completeness", message: "子女资料尚未由管理员确认完整", personId: targetId }]
      : [];
    if (status.count === 0 && status.completeness === "partial") {
      return this.answer({
        status: "insufficient",
        conclusion: `${target.displayName}的子女资料尚未确认完整，目前不能判断为 0 个。`,
        viewpoint,
        matchedPersonIds: [targetId],
        sourceIds,
        evidence: this.registry.resolveSources(sourceIds),
        missingFacts
      });
    }
    const suffix = status.completeness === "complete" ? "，资料已确认完整" : "，但资料可能仍待补充";
    return this.answer({
      status: "answered",
      conclusion: `${target.displayName}已记录 ${status.count} 个子女${suffix}。`,
      viewpoint,
      matchedPersonIds: people.map((person) => person.id),
      sourceIds,
      evidence: this.registry.resolveSources(sourceIds),
      missingFacts
    });
  }

  private async askModel(input: AskInput, viewpoint: ConversationPersonReference): Promise<ConversationAnswer> {
    const toolResults: ToolResult[] = [];
    const toolTrace: ConversationAnswer["toolTrace"] = [];
    const matched = new Set<string>();
    const sources = new Set<string>();
    const callIds = new Set<string>();
    let continuation: ModelContinuation | undefined;
    let relationship: RelationshipResultDto | null = null;
    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      const modelTurn = await this.model.continueWithTools({ ...input, toolResults, continuation });
      continuation = modelTurn.continuation;
      if (modelTurn.toolCalls.length === 0) {
        if (modelTurn.answer === null) throw new ModelProtocolError("The model returned neither an answer nor a tool call");
        if (toolResults.length === 0) throw new ModelProtocolError("A terminal answer requires deterministic tool evidence");
        const conclusion = modelTurn.answer.trim();
        if (!conclusion) throw new ModelProtocolError("The model returned an empty terminal answer");
        for (const sourceId of relationship ? this.registry.sourceIdsForFacts(relationship.signature.pathRelationIds) : []) sources.add(sourceId);
        if (relationship && (relationship.primaryTerm === null || relationship.uncertainty.length > 0)) {
          return this.answer({
            status: "insufficient",
            conclusion: "现有关系资料存在冲突，暂时无法给出可靠称谓。",
            viewpoint,
            matchedPersonIds: [...matched],
            sourceIds: [...sources],
            evidence: this.registry.resolveSources([...sources]),
            relationship,
            toolTrace,
            relationshipPath: this.relationshipPath(relationship),
            missingFacts: [{ code: "relationship_conflict", message: relationship.uncertainty.join("；") || "关系称谓无法确定", personId: input.selectedPersonId }]
          });
        }
        return this.answer({
          status: "answered",
          conclusion,
          viewpoint,
          matchedPersonIds: [...matched],
          sourceIds: [...sources],
          evidence: this.registry.resolveSources([...sources]),
          relationship,
          toolTrace,
          relationshipPath: relationship ? this.relationshipPath(relationship) : []
        });
      }
      if (modelTurn.answer !== null) throw new ModelProtocolError("The model returned an answer before completing tool calls");
      if (modelTurn.toolCalls.length > MAX_CALLS_PER_RESPONSE || toolResults.length + modelTurn.toolCalls.length > MAX_TOTAL_CALLS) throw new ModelProtocolError("The model exceeded the tool-call limit");
      for (const call of modelTurn.toolCalls) {
        if (!call.callId.trim() || call.callId.length > 200 || callIds.has(call.callId)) throw new ModelProtocolError("The model returned a duplicate or invalid call ID");
        callIds.add(call.callId);
        if (!isName(call.name)) throw new ModelProtocolError("Unknown query tool");
        const parsed = QUERY_TOOL_SCHEMAS[call.name].safeParse(call.arguments);
        if (!parsed.success) throw new ModelProtocolError("Invalid query tool arguments");
        const output = (this.registry.tools[call.name] as (args: never) => unknown)(parsed.data as never);
        if (JSON.stringify(output).length > MAX_RESULT_CHARS) throw new ModelProtocolError("Query tool result exceeds the allowed size");
        toolResults.push({ callId: call.callId, name: call.name, arguments: parsed.data, output });
        toolTrace.push({ name: call.name, arguments: parsed.data });
        if (JSON.stringify({ toolResults, toolTrace }).length > MAX_CONTEXT_CHARS) throw new ModelProtocolError("The tool context exceeds the allowed size");
        this.collectEvidence(output, matched, sources);
        if (call.name === "calculate_relationship") relationship = output as RelationshipResultDto;
      }
    }
    throw new ModelProtocolError("The model exceeded the tool-loop limit");
  }

  private answer(input: Pick<ConversationAnswer, "status" | "conclusion" | "viewpoint"> & Partial<Omit<ConversationAnswer, "status" | "conclusion" | "answer" | "viewpoint">>): ConversationAnswer {
    return {
      status: input.status,
      conclusion: input.conclusion,
      answer: input.conclusion,
      viewpoint: input.viewpoint,
      relationshipPath: input.relationshipPath ?? [],
      evidence: input.evidence ?? [],
      candidates: input.candidates ?? [],
      missingFacts: input.missingFacts ?? [],
      matchedPersonIds: input.matchedPersonIds ?? [],
      sourceIds: input.sourceIds ?? [],
      relationship: input.relationship ?? null,
      toolTrace: input.toolTrace ?? []
    };
  }

  private person(personId: string): PersonQueryReadModel | null {
    try { return this.registry.tools.get_person({ personId }); }
    catch { return null; }
  }

  private personReference(personId: string): ConversationPersonReference {
    const person = this.person(personId);
    return { id: personId, displayName: person?.displayName ?? personId };
  }

  private relationshipPath(relationship: RelationshipResultDto): ConversationPathPerson[] {
    return relationship.signature.pathPersonIds.map((personId) => ({ personId, displayName: this.person(personId)?.displayName ?? personId }));
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
