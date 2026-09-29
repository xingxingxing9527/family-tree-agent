import type { KinshipFactGraph } from "./types.js";

const pairKey = (left: string, right: string): string => [left, right].sort().join(":");

/**
 * Persisted parent/child and active-spouse roles for the same two people cannot
 * both be true. Command validation normally prevents this state; read paths
 * still fail conservatively when opening imported or historically corrupted data.
 */
export function annotateIncompatibleDirectRoles(facts: KinshipFactGraph): KinshipFactGraph {
  const parentChildPairs = new Set(facts.parentChild.map((fact) => pairKey(fact.parentId, fact.childId)));
  const incompatiblePairs = new Set(facts.marriages
    .filter((fact) => fact.status === "active")
    .map((fact) => pairKey(fact.spouseAId, fact.spouseBId))
    .filter((key) => parentChildPairs.has(key)));
  const conflicts = (left: string, right: string, existing: readonly string[] | undefined): string[] | undefined => {
    const key = pairKey(left, right);
    if (!incompatiblePairs.has(key)) return existing ? [...existing] : undefined;
    return [...new Set([...(existing ?? []), `incompatible-direct-roles:${key}`])].sort();
  };
  return {
    people: facts.people.map((person) => ({ ...person, ...(person.conflictIds ? { conflictIds: [...person.conflictIds] } : {}) })),
    parentChild: facts.parentChild.map((fact) => ({
      ...fact,
      ...((conflicts(fact.parentId, fact.childId, fact.conflictIds))
        ? { conflictIds: conflicts(fact.parentId, fact.childId, fact.conflictIds) }
        : {})
    })),
    marriages: facts.marriages.map((fact) => ({
      ...fact,
      ...((conflicts(fact.spouseAId, fact.spouseBId, fact.conflictIds))
        ? { conflictIds: conflicts(fact.spouseAId, fact.spouseBId, fact.conflictIds) }
        : {})
    }))
  };
}
