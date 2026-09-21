import type { FactQueries } from "../facts/fact-queries.js";
import type { PersonCandidate } from "../../../shared/contracts.js";

const candidateFor = (queries: FactQueries, personId: string): PersonCandidate | null => {
  const person = queries.getPerson(personId);
  if (!person) return null;
  const parentHints = queries.listParentChild()
    .filter((relation) => relation.childId === person.id)
    .flatMap((relation) => {
      const parent = queries.getPerson(relation.parentId);
      return parent ? [{ id: parent.id, displayName: parent.displayName, role: relation.parentRole }] : [];
    })
    .sort((left, right) => left.role.localeCompare(right.role) || left.id.localeCompare(right.id));
  return {
    id: person.id,
    displayName: person.displayName,
    aliases: queries.listAliases(person.id).map((alias) => alias.name),
    gender: person.gender,
    birth: person.birth,
    parentHints
  };
};

export function searchPeople(
  queries: FactQueries,
  input: { query: string; limit: number }
): PersonCandidate[] {
  const query = input.query.trim().toLocaleLowerCase();
  if (!query) return [];
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
  return queries.listPeople()
    .filter((person) => person.displayName.toLocaleLowerCase().includes(query)
      || queries.listAliases(person.id).some((alias) => alias.normalizedName.includes(query)))
    .slice(0, limit)
    .flatMap((person) => {
      const candidate = candidateFor(queries, person.id);
      return candidate ? [candidate] : [];
    });
}

export function personCandidate(queries: FactQueries, personId: string): PersonCandidate | null {
  return candidateFor(queries, personId);
}
