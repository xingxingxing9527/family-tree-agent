import type { FactQueries } from "../facts/fact-queries.js";
import type { RelativeKind, RelativeReadModel } from "../../../shared/contracts.js";
import { personCandidate } from "./search-people.js";

export function listRelatives(
  queries: FactQueries,
  input: { personId: string; kinds: RelativeKind[] }
): RelativeReadModel[] {
  if (!queries.getPerson(input.personId)) throw new Error(`Person not found: ${input.personId}`);
  const kinds = new Set(input.kinds);
  const relatives: RelativeReadModel[] = [];
  if (kinds.has("parent")) {
    for (const relation of queries.listParentChild().filter((candidate) => candidate.childId === input.personId)) {
      const person = personCandidate(queries, relation.parentId);
      if (person) relatives.push({ relationId: relation.id, kind: "parent", person, parentRole: relation.parentRole, marriageStatus: null });
    }
  }
  if (kinds.has("spouse")) {
    for (const relation of queries.listMarriages().filter((candidate) => candidate.spouseAId === input.personId || candidate.spouseBId === input.personId)) {
      const spouseId = relation.spouseAId === input.personId ? relation.spouseBId : relation.spouseAId;
      const person = personCandidate(queries, spouseId);
      if (person) relatives.push({ relationId: relation.id, kind: "spouse", person, parentRole: null, marriageStatus: relation.status });
    }
  }
  if (kinds.has("child")) {
    for (const relation of queries.listParentChild().filter((candidate) => candidate.parentId === input.personId)) {
      const person = personCandidate(queries, relation.childId);
      if (person) relatives.push({ relationId: relation.id, kind: "child", person, parentRole: null, marriageStatus: null });
    }
  }
  const rank: Record<RelativeKind, number> = { parent: 0, spouse: 1, child: 2 };
  return relatives.sort((left, right) => rank[left.kind] - rank[right.kind]
    || left.person.displayName.localeCompare(right.person.displayName)
    || left.person.id.localeCompare(right.person.id));
}
