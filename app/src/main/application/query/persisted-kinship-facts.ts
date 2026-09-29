import { annotateIncompatibleDirectRoles } from "../../domain/kinship/conflict-annotation.js";
import type { KinshipFactGraph } from "../../domain/kinship/types.js";
import type { FactQueries } from "../facts/fact-queries.js";

interface PersistedKinshipRows {
  people: ReturnType<FactQueries["listPeople"]>;
  parentChild: ReturnType<FactQueries["listParentChild"]>;
  marriages: ReturnType<FactQueries["listMarriages"]>;
}

export function loadPersistedKinshipFacts(
  queries: FactQueries,
  rows: PersistedKinshipRows = {
    people: queries.listPeople(),
    parentChild: queries.listParentChild(),
    marriages: queries.listMarriages()
  }
): KinshipFactGraph {
  return annotateIncompatibleDirectRoles({
    people: rows.people.map((person) => ({ id: person.id, gender: person.gender, birth: person.birth })),
    parentChild: rows.parentChild.map((relation) => ({
      id: relation.id,
      parentId: relation.parentId,
      childId: relation.childId,
      parentRole: relation.parentRole
    })),
    marriages: rows.marriages.map((marriage) => ({
      id: marriage.id,
      spouseAId: marriage.spouseAId,
      spouseBId: marriage.spouseBId,
      status: marriage.status
    }))
  });
}
