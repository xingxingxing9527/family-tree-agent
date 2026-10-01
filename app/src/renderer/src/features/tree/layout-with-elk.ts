import ELK from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";
import type {
  TreeProjectionEdgeDto,
  TreeProjectionNodeDto,
  TreeProjectionTopologyDto
} from "../../../../shared/contracts";

export interface TreeFlowNodeData extends Record<string, unknown> {
  node: TreeProjectionNodeDto;
  relationshipLabel: string | null;
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

export async function layoutWithElk(topology: TreeProjectionTopologyDto): Promise<LaidOutTree> {
  const graph = await elk.layout({
    id: `tree:${topology.key}`,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.spacing.nodeNode": "36",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES"
    },
    children: topology.nodes.map((node) => ({
      id: node.id,
      width: node.kind === "person" ? 196 : 136,
      height: node.kind === "person" ? 112 : 96
    })),
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
    unionPosition.y = parentPositions.reduce((sum, position) => sum + position.y + 56, 0) / parentPositions.length - 48;
    unionPosition.x = parentPositions.reduce((sum, position) => sum + position.x + 98, 0) / parentPositions.length - 68;
    if (parentPositions.length === 2) {
      const orderedParents = parentPositions.sort((left, right) => left.x - right.x);
      orderedParents[0]!.x = Math.min(orderedParents[0]!.x, unionPosition.x - 216);
      orderedParents[1]!.x = Math.max(orderedParents[1]!.x, unionPosition.x + 156);
    }
  }

  return {
    nodes: topology.nodes.map((node) => ({
      id: node.id,
      type: node.kind === "person" ? "person" : "familyUnion",
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: { node, relationshipLabel: null },
      draggable: false,
      selectable: true
    })),
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
