import type { MutationIntent } from "../../../shared/mutations.js";
import {
  relativeTemplate,
  type RelativeIntermediaryRole,
  type RelativePathPlan,
  type RelativePathPlanInput,
  type RelativePathRole
} from "../../../shared/relative-templates.js";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import { PersonRepository, type PersonRecord } from "../../database/repositories/person-repository.js";
import { RelationRepository, type ParentChildRecord, type ParentRole } from "../../database/repositories/relation-repository.js";

export class RelativePathPlanningError extends Error {
  constructor(readonly code: "NOT_FOUND" | "VALIDATION", message: string) {
    super(message);
    this.name = "RelativePathPlanningError";
  }
}

const roleLabels: Record<RelativeIntermediaryRole, string> = {
  parent: "视角人物的父母",
  grandparent: "视角人物的祖父母",
  sibling: "视角人物的兄弟姐妹",
  collateralParent: "目标人物的父母（视角人物父母的兄弟姐妹）"
};

export class RelativePathPlanner {
  private readonly people: PersonRepository;
  private readonly relations: RelationRepository;

  constructor(database: WorkspaceDatabase, private readonly workspaceId: string) {
    this.people = new PersonRepository(database, workspaceId);
    this.relations = new RelationRepository(database, workspaceId);
  }

  plan(input: RelativePathPlanInput): RelativePathPlan {
    const template = relativeTemplate(input.templateId);
    const people = this.people.list();
    const peopleById = new Map(people.map((person) => [person.id, person]));
    const anchor = peopleById.get(input.anchorId);
    const target = peopleById.get(input.targetId);
    if (!anchor || !target) throw new RelativePathPlanningError("NOT_FOUND", "视角人物或目标人物不存在");
    if (anchor.id === target.id) throw new RelativePathPlanningError("VALIDATION", "视角人物和目标人物不能相同");
    if (template.targetGender && target.gender !== template.targetGender) {
      throw new RelativePathPlanningError("VALIDATION", `${template.label}要求目标人物的性别为${template.targetGender === "male" ? "男" : "女"}`);
    }

    const parentChild = this.relations.listParentChild();
    const resolved: Partial<Record<RelativeIntermediaryRole, string>> = {};
    const used = new Set([anchor.id, target.id]);
    const requiredSelections: RelativePathPlan["requiredSelections"] = [];
    for (const role of template.intermediaryRoles) {
      const derived = this.derivedCandidates(role, input, resolved, parentChild).filter((id) => peopleById.has(id) && !used.has(id));
      const selected = input.selectedIntermediaryIds[role];
      if (selected) {
        if (!peopleById.has(selected)) throw new RelativePathPlanningError("NOT_FOUND", `${roleLabels[role]}不存在`);
        if (used.has(selected)) throw new RelativePathPlanningError("VALIDATION", "关系路径中的人物不能重复");
        if (derived.length > 0 && !derived.includes(selected)) throw new RelativePathPlanningError("VALIDATION", `所选人物不是已知的${roleLabels[role]}`);
        resolved[role] = selected;
        used.add(selected);
        continue;
      }
      if (derived.length === 1) {
        resolved[role] = derived[0]!;
        used.add(derived[0]!);
        continue;
      }
      const candidateIds = derived.length > 0 ? derived : people.map((person) => person.id).filter((id) => !used.has(id));
      requiredSelections.push({
        role,
        label: roleLabels[role],
        candidateIds,
        reason: derived.length > 1 ? `${roleLabels[role]}有多个候选，请明确选择` : `路径中缺少${roleLabels[role]}，请选择已有的人物`
      });
      break;
    }

    const roleIds: Partial<Record<RelativePathRole, string>> = { anchor: anchor.id, target: target.id, ...resolved };
    const resultingPath = {
      personIds: template.path.map((role) => roleIds[role]).filter((id): id is string => Boolean(id)),
      forwardTerm: template.label,
      reverseTerm: template.reverseLabel
    };
    if (requiredSelections.length > 0) return { templateId: template.id, resolvedIntermediaryIds: resolved, requiredSelections, intents: [], resultingPath };

    const intents: MutationIntent[] = [];
    for (const edge of template.edges) {
      const parentId = roleIds[edge.parent];
      const childId = roleIds[edge.child];
      if (!parentId || !childId) throw new RelativePathPlanningError("VALIDATION", "关系路径缺少必要人物");
      const existing = parentChild.find((fact) => fact.parentId === parentId && fact.childId === childId);
      if (existing) continue;
      intents.push({
        type: "parentChild.add",
        draft: {
          parentId,
          childId,
          parentRole: this.parentRole(parentId, peopleById, parentChild),
          sourceDescription: `更多亲属向导：${template.label}`
        }
      });
    }
    return { templateId: template.id, resolvedIntermediaryIds: resolved, requiredSelections, intents, resultingPath };
  }

  private derivedCandidates(
    role: RelativeIntermediaryRole,
    input: RelativePathPlanInput,
    resolved: Partial<Record<RelativeIntermediaryRole, string>>,
    facts: ParentChildRecord[]
  ): string[] {
    const unique = (values: string[]): string[] => [...new Set(values)].sort();
    if (role === "parent") return unique(facts.filter((fact) => fact.childId === input.anchorId).map((fact) => fact.parentId));
    if (role === "grandparent") return resolved.parent
      ? unique(facts.filter((fact) => fact.childId === resolved.parent).map((fact) => fact.parentId))
      : [];
    if (role === "sibling") return resolved.parent
      ? unique(facts.filter((fact) => fact.parentId === resolved.parent && fact.childId !== input.anchorId).map((fact) => fact.childId))
      : [];
    return resolved.grandparent
      ? unique(facts.filter((fact) => fact.parentId === resolved.grandparent && fact.childId !== resolved.parent).map((fact) => fact.childId))
      : [];
  }

  private parentRole(parentId: string, peopleById: Map<string, PersonRecord>, facts: ParentChildRecord[]): ParentRole {
    const known = facts.find((fact) => fact.parentId === parentId)?.parentRole;
    if (known) return known;
    const gender = peopleById.get(parentId)?.gender;
    if (gender === "male") return "father";
    if (gender === "female") return "mother";
    throw new RelativePathPlanningError("VALIDATION", "新增亲子关系前，需要先补充父母人物的性别");
  }
}
