import type {
  KinshipFactGraph,
  KinshipGender,
  KinshipStep,
  RelationEdge,
  RelationGraph
} from "./types.js";

const childStep = (gender: KinshipGender): KinshipStep => {
  if (gender === "male") return "son";
  if (gender === "female") return "daughter";
  return "child";
};

const spouseStep = (gender: KinshipGender, former: boolean): KinshipStep => {
  if (gender === "male") return former ? "formerHusband" : "husband";
  if (gender === "female") return former ? "formerWife" : "wife";
  return former ? "formerSpouse" : "spouse";
};

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const compareEdges = (left: RelationEdge, right: RelationEdge): number =>
  compareText(left.relationId, right.relationId)
  || compareText(left.toPersonId, right.toPersonId)
  || compareText(left.step, right.step);

export function createRelationGraph(input: KinshipFactGraph): RelationGraph {
  const people = new Map(input.people.map((person) => [person.id, {
    ...person,
    birth: person.birth ? { ...person.birth } : null,
    ...(person.conflictIds ? { conflictIds: [...person.conflictIds] } : {})
  }]));
  const adjacency = new Map<string, RelationEdge[]>();
  for (const personId of people.keys()) adjacency.set(personId, []);

  const add = (edge: RelationEdge): void => {
    adjacency.get(edge.fromPersonId)?.push(edge);
  };

  for (const fact of [...input.parentChild].sort((a, b) => compareText(a.id, b.id))) {
    const parent = people.get(fact.parentId);
    const child = people.get(fact.childId);
    if (!parent || !child) continue;
    const down = childStep(child.gender);
    add({
      relationId: fact.id,
      fromPersonId: fact.parentId,
      toPersonId: fact.childId,
      step: down,
      inverseStep: fact.parentRole,
      kind: "parentChild",
      conflictIds: [...(fact.conflictIds ?? [])].sort()
    });
    add({
      relationId: fact.id,
      fromPersonId: fact.childId,
      toPersonId: fact.parentId,
      step: fact.parentRole,
      inverseStep: down,
      kind: "parentChild",
      conflictIds: [...(fact.conflictIds ?? [])].sort()
    });
  }

  for (const fact of [...input.marriages].sort((a, b) => compareText(a.id, b.id))) {
    const spouseA = people.get(fact.spouseAId);
    const spouseB = people.get(fact.spouseBId);
    if (!spouseA || !spouseB) continue;
    const former = fact.status === "divorced";
    const kind = former ? "formerMarriage" as const : "marriage" as const;
    add({
      relationId: fact.id,
      fromPersonId: fact.spouseAId,
      toPersonId: fact.spouseBId,
      step: spouseStep(spouseB.gender, former),
      inverseStep: spouseStep(spouseA.gender, former),
      kind,
      conflictIds: [...(fact.conflictIds ?? [])].sort()
    });
    add({
      relationId: fact.id,
      fromPersonId: fact.spouseBId,
      toPersonId: fact.spouseAId,
      step: spouseStep(spouseA.gender, former),
      inverseStep: spouseStep(spouseB.gender, former),
      kind,
      conflictIds: [...(fact.conflictIds ?? [])].sort()
    });
  }

  for (const edges of adjacency.values()) edges.sort(compareEdges);
  return { people, adjacency };
}

export function reversePathEdge(edge: RelationEdge): RelationEdge {
  return {
    ...edge,
    fromPersonId: edge.toPersonId,
    toPersonId: edge.fromPersonId,
    step: edge.inverseStep,
    inverseStep: edge.step
  };
}
