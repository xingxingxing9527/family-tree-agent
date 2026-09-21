import type { FactQueries } from "../facts/fact-queries.js";
import { LineageService } from "../lineages/lineage-service.js";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import { LineageRepository } from "../../database/repositories/lineage-repository.js";
import type { LineageMemberSummary, LineageSummary } from "../../../shared/contracts.js";
import { QueryNotFoundError } from "./get-person.js";

export function summarizeLineage(
  database: WorkspaceDatabase,
  workspaceId: string,
  queries: FactQueries,
  input: { lineageId: string; generation?: number }
): LineageSummary {
  const repository = new LineageRepository(database, workspaceId);
  const lineage = repository.get(input.lineageId);
  if (!lineage) throw new QueryNotFoundError(`Lineage not found: ${input.lineageId}`);
  const memberships = repository.listMemberships(lineage.id);
  const generations = new LineageService(database, workspaceId).generationDisplays(lineage.id);
  const allMembers = memberships.flatMap((membership): LineageMemberSummary[] => {
    const person = queries.getPerson(membership.personId);
    const generation = generations[membership.personId];
    return person && generation ? [{
      personId: person.id,
      displayName: person.displayName,
      role: membership.lineageRole,
      generation
    }] : [];
  });
  const blood = allMembers.filter((member) => member.role === "blood");
  const generationCounts: Record<string, number> = {};
  for (const member of blood) {
    if (member.generation.displayed !== null) {
      const key = String(member.generation.displayed);
      generationCounts[key] = (generationCounts[key] ?? 0) + 1;
    }
  }
  const members = input.generation === undefined
    ? allMembers
    : blood.filter((member) => member.generation.displayed === input.generation);
  return {
    lineageId: lineage.id,
    name: lineage.name,
    generation: input.generation ?? null,
    memberCount: allMembers.length,
    bloodMemberCount: blood.length,
    generationCounts,
    members: members.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.personId.localeCompare(right.personId))
  };
}
