import React, { type JSX } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { TreeFlowNodeData } from "./layout-with-elk";

type PersonFlowNode = Node<TreeFlowNodeData, "person">;

export function PersonNode({ data }: NodeProps<PersonFlowNode>): JSX.Element | null {
  if (data.node.kind !== "person") return null;
  const { display } = data.node;
  const years = display.birthYear === null && display.deathYear === null
    ? null
    : `${display.birthYear ?? "?"}–${display.deathYear ?? ""}`;
  const generation = display.generation?.displayed === null || display.generation === null
    ? null
    : display.generation.source === "computed"
      ? `第 ${display.generation.displayed} 代（系统推导）`
      : `第 ${display.generation.displayed} 代${display.generation.conflict ? "（与系统推导冲突）" : "（申报）"}`;

  return (
    <article
      className="tree-person-node"
      role="group"
      aria-label={`人物：${display.displayName}`}
      style={{ backgroundColor: "#ffffff", color: "#0f172a" }}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <strong className="tree-person-name" style={{ fontSize: "15px" }}>{display.displayName}</strong>
      {data.relationshipLabel && <span className="tree-kinship-label">{data.relationshipLabel}</span>}
      {years && <span className="tree-life-years">{years}</span>}
      {generation && <span className={display.generation?.conflict ? "tree-generation conflict" : "tree-generation"}>{generation}</span>}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </article>
  );
}
