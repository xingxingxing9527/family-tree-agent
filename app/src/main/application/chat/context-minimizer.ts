import type { PersonCandidate } from "../../../shared/contracts.js";
import type { MinimizedConversationContext, QueryToolName, ToolResult } from "../../../shared/chat.js";

const MAX_QUESTION_CHARS = 4_000;
const MAX_TOOL_RESULT_CHARS = 32_000;
const SENSITIVE_TEXT = /(?:[a-z][a-z0-9+.-]*:\/\/\S+|(?:[a-z]:[\\/]|\\\\)[^\s,;，。]+|\/(?:[^\s/,;，。]+\/)*[^\s,;，。]+|\b(?:sk-[a-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]+)\b|\bBearer\s+\S+|\b(?:api[_ -]?key|token|secret)\s*[:=]\s*\S+|\b(?:mediaBytes|base64|data:(?:image|audio|video)\/)[^\s,;，。]*)/gi;

export const redactProviderText = (value: string): string => value.replace(SENSITIVE_TEXT, "[REDACTED]");
const cleanValue = (value: unknown): unknown => {
  if (typeof value === "string") return redactProviderText(value);
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, cleanValue(nested)]));
  return value;
};
const pick = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, cleanValue(source[key])]));
};
const date = (value: unknown): unknown => value === null ? null : pick(value, ["calendar", "year", "month", "day", "leapMonth", "precision"]);
const candidate = (value: unknown): unknown => {
  const output = pick(value, ["id", "displayName", "aliases", "gender", "birth", "parentHints"]);
  if ("birth" in output) output.birth = date(output.birth);
  if (Array.isArray(output.parentHints)) output.parentHints = output.parentHints.map((hint) => pick(hint, ["id", "displayName", "role"]));
  return output;
};
const person = (value: unknown): unknown => {
  const output = pick(value, ["id", "displayName", "aliases", "gender", "birth", "death", "notes", "sources"]);
  if ("birth" in output) output.birth = date(output.birth);
  if ("death" in output) output.death = date(output.death);
  if (Array.isArray(output.sources)) output.sources = output.sources.map((source) => pick(source, ["id", "sourceKey", "title", "kind", "citation"]));
  return output;
};
const relationship = (value: unknown): unknown => {
  const output = pick(value, ["primaryTerm", "reverseTerm", "description", "ruleVersion", "alternatives", "uncertainty", "signature"]);
  if (output.signature) output.signature = pick(output.signature, ["steps", "generationDelta", "lineageSide", "bloodAffinity", "viewpointGender", "targetGender", "relativeAgeOrder", "pathPersonIds", "pathRelationIds"]);
  if (Array.isArray(output.alternatives)) output.alternatives = output.alternatives.map(relationship);
  return output;
};

const allowlistedOutput = (name: QueryToolName, value: unknown): unknown => {
  switch (name) {
    case "search_people": return Array.isArray(value) ? value.map(candidate) : [];
    case "get_person": return person(value);
    case "list_relatives": return Array.isArray(value) ? value.map((entry) => {
      const output = pick(entry, ["relationId", "kind", "person", "parentRole", "marriageStatus"]);
      if (output.person) output.person = candidate(output.person);
      return output;
    }) : [];
    case "calculate_relationship": return relationship(value);
    case "summarize_lineage": {
      const output = pick(value, ["lineageId", "name", "generation", "memberCount", "bloodMemberCount", "generationCounts", "members"]);
      if (Array.isArray(output.members)) output.members = output.members.map((member) => {
        const clean = pick(member, ["personId", "displayName", "role", "generation"]);
        if (clean.generation) clean.generation = pick(clean.generation, ["declared", "computed", "displayed", "source", "conflict"]);
        return clean;
      });
      return output;
    }
    case "search_wiki": return Array.isArray(value) ? value.map((entry) => pick(entry, ["wikiEntryId", "title", "excerpt", "sourceIds"])) : [];
  }
};

export function selectRelevantCandidates(text: string, candidates: PersonCandidate[], knownIds: readonly string[] = []): PersonCandidate[] {
  const ids = new Set(knownIds);
  return candidates.filter((entry) => ids.has(entry.id) || text.includes(entry.id) || [entry.displayName, ...entry.aliases].some((name) => name.length > 0 && text.includes(name)));
}

export function minimizeConversationContext(input: {
  question: string;
  viewpointId: string;
  selectedPersonId: string | null;
  candidatePeople: PersonCandidate[];
  neededCandidateIds: string[];
  toolResults: ToolResult[];
}): MinimizedConversationContext {
  if (!input.question.trim() || input.question.length > MAX_QUESTION_CHARS) throw new Error("Question exceeds the allowed size");
  const selected = selectRelevantCandidates(input.question, input.candidatePeople, input.neededCandidateIds);
  const toolResults = input.toolResults.map((result) => {
    const cleaned: ToolResult = { callId: result.callId, name: result.name, arguments: cleanValue(result.arguments), output: allowlistedOutput(result.name, result.output) };
    if (JSON.stringify(cleaned).length > MAX_TOOL_RESULT_CHARS) throw new Error("Tool result exceeds the allowed size");
    return cleaned;
  });
  return {
    question: redactProviderText(input.question),
    viewpointId: redactProviderText(input.viewpointId),
    selectedPersonId: input.selectedPersonId ? redactProviderText(input.selectedPersonId) : null,
    candidatePeople: selected.map((entry) => candidate(entry) as PersonCandidate),
    toolResults
  };
}
