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
      "elk.edgeRouting": "ORTHOGONAL"
    },
    children: topology.nodes.map((node) => ({
      id: node.id,
      width: node.kind === "person" ? 196 : 136,
      height: node.kind === "person" ? 112 : 96
    })),
    edges: topology.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }))
  });
  const positions = new Map((graph.children ?? []).map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));

  return {
    nodes: topology.nodes.map((node) => ({
      id: node.id,
      type: node.kind === "person" ? "person" : "familyUnion",
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: { node, relationshipLabel: null },
      draggable: false,
      selectable: true
    })),
    edges: topology.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      data: { edge },
      style: edge.marriageStatus === "divorced" ? { stroke: "#64748b", strokeDasharray: "7 5" } : { stroke: "#334155" }
    }))
  };
}
