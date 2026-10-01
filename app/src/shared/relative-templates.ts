import type { MutationIntent } from "./mutations.js";

export type RelativeTemplateId = "sibling" | "grandparent" | "uncle" | "aunt" | "nibling" | "cousin";
export type RelativePathRole = "anchor" | "target" | "parent" | "grandparent" | "sibling" | "collateralParent";
export type RelativeIntermediaryRole = Exclude<RelativePathRole, "anchor" | "target">;

export interface RelativeTemplate {
  id: RelativeTemplateId;
  label: string;
  reverseLabel: string;
  targetGender: "male" | "female" | null;
  intermediaryRoles: RelativeIntermediaryRole[];
  path: RelativePathRole[];
  edges: Array<{ type: "parentChild"; parent: RelativePathRole; child: RelativePathRole }>;
}

export const RELATIVE_TEMPLATES: readonly RelativeTemplate[] = [
  {
    id: "sibling", label: "兄弟姐妹", reverseLabel: "兄弟姐妹", targetGender: null,
    intermediaryRoles: ["parent"], path: ["anchor", "parent", "target"],
    edges: [{ type: "parentChild", parent: "parent", child: "anchor" }, { type: "parentChild", parent: "parent", child: "target" }]
  },
  {
    id: "grandparent", label: "祖父母", reverseLabel: "孙子女", targetGender: null,
    intermediaryRoles: ["parent"], path: ["anchor", "parent", "target"],
    edges: [{ type: "parentChild", parent: "parent", child: "anchor" }, { type: "parentChild", parent: "target", child: "parent" }]
  },
  {
    id: "uncle", label: "叔伯/舅舅", reverseLabel: "侄子女/外甥子女", targetGender: "male",
    intermediaryRoles: ["parent", "grandparent"], path: ["anchor", "parent", "grandparent", "target"],
    edges: [
      { type: "parentChild", parent: "parent", child: "anchor" },
      { type: "parentChild", parent: "grandparent", child: "parent" },
      { type: "parentChild", parent: "grandparent", child: "target" }
    ]
  },
  {
    id: "aunt", label: "姑姑/姨妈", reverseLabel: "侄子女/外甥子女", targetGender: "female",
    intermediaryRoles: ["parent", "grandparent"], path: ["anchor", "parent", "grandparent", "target"],
    edges: [
      { type: "parentChild", parent: "parent", child: "anchor" },
      { type: "parentChild", parent: "grandparent", child: "parent" },
      { type: "parentChild", parent: "grandparent", child: "target" }
    ]
  },
  {
    id: "nibling", label: "侄子女/外甥子女", reverseLabel: "叔伯/姑姨", targetGender: null,
    intermediaryRoles: ["parent", "sibling"], path: ["anchor", "parent", "sibling", "target"],
    edges: [
      { type: "parentChild", parent: "parent", child: "anchor" },
      { type: "parentChild", parent: "parent", child: "sibling" },
      { type: "parentChild", parent: "sibling", child: "target" }
    ]
  },
  {
    id: "cousin", label: "堂表亲", reverseLabel: "堂表亲", targetGender: null,
    intermediaryRoles: ["parent", "grandparent", "collateralParent"], path: ["anchor", "parent", "grandparent", "collateralParent", "target"],
    edges: [
      { type: "parentChild", parent: "parent", child: "anchor" },
      { type: "parentChild", parent: "grandparent", child: "parent" },
      { type: "parentChild", parent: "grandparent", child: "collateralParent" },
      { type: "parentChild", parent: "collateralParent", child: "target" }
    ]
  }
] as const;

export interface RelativeSelectionRequirement {
  role: RelativeIntermediaryRole;
  label: string;
  candidateIds: string[];
  reason: string;
}

export interface RelativePathPlanInput {
  anchorId: string;
  targetId: string;
  templateId: RelativeTemplateId;
  selectedIntermediaryIds: Partial<Record<RelativeIntermediaryRole, string>>;
}

export interface RelativePathPlan {
  templateId: RelativeTemplateId;
  resolvedIntermediaryIds: Partial<Record<RelativeIntermediaryRole, string>>;
  requiredSelections: RelativeSelectionRequirement[];
  intents: MutationIntent[];
  resultingPath: { personIds: string[]; forwardTerm: string; reverseTerm: string };
}

export const relativeTemplate = (id: RelativeTemplateId): RelativeTemplate => {
  const template = RELATIVE_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`Unknown relative template: ${id}`);
  return template;
};
