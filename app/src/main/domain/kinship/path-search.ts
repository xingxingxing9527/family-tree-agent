import type { KinshipPath, RelationEdge, RelationGraph } from "./types.js";

interface PendingPath {
  personIds: string[];
  edges: RelationEdge[];
}

export interface PrimaryKinshipPath {
  path: KinshipPath;
  conflictIds: string[];
}

const rankPath = (edges: readonly RelationEdge[]): 0 | 1 | 2 => {
  if (edges.length <= 1) return 0;
  return edges.every((edge) => edge.kind === "parentChild") ? 1 : 2;
};

const pathKey = (path: KinshipPath): string =>
  `${path.relationIds.join("\u0000")}\u0001${path.personIds.join("\u0000")}`;

const comparePathKeys = (left: KinshipPath, right: KinshipPath): number => {
  const leftKey = pathKey(left);
  const rightKey = pathKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};

const asPath = (pending: PendingPath): KinshipPath => ({
  ...pending,
  relationIds: pending.edges.map((entry) => entry.relationId),
  rank: rankPath(pending.edges)
});

const comparePathScore = (left: KinshipPath, right: KinshipPath): number =>
  left.edges.length - right.edges.length
  || left.rank - right.rank
  || comparePathKeys(left, right);

const orderedUnion = (left: readonly string[], right: readonly string[]): string[] =>
  [...new Set([...left, ...right])].sort();

function pathConflicts(graph: RelationGraph, path: PendingPath): string[] {
  return orderedUnion(
    path.personIds.flatMap((personId) => graph.people.get(personId)?.conflictIds ?? []),
    path.edges.flatMap((edge) => edge.conflictIds)
  );
}

/**
 * Resolves one deterministic best path per target in a single graph traversal.
 * Tree labels only consume the primary term, so retaining every alternative path
 * would repeat the same breadth-first search once per visible person.
 */
export function findPrimaryKinshipPaths(
  graph: RelationGraph,
  sourcePersonId: string,
  targetPersonIds: readonly string[]
): Map<string, PrimaryKinshipPath> {
  const targetIds = new Set(targetPersonIds);
  const output = new Map<string, PrimaryKinshipPath>();
  if (!graph.people.has(sourcePersonId)) return output;

  interface BestState extends PendingPath { conflictIds: string[]; }
  const source: BestState = {
    personIds: [sourcePersonId],
    edges: [],
    conflictIds: [...(graph.people.get(sourcePersonId)?.conflictIds ?? [])].sort()
  };
  const best = new Map<string, BestState>([[sourcePersonId, source]]);
  const formerDirect = new Map<string, BestState>();
  const queue = [sourcePersonId];

  const update = (states: Map<string, BestState>, personId: string, candidate: BestState): boolean => {
    const existing = states.get(personId);
    if (!existing) {
      states.set(personId, candidate);
      return true;
    }
    const candidatePath = asPath(candidate);
    const existingPath = asPath(existing);
    const score = candidatePath.edges.length - existingPath.edges.length || candidatePath.rank - existingPath.rank;
    if (score > 0) return false;
    if (score < 0) {
      states.set(personId, candidate);
      return true;
    }
    const conflictIds = orderedUnion(existing.conflictIds, candidate.conflictIds);
    const selected = comparePathKeys(candidatePath, existingPath) < 0 ? candidate : existing;
    if (selected === existing && conflictIds.length === existing.conflictIds.length) return false;
    states.set(personId, { ...selected, conflictIds });
    return true;
  };

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const personId = queue[cursor]!;
    const current = best.get(personId)!;
    for (const edge of graph.adjacency.get(personId) ?? []) {
      if (current.personIds.includes(edge.toPersonId)) continue;
      const pending: PendingPath = {
        personIds: [...current.personIds, edge.toPersonId],
        edges: [...current.edges, edge]
      };
      const candidate: BestState = {
        ...pending,
        conflictIds: orderedUnion(current.conflictIds, pathConflicts(graph, { personIds: [edge.toPersonId], edges: [edge] }))
      };
      if (edge.kind === "formerMarriage") {
        if (current.edges.length === 0) update(formerDirect, edge.toPersonId, candidate);
        continue;
      }
      if (update(best, edge.toPersonId, candidate)) queue.push(edge.toPersonId);
    }
  }

  for (const targetId of targetIds) {
    const regular = best.get(targetId);
    const former = formerDirect.get(targetId);
    if (!regular && !former) continue;
    if (!regular) {
      output.set(targetId, { path: asPath(former!), conflictIds: former!.conflictIds });
      continue;
    }
    if (!former) {
      output.set(targetId, { path: asPath(regular), conflictIds: regular.conflictIds });
      continue;
    }
    const regularPath = asPath(regular);
    const formerPath = asPath(former);
    const selected = comparePathScore(formerPath, regularPath) < 0 ? former : regular;
    const sameScore = formerPath.edges.length === regularPath.edges.length && formerPath.rank === regularPath.rank;
    output.set(targetId, {
      path: asPath(selected),
      conflictIds: sameScore ? orderedUnion(regular.conflictIds, former.conflictIds) : selected.conflictIds
    });
  }
  return output;
}

export function findKinshipPaths(
  graph: RelationGraph,
  sourcePersonId: string,
  targetPersonId: string
): KinshipPath[] {
  if (!graph.people.has(sourcePersonId) || !graph.people.has(targetPersonId)) return [];
  if (sourcePersonId === targetPersonId) {
    return [{ edges: [], personIds: [sourcePersonId], relationIds: [], rank: 0 }];
  }

  const queue: PendingPath[] = [{ personIds: [sourcePersonId], edges: [] }];
  const candidates: KinshipPath[] = [];
  const shortestDepthByPerson = new Map<string, number>([[sourcePersonId, 0]]);
  let firstResultDepth: number | null = null;

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (firstResultDepth !== null && current.edges.length >= firstResultDepth) continue;
    const currentPersonId = current.personIds[current.personIds.length - 1]!;

    for (const edge of graph.adjacency.get(currentPersonId) ?? []) {
      if (current.personIds.includes(edge.toPersonId)) continue;
      const directFormerEndpoint = current.edges.length === 0
        && edge.kind === "formerMarriage"
        && edge.toPersonId === targetPersonId;
      if (edge.kind === "formerMarriage" && !directFormerEndpoint) continue;

      const nextDepth = current.edges.length + 1;
      const discoveredDepth = shortestDepthByPerson.get(edge.toPersonId);
      if (discoveredDepth !== undefined && nextDepth > discoveredDepth) continue;
      if (discoveredDepth === undefined) shortestDepthByPerson.set(edge.toPersonId, nextDepth);

      const edges = [...current.edges, edge];
      const personIds = [...current.personIds, edge.toPersonId];
      if (edge.toPersonId === targetPersonId) {
        firstResultDepth ??= edges.length;
        if (edges.length === firstResultDepth) {
          candidates.push({
            edges,
            personIds,
            relationIds: edges.map((entry) => entry.relationId),
            rank: rankPath(edges)
          });
        }
      } else if (firstResultDepth === null || edges.length < firstResultDepth) {
        queue.push({ personIds, edges });
      }
    }
  }

  if (candidates.length === 0) return [];
  const bestRank = Math.min(...candidates.map((path) => path.rank));
  return candidates
    .filter((path) => path.rank === bestRank)
    .sort(comparePathKeys);
}
