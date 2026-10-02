export type TreeScopeView = "full" | "lineage" | "core" | "descendants";

export interface TreeScopeInput {
  people: ReadonlyArray<{ id: string }>;
  parentChildFacts: ReadonlyArray<{ id: string; parentId: string; childId: string }>;
  marriages: ReadonlyArray<{
    id: string;
    spouseAId: string;
    spouseBId: string;
    status: "active" | "divorced";
  }>;
  lineageIds: readonly string[];
  memberships: ReadonlyArray<{
    lineageId: string;
    personId: string;
    lineageRole: "blood" | "married_in" | "associated";
    isPrimary: boolean;
  }>;
}

export interface TreeScopeRequest {
  view: TreeScopeView;
  subjectId?: string;
  lineageId?: string;
}

export interface TreeScopeResolution {
  key: string;
  personIds: ReadonlySet<string>;
  parentChildRelationIds: ReadonlySet<string>;
  marriageIds: ReadonlySet<string>;
  metadata: {
    view: TreeScopeView;
    subjectId: string | null;
    lineageId: string | null;
  };
}

export class TreeScopeResolutionError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "VALIDATION",
    message: string
  ) {
    super(message);
    this.name = "TreeScopeResolutionError";
  }
}

const addToIndex = (index: Map<string, Set<string>>, key: string, value: string): void => {
  const values = index.get(key) ?? new Set<string>();
  values.add(value);
  index.set(key, values);
};

export class TreeScopeResolver {
  resolve(input: TreeScopeInput, request: TreeScopeRequest): TreeScopeResolution {
    const knownPeople = new Set(input.people.map(({ id }) => id));
    const lineageIds = new Set(input.lineageIds);
    const parentsByChild = new Map<string, Set<string>>();
    const childrenByParent = new Map<string, Set<string>>();

    for (const fact of input.parentChildFacts) {
      if (!knownPeople.has(fact.parentId) || !knownPeople.has(fact.childId)) continue;
      addToIndex(parentsByChild, fact.childId, fact.parentId);
      addToIndex(childrenByParent, fact.parentId, fact.childId);
    }

    const subjectId = request.view === "full"
      ? null
      : this.requireSubject(request.subjectId, knownPeople);
    const lineageId = request.view === "lineage"
      ? this.requireLineage(request.lineageId, lineageIds)
      : null;

    if (request.view !== "lineage" && request.lineageId !== undefined) {
      throw new TreeScopeResolutionError("VALIDATION", "This tree view does not accept a lineage");
    }

    const childrenOf = (personId: string): ReadonlySet<string> => childrenByParent.get(personId) ?? new Set<string>();
    const parentsOf = (personId: string): ReadonlySet<string> => parentsByChild.get(personId) ?? new Set<string>();
    const shareChild = (personAId: string, personBId: string): boolean => {
      const childrenA = childrenOf(personAId);
      const childrenB = childrenOf(personBId);
      for (const childId of childrenA) {
        if (childrenB.has(childId)) return true;
      }
      return false;
    };
    const permittedMarriage = (marriage: TreeScopeInput["marriages"][number]): boolean =>
      marriage.status === "active" || shareChild(marriage.spouseAId, marriage.spouseBId);
    const addPermittedSpouses = (visible: Set<string>, anchors: ReadonlySet<string>): void => {
      for (const marriage of input.marriages) {
        if (!permittedMarriage(marriage)) continue;
        if (anchors.has(marriage.spouseAId) && knownPeople.has(marriage.spouseBId)) {
          visible.add(marriage.spouseBId);
        }
        if (anchors.has(marriage.spouseBId) && knownPeople.has(marriage.spouseAId)) {
          visible.add(marriage.spouseAId);
        }
      }
    };

    let personIds: Set<string>;
    let key: string;

    switch (request.view) {
      case "full":
        personIds = new Set(knownPeople);
        key = "full";
        break;
      case "core": {
        personIds = new Set([subjectId]);
        const parents = new Set(parentsOf(subjectId));
        for (const parentId of parents) {
          personIds.add(parentId);
          for (const grandparentId of parentsOf(parentId)) personIds.add(grandparentId);
          for (const siblingId of childrenOf(parentId)) personIds.add(siblingId);
        }
        for (const childId of childrenOf(subjectId)) personIds.add(childId);
        addPermittedSpouses(personIds, new Set([subjectId]));
        key = `core:${subjectId}`;
        break;
      }
      case "descendants": {
        personIds = new Set<string>();
        const queue = [subjectId];
        while (queue.length > 0) {
          const personId = queue.shift()!;
          if (personIds.has(personId)) continue;
          personIds.add(personId);
          for (const childId of childrenOf(personId)) {
            if (!personIds.has(childId)) queue.push(childId);
          }
        }
        const descendantChain = new Set(personIds);
        addPermittedSpouses(personIds, descendantChain);
        key = `descendants:${subjectId}`;
        break;
      }
      case "lineage": {
        const selectedMemberships = input.memberships.filter((membership) => membership.lineageId === lineageId);
        if (!selectedMemberships.some((membership) => membership.personId === subjectId)) {
          throw new TreeScopeResolutionError("VALIDATION", "The selected person is not assigned to this lineage");
        }
        personIds = new Set(
          selectedMemberships
            .map(({ personId }) => personId)
            .filter((personId) => knownPeople.has(personId))
        );
        const bloodMembers = new Set(
          selectedMemberships
            .filter(({ lineageRole, personId }) => lineageRole === "blood" && knownPeople.has(personId))
            .map(({ personId }) => personId)
        );
        addPermittedSpouses(personIds, bloodMembers);
        key = `lineage:${subjectId}:${lineageId}`;
        break;
      }
    }

    const parentChildRelationIds = new Set(
      input.parentChildFacts
        .filter(({ parentId, childId }) => personIds.has(parentId) && personIds.has(childId))
        .map(({ id }) => id)
    );
    const marriageIds = new Set(
      input.marriages
        .filter((marriage) => request.view === "full" || permittedMarriage(marriage))
        .filter(({ spouseAId, spouseBId }) => personIds.has(spouseAId) && personIds.has(spouseBId))
        .map(({ id }) => id)
    );

    return {
      key,
      personIds,
      parentChildRelationIds,
      marriageIds,
      metadata: { view: request.view, subjectId, lineageId }
    };
  }

  private requireSubject(subjectId: string | undefined, knownPeople: ReadonlySet<string>): string {
    if (!subjectId) {
      throw new TreeScopeResolutionError("VALIDATION", "This tree view requires a subject");
    }
    if (!knownPeople.has(subjectId)) {
      throw new TreeScopeResolutionError("NOT_FOUND", "The selected person does not exist");
    }
    return subjectId;
  }

  private requireLineage(lineageId: string | undefined, knownLineages: ReadonlySet<string>): string {
    if (!lineageId) {
      throw new TreeScopeResolutionError("VALIDATION", "Family Lineage requires a lineage");
    }
    if (!knownLineages.has(lineageId)) {
      throw new TreeScopeResolutionError("NOT_FOUND", "The selected lineage does not exist");
    }
    return lineageId;
  }
}
