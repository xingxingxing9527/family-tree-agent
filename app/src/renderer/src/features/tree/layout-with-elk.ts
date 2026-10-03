import ELK from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";
import type {
  KinshipDisplayLabelDto,
  TreeProjectionEdgeDto,
  TreeProjectionNodeDto,
  TreeProjectionTopologyDto
} from "../../../../shared/contracts";

export interface TreeFlowNodeData extends Record<string, unknown> {
  node: TreeProjectionNodeDto;
  relationshipLabel: KinshipDisplayLabelDto | null;
}

export interface TreeFlowEdgeData extends Record<string, unknown> {
  edge: TreeProjectionEdgeDto;
  visualRole: "marriage" | "descent";
}

export type TreeFlowNode = Node<TreeFlowNodeData, "person" | "familyUnion">;
export type TreeFlowEdge = Edge<TreeFlowEdgeData>;

export interface LaidOutTree {
  nodes: TreeFlowNode[];
  edges: TreeFlowEdge[];
}

const elk = new ELK();

const NODE_SIZE = {
  person: { width: 180, height: 116 },
  union: { width: 112, height: 72 }
} as const;

const HORIZONTAL_GAP = 16;

interface PositionedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PositionedBlock {
  originalX: number;
  width: number;
  members: Array<{ node: PositionedNode; offset: number }>;
}

interface PositionedBlockGroup {
  anchorX: number;
  key: string;
  blocks: PositionedBlock[];
}

function separateHorizontalOverlaps(topology: TreeProjectionTopologyDto, positions: Map<string, { x: number; y: number }>): void {
  const nodesById = new Map(topology.nodes.map((node) => [node.id, node]));
  const marriageNeighbours = new Map<string, Set<string>>();
  const childFamilies = new Map<string, Set<string>>();
  for (const edge of topology.edges) {
    if (edge.kind === "unionChild") {
      const families = childFamilies.get(edge.target) ?? new Set<string>();
      families.add(edge.source);
      childFamilies.set(edge.target, families);
    }
    const union = nodesById.get(edge.target);
    if (edge.kind !== "parentUnion" || union?.kind !== "union" || union.display.kind === "singleParent") continue;
    if (!marriageNeighbours.has(edge.source)) marriageNeighbours.set(edge.source, new Set());
    if (!marriageNeighbours.has(edge.target)) marriageNeighbours.set(edge.target, new Set());
    marriageNeighbours.get(edge.source)!.add(edge.target);
    marriageNeighbours.get(edge.target)!.add(edge.source);
  }
  const nodes: PositionedNode[] = topology.nodes.flatMap((node) => {
    const position = positions.get(node.id);
    if (!position) return [];
    const size = node.kind === "person" ? NODE_SIZE.person : NODE_SIZE.union;
    return [{ id: node.id, ...position, ...size }];
  }).sort((left, right) => left.y - right.y || left.x - right.x);
  const rows: Array<{ bottom: number; nodes: PositionedNode[] }> = [];
  for (const node of nodes) {
    const row = rows.at(-1);
    if (!row || node.y >= row.bottom) rows.push({ bottom: node.y + node.height, nodes: [node] });
    else {
      row.nodes.push(node);
      row.bottom = Math.max(row.bottom, node.y + node.height);
    }
  }

  const minimumGap = HORIZONTAL_GAP;
  for (const row of rows) {
    row.nodes.sort((left, right) => left.x - right.x || left.id.localeCompare(right.id));
    const originalLeft = Math.min(...row.nodes.map((node) => node.x));
    const originalRight = Math.max(...row.nodes.map((node) => node.x + node.width));
    const rowNodesById = new Map(row.nodes.map((node) => [node.id, node]));
    const visited = new Set<string>();
    const blocks: PositionedBlock[] = [];
    for (const node of row.nodes) {
      if (visited.has(node.id)) continue;
      const component: PositionedNode[] = [];
      const pending = [node.id];
      visited.add(node.id);
      while (pending.length > 0) {
        const currentId = pending.pop()!;
        const current = rowNodesById.get(currentId);
        if (current) component.push(current);
        for (const neighbourId of marriageNeighbours.get(currentId) ?? []) {
          if (!rowNodesById.has(neighbourId) || visited.has(neighbourId)) continue;
          visited.add(neighbourId);
          pending.push(neighbourId);
        }
      }
      component.sort((left, right) => left.x - right.x || left.id.localeCompare(right.id));
      let width = 0;
      const members = component.map((member, index) => {
        const offset = width;
        width += member.width + (index === component.length - 1 ? 0 : minimumGap);
        return { node: member, offset };
      });
      blocks.push({ originalX: Math.min(...component.map((member) => member.x)), width, members });
    }
    const familyGroups = new Map<string, PositionedBlockGroup>();
    const looseGroups: PositionedBlockGroup[] = [];
    for (const block of blocks) {
      const familyIds = new Set(block.members.flatMap(({ node }) => [...(childFamilies.get(node.id) ?? [])]));
      if (familyIds.size !== 1) {
        looseGroups.push({ anchorX: block.originalX, key: `loose:${block.members[0]!.node.id}`, blocks: [block] });
        continue;
      }
      const familyId = [...familyIds][0]!;
      const group = familyGroups.get(familyId) ?? {
        anchorX: positions.get(familyId)?.x ?? block.originalX,
        key: `family:${familyId}`,
        blocks: []
      };
      group.blocks.push(block);
      familyGroups.set(familyId, group);
    }
    const orderedBlocks = [...familyGroups.values(), ...looseGroups]
      .sort((left, right) => left.anchorX - right.anchorX || left.key.localeCompare(right.key))
      .flatMap((group) => group.blocks.sort((left, right) => left.originalX - right.originalX || left.members[0]!.node.id.localeCompare(right.members[0]!.node.id)));
    let cursor = Number.NEGATIVE_INFINITY;
    for (const block of orderedBlocks) {
      const blockX = Math.max(block.originalX, cursor + minimumGap);
      for (const member of block.members) member.node.x = blockX + member.offset;
      cursor = blockX + block.width;
    }
    const adjustedLeft = Math.min(...row.nodes.map((node) => node.x));
    const adjustedRight = Math.max(...row.nodes.map((node) => node.x + node.width));
    const centerOffset = (originalLeft + originalRight - adjustedLeft - adjustedRight) / 2;
    for (const node of row.nodes) {
      const position = positions.get(node.id)!;
      position.x = node.x + centerOffset;
    }
  }
}

