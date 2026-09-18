export interface ParentEdge {
  parentId: string;
  childId: string;
}

export function wouldCreateParentCycle(
  proposedParentId: string,
  childId: string,
  existingEdges: ReadonlyArray<ParentEdge>
): boolean {
  if (proposedParentId === childId) return true;

  const childrenByParent = new Map<string, string[]>();
  for (const edge of existingEdges) {
    const children = childrenByParent.get(edge.parentId) ?? [];
    children.push(edge.childId);
    childrenByParent.set(edge.parentId, children);
  }

  const pending = [childId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === proposedParentId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(childrenByParent.get(current) ?? []));
  }
  return false;
}
