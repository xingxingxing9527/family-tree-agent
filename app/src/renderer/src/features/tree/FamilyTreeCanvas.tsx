import React, { useEffect, useMemo, useState, type JSX } from "react";
import { Background, Controls, ReactFlow, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { TreeProjectionDto } from "../../../../shared/contracts";
import { FamilyUnionNode } from "./FamilyUnionNode";
import { PersonNode } from "./PersonNode";
import { layoutWithElk, type LaidOutTree } from "./layout-with-elk";
import "./tree.css";

const nodeTypes = { person: PersonNode, familyUnion: FamilyUnionNode } satisfies NodeTypes;

export interface FamilyTreeCanvasProps {
  projection: TreeProjectionDto;
  layout?: typeof layoutWithElk;
}

export function FamilyTreeCanvas({ projection, layout = layoutWithElk }: FamilyTreeCanvasProps): JSX.Element {
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
    return projected.kind === "person"
      ? { ...node, data: { ...node.data, relationshipLabel: projection.labels[projected.personId] ?? null } }
      : node;
  }), [laidOut, projection.labels]);

  if (layoutError) return <div className="tree-status" role="alert">无法生成家谱布局。</div>;
  if (!laidOut) return <div className="tree-status" role="status">正在排列家谱…</div>;

  return (
    <section className="family-tree-canvas" aria-label="家谱图画布">
      <ReactFlow
        nodes={nodes}
        edges={laidOut.edges}
        nodeTypes={nodeTypes}
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
