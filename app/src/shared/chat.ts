import { z } from "zod";
import type { PersonCandidate, RelationshipResultDto } from "./contracts.js";

const boundedId = z.string().trim().min(1).max(200);
const boundedText = z.string().max(4_000);
export const conversationPersonFieldSchema = z.enum(["displayName", "aliases", "gender", "birth", "death", "notes"]);
const partialDateSchema = z.object({
  calendar: z.enum(["solar", "lunar"]), year: z.number().int().min(1), month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31).nullable(), leapMonth: z.boolean(), precision: z.enum(["month", "day"])
}).strict();

export const conversationPersonSchema = z.object({
  referenceId: boundedId,
  statedFields: z.array(conversationPersonFieldSchema).max(6),
  displayName: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(50),
  gender: z.enum(["male", "female", "unknown"]),
  birth: partialDateSchema.nullable(),
  death: partialDateSchema.nullable(),
  notes: z.string().max(4_000).nullable(),
  matchedPersonId: boundedId.nullable()
}).strict();

export const draftSourceSchema = z.object({
  referenceId: boundedId,
  title: z.string().trim().min(1).max(500),
  kind: z.string().trim().max(100).nullable(),
  citation: z.string().max(2_000).nullable()
}).strict();

export const conversationMutationDraftSchema = z.object({
  candidatePeople: z.array(conversationPersonSchema).max(100),
  parentChildFacts: z.array(z.object({
    parentRef: boundedId, childRef: boundedId, parentRole: z.enum(["father", "mother"]),
    sourceRef: boundedId.nullable(), confidence: z.number().min(0).max(1)
  }).strict()).max(200),
  marriages: z.array(z.object({
    spouseARef: boundedId, spouseBRef: boundedId, start: partialDateSchema.nullable(),
    sourceRef: boundedId.nullable(), confidence: z.number().min(0).max(1)
  }).strict()).max(100),
  sources: z.array(draftSourceSchema).max(100),
  fieldConfidence: z.array(z.object({ path: z.string().trim().min(1).max(500), confidence: z.number().min(0).max(1) }).strict()).max(500),
  unresolvedReferences: z.array(z.object({
    reference: z.string().trim().min(1).max(500), candidatePersonIds: z.array(boundedId).max(100), reason: z.string().trim().min(1).max(1_000)
  }).strict()).max(100)
}).strict();

export type ConversationMutationDraft = z.infer<typeof conversationMutationDraftSchema>;

export const modelAnswerSchema = z.object({ answer: boundedText.trim().min(1) }).strict();
export type QueryToolName = "search_people" | "get_person" | "list_relatives" | "calculate_relationship" | "summarize_lineage" | "search_wiki";
export interface ToolResult { callId: string; name: QueryToolName; arguments: unknown; output: unknown; }
export interface ModelToolCall { callId: string; name: QueryToolName; arguments: unknown; }
export interface ModelContinuation { provider: "openai-responses"; items: unknown[]; }
export interface ModelTurn { answer: string | null; toolCalls: ModelToolCall[]; continuation?: ModelContinuation; }

export interface MinimizedConversationContext {
  question: string;
  viewpointId: string;
  selectedPersonId: string | null;
  candidatePeople: PersonCandidate[];
  toolResults: ToolResult[];
}

export interface ConversationAnswer {
  answer: string;
  matchedPersonIds: string[];
  sourceIds: string[];
  relationship: RelationshipResultDto | null;
  toolTrace: Array<{ name: QueryToolName; arguments: unknown }>;
}

export interface ConversationDraftChangeDto {
  id: string;
  kind: "create" | "update";
  entityType: "person" | "parentChild" | "marriage";
  entityId: string;
  summary: string;
  dependsOnChangeIds: string[];
  fieldChanges: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface ConversationDraftPreview {
  id: string;
  workspaceId: string;
  version: number;
  expiresAt: string;
  changes: ConversationDraftChangeDto[];
  creates: number;
  updates: number;
  warnings: Array<{ code: string; message: string }>;
  conflicts: Array<{ code: string; message: string }>;
  unresolvedReferences: ConversationMutationDraft["unresolvedReferences"];
}

export interface ConversationConfirmationReceipt {
  draftId: string;
  operationGroupId: string;
  changedEntityIds: string[];
}

const personCandidateSchema = z.object({
  id: boundedId, displayName: z.string().trim().min(1).max(200), aliases: z.array(z.string().max(200)).max(50),
  gender: z.enum(["male", "female", "unknown"]), birth: partialDateSchema.nullable(),
  parentHints: z.array(z.object({ id: boundedId, displayName: z.string().max(200), role: z.enum(["father", "mother"]) }).strict()).max(20)
}).strict();
export const extractPayloadSchema = z.object({ text: boundedText.trim().min(1), candidatePeople: z.array(personCandidateSchema).max(100) }).strict();
export const askPayloadSchema = z.object({ question: boundedText.trim().min(1), viewpointId: boundedId, selectedPersonId: boundedId.nullable() }).strict();
export const disclosureRequestSchema = z.discriminatedUnion("operation", [
  z.object({ sessionId: boundedId, operation: z.literal("extract"), payload: extractPayloadSchema }).strict(),
  z.object({ sessionId: boundedId, operation: z.literal("ask"), payload: askPayloadSchema }).strict()
]);
export const stageMutationRequestSchema = z.object({ sessionId: boundedId, authorizationToken: boundedId, payload: extractPayloadSchema }).strict();
export const askRequestSchema = z.object({ sessionId: boundedId, authorizationToken: boundedId, payload: askPayloadSchema }).strict();
export const confirmDraftRequestSchema = z.object({
  draftId: boundedId,
  draftVersion: z.number().int().min(1),
  selectedChangeIds: z.array(boundedId).max(500),
  expectedVersions: z.record(boundedId, z.number().int().min(1)),
  acknowledgedWarningCodes: z.array(z.string().trim().min(1).max(200)).max(100)
}).strict();
export const reviseDraftRequestSchema = z.object({ draftId: boundedId, replacement: conversationMutationDraftSchema }).strict();
