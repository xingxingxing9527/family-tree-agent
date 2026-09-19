import type { GenerationDisplay } from "../lineage/generation-service.js";
import type { FamilyUnion } from "./family-union-projector.js";

export interface TreePersonDisplay {
  displayName: string;
  birthYear: number | null;
  deathYear: number | null;
  generation: GenerationDisplay | null;
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
  display: Pick<FamilyUnion, "kind" | "marriageStatus" | "warnings">;
}

export type TreeProjectionNode = TreePersonNode | TreeUnionNode;

export interface TreeProjectionEdge {
  id: string;
  source: string;
  target: string;
  kind: "parentUnion" | "unionChild";
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

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort((left, right) => left.localeCompare(right));

export class TreeProjectionService {
  private readonly people: Map<string, TreeProjectionPerson>;
  private readonly topologyCache = new Map<string, TreeProjectionTopology>();
  private readonly childrenByParent = new Map<string, Set<string>>();
  private readonly parentsByChild = new Map<string, Set<string>>();

  constructor(private readonly input: TreeProjectionInput, private readonly labelResolver: TreeLabelResolver = () => null) {
    this.people = new Map(input.people.map((person) => [person.id, person]));
    for (const union of input.unions) {
      for (const parentId of union.parentIds) {
        const children = this.childrenByParent.get(parentId) ?? new Set<string>();
        union.childIds.forEach((childId) => children.add(childId));
        this.childrenByParent.set(parentId, children);
      }
      for (const childId of union.childIds) {
        const parents = this.parentsByChild.get(childId) ?? new Set<string>();
        union.parentIds.forEach((parentId) => parents.add(parentId));
        this.parentsByChild.set(childId, parents);
      }
    }
  }

  full(viewpointId: string, collapseDepth: number): TreeProjection {
    const key = `full:${collapseDepth}`;
    const topology = this.cached(key, () => this.buildFullTopology(key, collapseDepth));
    return this.label(topology, viewpointId);
  }

  branch(rootPersonId: string): TreeProjection {
    const key = `branch:${rootPersonId}`;
    return this.unlabelled(this.cached(key, () => this.buildScopedTopology(key, this.walk(rootPersonId, this.childrenByParent))));
  }

  ancestors(personId: string): TreeProjection {
    const key = `ancestors:${personId}`;
    return this.unlabelled(this.cached(key, () => this.buildScopedTopology(key, this.walk(personId, this.parentsByChild), true)));
  }

  descendants(personId: string): TreeProjection {
    const key = `descendants:${personId}`;
    return this.unlabelled(this.cached(key, () => this.buildScopedTopology(key, this.walk(personId, this.childrenByParent))));
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

  private buildScopedTopology(key: string, traversed: Set<string>, includeAncestorUnions = false): TreeProjectionTopology {
    const unionIds = new Set<string>();
    const personIds = new Set(traversed);
    for (const union of this.input.unions) {
      const hasTraversedParent = union.parentIds.some((id) => traversed.has(id));
      const hasTraversedChild = union.childIds.some((id) => traversed.has(id));
      const relevant = includeAncestorUnions
        ? hasTraversedChild && union.parentIds.every((id) => traversed.has(id))
        : hasTraversedParent && (union.childIds.length === 0 || hasTraversedChild);
      if (!relevant) continue;
      unionIds.add(union.id);
      union.parentIds.forEach((id) => personIds.add(id));
      union.childIds.filter((id) => traversed.has(id)).forEach((id) => personIds.add(id));
    }
    return this.buildTopology(key, personIds, unionIds);
  }

  private buildTopology(key: string, personIds: Set<string>, unionIds: Set<string>): TreeProjectionTopology {
    const people = sorted(personIds).flatMap((personId): TreePersonNode[] => {
      const person = this.people.get(personId);
      return person ? [{
        id: `person:${person.id}`,
        kind: "person",
        personId: person.id,
        display: {
          displayName: person.displayName,
          birthYear: person.birthYear,
          deathYear: person.deathYear,
          generation: person.generation
        }
      }] : [];
    });
    const activeUnions = this.input.unions.filter((union) => unionIds.has(union.id)).sort((left, right) => left.id.localeCompare(right.id));
    const unionNodes: TreeUnionNode[] = activeUnions.map((union) => ({
      id: union.id,
      kind: "union",
      unionId: union.id,
      display: { kind: union.kind, marriageStatus: union.marriageStatus, warnings: [...union.warnings] }
    }));
    const edges = activeUnions.flatMap((union): TreeProjectionEdge[] => [
      ...union.parentIds.filter((id) => personIds.has(id)).map((parentId) => ({
        id: `parent:${parentId}:${union.id}`,
        source: `person:${parentId}`,
        target: union.id,
        kind: "parentUnion" as const,
        marriageStatus: union.marriageStatus
      })),
      ...union.childIds.filter((id) => personIds.has(id)).map((childId) => ({
        id: `child:${union.id}:${childId}`,
        source: union.id,
        target: `person:${childId}`,
        kind: "unionChild" as const,
        marriageStatus: union.marriageStatus
      }))
    ]).sort((left, right) => left.id.localeCompare(right.id));
    return { key, nodes: [...people, ...unionNodes], edges };
  }

  private walk(startId: string, adjacency: Map<string, Set<string>>): Set<string> {
    const visited = new Set<string>();
    const queue = [startId];
    while (queue.length > 0) {
      const personId = queue.shift()!;
      if (visited.has(personId) || !this.people.has(personId)) continue;
      visited.add(personId);
      for (const relatedId of adjacency.get(personId) ?? []) queue.push(relatedId);
    }
    return visited;
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
