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
  const ageLabel = typeof data.ageLabel === "string" ? data.ageLabel : null;
  const lifeSummary = [years, ageLabel].filter(Boolean).join(" · ");
  const generation = display.generation?.displayed === null || display.generation === null
    ? null
    : display.generation.source === "computed"
      ? `第 ${display.generation.displayed} 代（系统推导）`
      : `第 ${display.generation.displayed} 代${display.generation.conflict ? "（与系统推导冲突）" : "（申报）"}`;
  const roleLabel = display.lineageRole === "blood" ? "本层子女"
    : display.lineageRole === "married_in" ? "配偶"
      : display.lineageRole === "associated" ? "关联成员" : null;
  const gender = display.gender ?? "unknown";
  const genderLabel = gender === "male" ? "男" : gender === "female" ? "女" : "未知";
  const metadata = [lifeSummary, generation, display.generationMarker ? `字辈：${display.generationMarker}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      className={`tree-person-node gender-${gender}${display.lineageRole ? ` ${display.lineageRole.replace("_", "-")}` : ""}${selected ? " selected" : ""}`}
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
      <header className="tree-person-heading">
        <span className="tree-person-avatar" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <circle cx="12" cy="8" r="4" />
            <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
          </svg>
        </span>
        <strong className="tree-person-name" style={{ fontSize: "15px" }}>{display.displayName}</strong>
        <span className="tree-gender-badge" aria-label={`性别：${genderLabel}`}>{genderLabel}</span>
      </header>
      {(roleLabel || relationshipLabel?.displayTerm) && <span className="tree-person-tags">
        {roleLabel && <span className="tree-lineage-role">{roleLabel}</span>}
        {relationshipLabel?.displayTerm && <span className="tree-kinship-label">{relationshipLabel.displayTerm}</span>}
      </span>}
      {relationshipLabel?.regionalTerm && relationshipLabel.formalTerm && <span className="tree-kinship-formal">正式关系：{relationshipLabel.formalTerm}</span>}
      {metadata && <span className={display.generation?.conflict ? "tree-person-metadata conflict" : "tree-person-metadata"} title={metadata}>{metadata}</span>}
      <Handle id="descent-source" type="source" position={Position.Bottom} isConnectable={false} />
    </article>
  );
}
