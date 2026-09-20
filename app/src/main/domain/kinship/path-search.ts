import type { KinshipPath, RelationEdge, RelationGraph } from "./types.js";

interface PendingPath {
  personIds: string[];
  edges: RelationEdge[];
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
