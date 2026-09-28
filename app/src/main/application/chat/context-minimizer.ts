import type { PersonCandidate } from "../../../shared/contracts.js";
import type { MinimizedConversationContext, ToolResult } from "../../../shared/chat.js";

const BLOCKED_KEYS = new Set(["localpath", "filepath", "uri", "mediabytes", "modelkey", "apikey", "audithistory"]);
const MAX_QUESTION_CHARS = 4_000;
const MAX_TOOL_RESULT_CHARS = 32_000;
const looksLikeLocalPath = (value: string): boolean => /^(?:file:\/\/|[a-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var\/tmp)\/)/i.test(value.trim());

const sanitize = (value: unknown): unknown => {
  if (typeof value === "string" && looksLikeLocalPath(value)) return undefined;
  if (Array.isArray(value)) return value.map(sanitize).filter((entry) => entry !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !BLOCKED_KEYS.has(key.toLocaleLowerCase()))
      .map(([key, nested]) => [key, sanitize(nested)] as const)
      .filter(([, nested]) => nested !== undefined));
  }
  return value;
};

const summarizeCandidate = (person: PersonCandidate): PersonCandidate => ({
  id: person.id,
  displayName: person.displayName,
  aliases: [...person.aliases],
  gender: person.gender,
  birth: person.birth ? { ...person.birth } : null,
  parentHints: person.parentHints.map((hint) => ({ ...hint }))
});

export function minimizeConversationContext(input: {
  question: string;
  viewpointId: string;
  selectedPersonId: string | null;
  candidatePeople: PersonCandidate[];
  neededCandidateIds: string[];
  toolResults: ToolResult[];
}): MinimizedConversationContext {
  if (!input.question.trim() || input.question.length > MAX_QUESTION_CHARS) throw new Error("Question exceeds the allowed size");
  const needed = new Set(input.neededCandidateIds);
  const toolResults = input.toolResults.map((result) => {
    const cleaned = { callId: result.callId, name: result.name, arguments: sanitize(result.arguments), output: sanitize(result.output) } as ToolResult;
    if (JSON.stringify(cleaned.output).length > MAX_TOOL_RESULT_CHARS) throw new Error("Tool result exceeds the allowed size");
    return cleaned;
  });
  return {
    question: input.question,
    viewpointId: input.viewpointId,
    selectedPersonId: input.selectedPersonId,
    candidatePeople: input.candidatePeople.filter((person) => needed.has(person.id)).map(summarizeCandidate),
    toolResults
  };
}
