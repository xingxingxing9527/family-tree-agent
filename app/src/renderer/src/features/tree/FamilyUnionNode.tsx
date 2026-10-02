import React, { type JSX } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { formatPartialDate } from "../people/format-partial-date";
import type { TreeFlowNodeData } from "./layout-with-elk";

type UnionFlowNode = Node<TreeFlowNodeData, "familyUnion">;

function unionLabel(kind: "marriage" | "coParents" | "singleParent" | "unassigned", ended: boolean): string {
  if (ended) return "已结束婚姻";
  if (kind === "marriage") return "婚姻";
  if (kind === "coParents") return "双亲家庭";
  if (kind === "singleParent") return "仅录入一位父母";
  return "待分配家庭";
}

export function FamilyUnionNode({ data, selected }: NodeProps<UnionFlowNode>): JSX.Element | null {
  if (data.node.kind !== "union") return null;
  const ended = data.node.display.marriageStatus === "divorced";
  const label = unionLabel(data.node.display.kind, ended);
  return (
    <article
      className={`family-union-node${ended ? " ended" : ""}${data.node.display.kind === "unassigned" ? " warning" : ""}${selected ? " selected" : ""}`}
      role="group"
      aria-label={`家庭联合：${label}`}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        (data.onActivate as (() => void) | undefined)?.();
      }}
      style={{ backgroundColor: "#ffffff", color: "#0f172a" }}
    >
      <Handle id="descent-target" type="target" position={Position.Top} isConnectable={false} />
      <Handle id="marriage-left" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="marriage-right" type="target" position={Position.Right} isConnectable={false} />
      <span>{label}</span>
      {data.node.display.marriageStart
        ? <span className="family-union-date">开始：{formatPartialDate(data.node.display.marriageStart)}</span>
        : null}
      {data.node.display.marriageEnd
        ? <span className="family-union-date">结束：{formatPartialDate(data.node.display.marriageEnd)}</span>
        : null}
      {data.node.display.kind === "unassigned" && <span className="family-union-warning">子女归属待确认</span>}
      {data.node.display.warnings.map((warning) => <span className="sr-only" key={warning}>{warning}</span>)}
      <Handle id="descent-source" type="source" position={Position.Bottom} isConnectable={false} />
    </article>
  );
}