export async function layoutWithElk(topology: TreeProjectionTopologyDto): Promise<LaidOutTree> {
  const graph = await elk.layout({
    id: `tree:${topology.key}`,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.spacing.nodeNode": "24",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES"
    },
    children: topology.nodes.map((node) => ({ id: node.id, ...(node.kind === "person" ? NODE_SIZE.person : NODE_SIZE.union) })),
    edges: topology.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }))
  });
  const positions = new Map((graph.children ?? []).map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
  const unionKinds = new Map(topology.nodes.filter((node) => node.kind === "union").map((node) => [node.id, node.display.kind]));
  const visualRole = (edge: TreeProjectionEdgeDto): "marriage" | "descent" => edge.kind === "unionChild" || unionKinds.get(edge.target) === "singleParent" ? "descent" : "marriage";
  for (const union of topology.nodes.filter((node) => node.kind === "union" && node.display.kind !== "singleParent")) {
    const parentIds = topology.edges.filter((edge) => edge.target === union.id && visualRole(edge) === "marriage").map((edge) => edge.source);
    const parentPositions = parentIds.map((id) => positions.get(id)).filter((position): position is { x: number; y: number } => Boolean(position));
    const unionPosition = positions.get(union.id);
    if (!unionPosition || parentPositions.length === 0) continue;
    unionPosition.y = parentPositions.reduce((sum, position) => sum + position.y + NODE_SIZE.person.height / 2, 0) / parentPositions.length - NODE_SIZE.union.height / 2;
    unionPosition.x = parentPositions.reduce((sum, position) => sum + position.x + NODE_SIZE.person.width / 2, 0) / parentPositions.length - NODE_SIZE.union.width / 2;
    if (parentPositions.length === 2) {
      const orderedParents = parentPositions.sort((left, right) => left.x - right.x);
      orderedParents[0]!.x = Math.min(orderedParents[0]!.x, unionPosition.x - NODE_SIZE.person.width - HORIZONTAL_GAP);
      orderedParents[1]!.x = Math.max(orderedParents[1]!.x, unionPosition.x + NODE_SIZE.union.width + HORIZONTAL_GAP);
    }
  }
  separateHorizontalOverlaps(topology, positions);

  return {
    nodes: topology.nodes.map((node) => {
      const size = node.kind === "person" ? NODE_SIZE.person : NODE_SIZE.union;
      return {
        id: node.id,
        type: node.kind === "person" ? "person" as const : "familyUnion" as const,
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: { node, relationshipLabel: null },
        style: { width: size.width, height: size.height },
        draggable: false,
        selectable: true
      };
    }),
    edges: topology.edges.map((edge) => {
      const role = visualRole(edge);
      const sourcePosition = positions.get(edge.source) ?? { x: 0, y: 0 };
      const targetPosition = positions.get(edge.target) ?? { x: 0, y: 0 };
      const sourceOnLeft = sourcePosition.x < targetPosition.x;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: role === "marriage" ? (sourceOnLeft ? "marriage-right" : "marriage-left") : "descent-source",
        targetHandle: role === "marriage" ? (sourceOnLeft ? "marriage-left" : "marriage-right") : "descent-target",
        type: role === "marriage" ? "straight" : "smoothstep",
        data: { edge, visualRole: role },
        style: {
          stroke: role === "marriage" ? "#a16207" : "#334155",
          strokeWidth: role === "marriage" ? 2.5 : 2,
          ...(edge.marriageStatus === "divorced" ? { strokeDasharray: "7 5" } : {})
        }
      };
    })
  };
}
