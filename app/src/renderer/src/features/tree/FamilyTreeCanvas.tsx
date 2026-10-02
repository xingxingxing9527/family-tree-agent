import React, { useEffect, useMemo, useState, type JSX } from "react";
import { Background, Controls, ReactFlow, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { TreeProjectionDto } from "../../../../shared/contracts";
import { FamilyUnionNode } from "./FamilyUnionNode";
import { PersonNode } from "./PersonNode";
import { layoutWithElk, type LaidOutTree, type TreeFlowEdge, type TreeFlowNode } from "./layout-with-elk";
import "./tree.css";

const nodeTypes = { person: PersonNode, familyUnion: FamilyUnionNode } satisfies NodeTypes;

export interface FamilyTreeCanvasProps {
  projection: TreeProjectionDto;
  ageLabels?: Readonly<Record<string, string>>;
  layout?: typeof layoutWithElk;
  selection?: TreeSelection | null;
  onSelectionChange?(selection: TreeSelection | null): void;
}

export type TreeSelection =
  | { kind: "person"; personId: string }
  | { kind: "marriage"; unionId: string; marriageId: string; parentIds: string[] }
  | { kind: "parentChild"; unionId: string; parentIds: string[]; childId: string; marriageId: string | null }
  | { kind: "family"; unionId: string; parentIds: string[]; childIds: string[] };

function selectionForNode(node: TreeFlowNode): TreeSelection {
  const projected = node.data.node;
  if (projected.kind === "person") return { kind: "person", personId: projected.personId };
  if (projected.marriageId) {
    return { kind: "marriage", unionId: projected.unionId, marriageId: projected.marriageId, parentIds: [...projected.parentIds] };
  }
  return { kind: "family", unionId: projected.unionId, parentIds: [...projected.parentIds], childIds: [...projected.childIds] };
}

function selectionForEdge(edge: TreeFlowEdge): TreeSelection | null {
  const projected = edge.data?.edge;
  if (!projected) return null;
  if (projected.kind === "parentUnion") {
    return projected.marriageId
      ? { kind: "marriage", unionId: projected.unionId, marriageId: projected.marriageId, parentIds: [...projected.parentIds] }
      : null;
  }
  return projected.childId
    ? { kind: "parentChild", unionId: projected.unionId, parentIds: [...projected.parentIds], childId: projected.childId, marriageId: projected.marriageId }
    : null;
}

function nodeIsSelected(node: TreeFlowNode, selection: TreeSelection | null): boolean {
  if (!selection) return false;
  const projected = node.data.node;
  if (projected.kind === "person") return selection.kind === "person" && selection.personId === projected.personId;
  return selection.kind !== "person" && selection.unionId === projected.unionId;
}

function edgeIsSelected(edge: TreeFlowEdge, selection: TreeSelection | null): boolean {
  if (!selection || !edge.data) return false;
  const projected = edge.data.edge;
  if (selection.kind === "marriage") return projected.kind === "parentUnion" && projected.marriageId === selection.marriageId;
  if (selection.kind === "parentChild") return projected.kind === "unionChild" && projected.unionId === selection.unionId && projected.childId === selection.childId;
  if (selection.kind === "family") return projected.unionId === selection.unionId;
  return false;
}

export function FamilyTreeCanvas({ projection, ageLabels = {}, layout = layoutWithElk, selection = null, onSelectionChange }: FamilyTreeCanvasProps): JSX.Element {
  const [laidOut, setLaidOut] = useState<LaidOutTree | null>(null);
  const [layoutError, setLayoutError] = useState(false);

  useEffect(() => {
    let current = true;
    setLayoutError(false);
    void layout(projection.topology).then((result) => {
      if (current) setLaidOut(result);
    }).catch(() => {
      if (current) setLayoutError(true);
    });
    return () => { current = false; };
  }, [layout, projection.topology]);

  const nodes = useMemo(() => (laidOut?.nodes ?? []).map((node) => {
    const projected = node.data.node;
    const activate = (): void => onSelectionChange?.(selectionForNode(node));
    return {
      ...node,
      selected: nodeIsSelected(node, selection),
      data: {
        ...node.data,
        ...(projected.kind === "person" ? {
          relationshipLabel: projection.labels[projected.personId] ?? null,
          ageLabel: ageLabels[projected.personId] ?? null
        } : {}),
        onActivate: activate
      }
    };
  }), [ageLabels, laidOut, onSelectionChange, projection.labels, selection]);
  const edges = useMemo(() => (laidOut?.edges ?? []).map((edge) => ({
    ...edge,
    selected: edgeIsSelected(edge, selection)
  })), [laidOut, selection]);

  if (layoutError) return <div className="tree-status" role="alert">无法生成家谱布局。</div>;
  if (!laidOut) return <div className="tree-status" role="status">正在排列家谱…</div>;

  return (
    <section className="family-tree-canvas" aria-label="家谱图画布">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_event, node) => onSelectionChange?.(selectionForNode(node as TreeFlowNode))}
        onEdgeClick={(_event, edge) => {
          const next = selectionForEdge(edge as TreeFlowEdge);
          if (next) onSelectionChange?.(next);
        }}
        onPaneClick={() => onSelectionChange?.(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        minZoom={0.2}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#cbd5e1" gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}
