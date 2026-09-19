export interface GenerationDisplay {
  declared: number | null;
  computed: number | null;
  displayed: number | null;
  source: "declared" | "computed" | "none";
  conflict: boolean;
}

export interface GenerationMembership {
  personId: string;
  lineageRole: "blood" | "married_in" | "associated";
  declaredGeneration: number | null;
}

export interface BiologicalParentChildFact {
  parentId: string;
  childId: string;
  relationshipType: "biological";
}

export interface GenerationCalculationInput {
  founderPersonId: string;
  memberships: GenerationMembership[];
  parentChildFacts: BiologicalParentChildFact[];
}

export class GenerationService {
  calculate(input: GenerationCalculationInput): Record<string, GenerationDisplay> {
    const bloodMembers = new Set(input.memberships
      .filter((membership) => membership.lineageRole === "blood")
      .map((membership) => membership.personId));
    const computed = new Map<string, number>();
    if (bloodMembers.has(input.founderPersonId)) computed.set(input.founderPersonId, 1);
    const childrenByParent = new Map<string, string[]>();
    for (const fact of input.parentChildFacts) {
      if (!bloodMembers.has(fact.parentId) || !bloodMembers.has(fact.childId)) continue;
      const children = childrenByParent.get(fact.parentId) ?? [];
      children.push(fact.childId);
      childrenByParent.set(fact.parentId, children);
    }

    const queue = computed.has(input.founderPersonId) ? [input.founderPersonId] : [];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const childGeneration = computed.get(parentId)! + 1;
      for (const childId of childrenByParent.get(parentId) ?? []) {
        const current = computed.get(childId);
        if (current === undefined || childGeneration < current) {
          computed.set(childId, childGeneration);
          queue.push(childId);
        }
      }
    }

    return Object.fromEntries(input.memberships.map((membership) => {
      const value = membership.lineageRole === "blood" ? computed.get(membership.personId) ?? null : null;
      const declared = membership.declaredGeneration;
      return [membership.personId, {
        declared,
        computed: value,
        displayed: declared ?? value,
        source: declared !== null ? "declared" : value !== null ? "computed" : "none",
        conflict: declared !== null && value !== null && declared !== value
      } satisfies GenerationDisplay];
    }));
  }
}
