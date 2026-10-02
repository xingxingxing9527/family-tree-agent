import React, { type JSX } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { TreeFlowNodeData } from "./layout-with-elk";
import { useOptionalViewpoint } from "../../app/ViewpointContext";

type PersonFlowNode = Node<TreeFlowNodeData, "person">;

export function PersonNode({ data, selected }: NodeProps<PersonFlowNode>): JSX.Element | null {
  const viewpoint = useOptionalViewpoint();
  if (data.node.kind !== "person") return null;
  const { display } = data.node;
  const relationshipLabel = viewpoint && Object.hasOwn(viewpoint.relationshipLabels, data.node.personId)
    ? viewpoint.relationshipLabels[data.node.personId]
    : data.relationshipLabel;
  const years = display.birthYear === null && display.deathYear === null
    ? null
    : `${display.birthYear ?? "?"}–${display.deathYear ?? ""}`;
  const generation = display.generation?.displayed === null || display.generation === null
    ? null
    : display.generation.source === "computed"
      ? `第 ${display.generation.displayed} 代（系统推导）`
      : `第 ${display.generation.displayed} 代${display.generation.conflict ? "（与系统推导冲突）" : "（申报）"}`;
  const roleLabel = display.lineageRole === "blood" ? "本层子女"
    : display.lineageRole === "married_in" ? "配偶"
      : display.lineageRole === "associated" ? "关联成员" : null;

  return (
    <article
      className={`tree-person-node${display.lineageRole ? ` ${display.lineageRole.replace("_", "-")}` : ""}${selected ? " selected" : ""}`}
      role="group"
      aria-label={`人物：${display.displayName}`}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        (data.onActivate as (() => void) | undefined)?.();
      }}
      style={{ backgroundColor: "#ffffff", color: "#0f172a" }}
    >
      <Handle id="descent-target" type="target" position={Position.Top} isConnectable={false} />
      <Handle id="marriage-left" type="source" position={Position.Left} isConnectable={false} />
      <Handle id="marriage-right" type="source" position={Position.Right} isConnectable={false} />
      <strong className="tree-person-name" style={{ fontSize: "15px" }}>{display.displayName}</strong>
      {roleLabel && <span className="tree-lineage-role">{roleLabel}</span>}
      {relationshipLabel && <span className="tree-kinship-label">{relationshipLabel}</span>}
      {years && <span className="tree-life-years">{years}</span>}
      {generation && <span className={display.generation?.conflict ? "tree-generation conflict" : "tree-generation"}>{generation}</span>}
      {display.generationMarker && <span className="tree-generation-marker">字辈：{display.generationMarker}</span>}
      <Handle id="descent-source" type="source" position={Position.Bottom} isConnectable={false} />
    </article>
  );
}
