import React, { type JSX } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { TreeFlowNodeData } from "./layout-with-elk";

type UnionFlowNode = Node<TreeFlowNodeData, "familyUnion">;

function unionLabel(kind: "marriage" | "coParents" | "singleParent" | "unassigned", ended: boolean): string {
  if (ended) return "已结束婚姻";
  if (kind === "marriage") return "婚姻";
  if (kind === "coParents") return "双亲家庭";
  if (kind === "singleParent") return "单亲家庭";
  return "待分配家庭";
}

export function FamilyUnionNode({ data }: NodeProps<UnionFlowNode>): JSX.Element | null {
  if (data.node.kind !== "union") return null;
  const ended = data.node.display.marriageStatus === "divorced";
  const label = unionLabel(data.node.display.kind, ended);
  return (
    <article
      className={`family-union-node${ended ? " ended" : ""}${data.node.display.kind === "unassigned" ? " warning" : ""}`}
      role="group"
      aria-label={`家庭联合：${label}`}
      style={{ backgroundColor: "#ffffff", color: "#0f172a" }}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span>{label}</span>
      {data.node.display.warnings.map((warning) => <span className="sr-only" key={warning}>{warning}</span>)}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </article>
  );
}
