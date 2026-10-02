import type { GenerationDisplay } from "../lineage/generation-service.js";
import type { FamilyUnion } from "./family-union-projector.js";

export interface TreePersonDisplay {
  displayName: string;
  birthYear: number | null;
  deathYear: number | null;
  generation: GenerationDisplay | null;
  generationMarker: string | null;
  lineageRole: "blood" | "married_in" | "associated" | null;
}

export interface TreeProjectionPerson extends TreePersonDisplay {
  id: string;
}

export interface TreePersonNode {
  id: string;
  kind: "person";
  personId: string;
  display: TreePersonDisplay;
}

export interface TreeUnionNode {
  id: string;
  kind: "union";
  unionId: string;
  parentIds: string[];
  childIds: string[];
  marriageId: string | null;
  display: Pick<FamilyUnion, "kind" | "marriageStatus" | "marriageStart" | "marriageEnd" | "warnings">;
}

export type TreeProjectionNode = TreePersonNode | TreeUnionNode;

export interface TreeProjectionEdge {
  id: string;
  source: string;
  target: string;
  kind: "parentUnion" | "unionChild";
  unionId: string;
  parentIds: string[];
  childId: string | null;
  marriageId: string | null;
  marriageStatus: FamilyUnion["marriageStatus"];
}

export interface TreeProjectionTopology {
  key: string;
  nodes: TreeProjectionNode[];
  edges: TreeProjectionEdge[];
}

export interface TreeProjection {
  topology: TreeProjectionTopology;
  viewpointId: string | null;
  labels: Readonly<Record<string, string | null>>;
}

export interface TreeProjectionInput {
  people: TreeProjectionPerson[];
  unions: FamilyUnion[];
}

export type TreeLabelResolver = (viewpointId: string, targetPersonId: string) => string | null;

export class TreeProjectionService {
  private readonly people: Map<string, TreeProjectionPerson>;
  private readonly topologyCache = new Map<string, TreeProjectionTopology>();
  private readonly childrenByParent = new Map<string, Set<string>>();

  constructor(private readonly input: TreeProjectionInput, private readonly labelResolver: TreeLabelResolver = () => null) {
    this.people = new Map(input.people.map((person) => [person.id, person]));
    for (const union of input.unions) {
      for (const parentId of union.parentIds) {
        const children = this.childrenByParent.get(parentId) ?? new Set<string>();
        union.childIds.forEach((childId) => children.add(childId));
        this.childrenByParent.set(parentId, children);
      }
    }
  }

  full(collapseDepth: number): TreeProjection {
    const key = `full:${collapseDepth}`;
    const topology = this.cached(key, () => this.buildFullTopology(key, collapseDepth));
    return this.unlabelled(topology);
  }

  scoped(key: string): TreeProjection {
    const topology = this.cached(key, () => this.buildTopology(
      key,
      new Set(this.people.keys()),
      new Set(this.input.unions.map((union) => union.id))
    ));
    return this.unlabelled(topology);
  }

  withViewpoint(projection: TreeProjection, viewpointId: string): TreeProjection {
    return this.label(projection.topology, viewpointId);
  }

  private buildFullTopology(key: string, collapseDepth: number): TreeProjectionTopology {
    if (!Number.isFinite(collapseDepth)) return this.buildTopology(key, new Set(this.people.keys()), new Set(this.input.unions.map((union) => union.id)));
    const childIds = new Set(this.input.unions.flatMap((union) => union.childIds));
    const roots = [...this.people.keys()].filter((personId) => !childIds.has(personId));
    const included = new Set<string>();
    const queue = roots.map((personId) => ({ personId, depth: 0 }));
    while (queue.length > 0) {
      const { personId, depth } = queue.shift()!;
      if (included.has(personId) || depth > collapseDepth) continue;
      included.add(personId);
      for (const childId of this.childrenByParent.get(personId) ?? []) queue.push({ personId: childId, depth: depth + 1 });
    }
    const unionIds = new Set(this.input.unions
      .filter((union) => union.parentIds.some((id) => included.has(id)) && (union.childIds.length === 0 || union.childIds.some((id) => included.has(id))))
      .map((union) => union.id));
    return this.buildTopology(key, included, unionIds);
  }

  private buildTopology(key: string, personIds: Set<string>, unionIds: Set<string>): TreeProjectionTopology {
    const roleOrder: Record<NonNullable<TreePersonDisplay["lineageRole"]> | "unknown", number> = { blood: 0, associated: 1, unknown: 2, married_in: 3 };
    const orderedPeople = [...new Set(personIds)].sort((left, right) => {
      const leftRole = this.people.get(left)?.lineageRole ?? "unknown";
      const rightRole = this.people.get(right)?.lineageRole ?? "unknown";
      return roleOrder[leftRole] - roleOrder[rightRole] || left.localeCompare(right);
    });
    const people = orderedPeople.flatMap((personId): TreePersonNode[] => {
      const person = this.people.get(personId);
      return person ? [{
        id: `person:${person.id}`,
        kind: "person",
        personId: person.id,
        display: {
          displayName: person.displayName,
          birthYear: person.birthYear,
          deathYear: person.deathYear,
          generation: person.generation,
          generationMarker: person.generationMarker,
          lineageRole: person.lineageRole
        }
      }] : [];
    });
    const activeUnions = this.input.unions.filter((union) => unionIds.has(union.id)).sort((left, right) => left.id.localeCompare(right.id));
    const unionNodes: TreeUnionNode[] = activeUnions.map((union) => ({
      id: union.id,
      kind: "union",
      unionId: union.id,
      parentIds: [...union.parentIds],
      childIds: [...union.childIds],
      marriageId: union.marriageId,
      display: {
        kind: union.kind,
        marriageStatus: union.marriageStatus,
        marriageStart: union.marriageStart,
        marriageEnd: union.marriageEnd,
        warnings: [...union.warnings]
      }
    }));
    const edges = activeUnions.flatMap((union): TreeProjectionEdge[] => [
      ...union.parentIds.filter((id) => personIds.has(id)).map((parentId) => ({
        id: `parent:${parentId}:${union.id}`,
        source: `person:${parentId}`,
        target: union.id,
        kind: "parentUnion" as const,
        unionId: union.id,
        parentIds: [...union.parentIds],
        childId: null,
        marriageId: union.marriageId,
        marriageStatus: union.marriageStatus
      })),
      ...union.childIds.filter((id) => personIds.has(id)).map((childId) => ({
        id: `child:${union.id}:${childId}`,
        source: union.id,
        target: `person:${childId}`,
        kind: "unionChild" as const,
        unionId: union.id,
        parentIds: [...union.parentIds],
        childId,
        marriageId: union.marriageId,
        marriageStatus: union.marriageStatus
      }))
    ]).sort((left, right) => left.id.localeCompare(right.id));
    return { key, nodes: [...people, ...unionNodes], edges };
  }

  private cached(key: string, build: () => TreeProjectionTopology): TreeProjectionTopology {
    const current = this.topologyCache.get(key);
    if (current) return current;
    const topology = build();
    this.topologyCache.set(key, topology);
    return topology;
  }

  private label(topology: TreeProjectionTopology, viewpointId: string): TreeProjection {
    const labels = Object.fromEntries(topology.nodes
      .filter((node): node is TreePersonNode => node.kind === "person")
      .map((node) => [node.personId, this.labelResolver(viewpointId, node.personId)]));
    return { topology, viewpointId, labels };
  }

  private unlabelled(topology: TreeProjectionTopology): TreeProjection {
    return { topology, viewpointId: null, labels: {} };
  }
}
