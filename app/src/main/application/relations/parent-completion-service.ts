import { createHash } from "node:crypto";
import type {
  ParentCompletionCandidateDto,
  ParentCompletionEvidenceDto,
  ParentCompletionPlanDto,
  ParentCompletionRelationDto,
  ParentCompletionScanClassification,
  ParentCompletionScanDto
} from "../../../shared/contracts.js";
import type { PersonRecord } from "../../database/repositories/person-repository.js";
import type { MarriageRecord, ParentChildRecord, ParentRole } from "../../database/repositories/relation-repository.js";
import {
  ParentCompletionPlanner,
  type ParentCompletionInput,
  type ParentCompletionIssue,
  type ParentCompletionPlan
} from "../../domain/relations/parent-completion-planner.js";

export interface ParentCompletionFacts {
  listPeople(): PersonRecord[];
  listParentChild(): ParentChildRecord[];
  listMarriages(): MarriageRecord[];
}

export interface ParentCompletionRequest {
  knownParentId: string;
  childId: string;
  parentRole: ParentRole;
  selectedSpouseId?: string;
}

export interface ParentCompletionPlanningResult {
  plan: ParentCompletionPlanDto;
  /** Server-only optimistic evidence token. Never serialize this value in a public DTO. */
  planningFingerprint: string;
}

export class ParentCompletionServiceError extends Error {
  constructor(readonly code: "NOT_FOUND", message: string, readonly entityId: string) {
    super(message);
  }
}

interface Snapshot {
  people: PersonRecord[];
  parentChild: ParentChildRecord[];
  marriages: MarriageRecord[];
  peopleById: Map<string, PersonRecord>;
  parentChildById: Map<string, ParentChildRecord>;
  marriagesById: Map<string, MarriageRecord>;
  parentsByChild: Map<string, ParentChildRecord[]>;
  marriagesByPerson: Map<string, MarriageRecord[]>;
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const roleName = (role: ParentRole): string => role === "father" ? "父亲" : "母亲";

export class ParentCompletionService {
  private readonly planner = new ParentCompletionPlanner();

  constructor(private readonly facts: ParentCompletionFacts) {}

  plan(input: ParentCompletionRequest): ParentCompletionPlanningResult {
    return this.planFromSnapshot(this.snapshot(), input);
  }

  scan(): ParentCompletionScanDto {
    const snapshot = this.snapshot();
    const items = [...snapshot.parentsByChild.entries()]
      .filter(([, parents]) => parents.length === 1)
      .map(([childId, [knownParent]]) => {
        const child = this.requirePerson(snapshot, childId);
        const parent = this.requirePerson(snapshot, knownParent.parentId);
        const plan = this.planFromSnapshot(snapshot, {
          knownParentId: parent.id,
          childId: child.id,
          parentRole: knownParent.parentRole
        }).plan;
        return {
          childId: child.id,
          childName: child.displayName,
          knownParentId: parent.id,
          knownParentName: parent.displayName,
          parentRole: knownParent.parentRole,
          classification: scanClassification(plan.status),
          plan
        };
      })
      .sort((left, right) => compareText(left.childName, right.childName) || compareText(left.childId, right.childId));

    return {
      counts: {
        total: items.length,
        safe: items.filter(({ classification }) => classification === "safe").length,
        ambiguous: items.filter(({ classification }) => classification === "ambiguous").length,
        noCandidate: items.filter(({ classification }) => classification === "no-candidate").length,
        conflict: items.filter(({ classification }) => classification === "conflict").length
      },
      items
    };
  }

  private snapshot(): Snapshot {
    const people = this.facts.listPeople();
    const parentChild = this.facts.listParentChild();
    const marriages = this.facts.listMarriages();
    const parentsByChild = new Map<string, ParentChildRecord[]>();
    for (const relation of parentChild) addToIndex(parentsByChild, relation.childId, relation);
    const marriagesByPerson = new Map<string, MarriageRecord[]>();
    for (const marriage of marriages) {
      addToIndex(marriagesByPerson, marriage.spouseAId, marriage);
      addToIndex(marriagesByPerson, marriage.spouseBId, marriage);
    }
    return {
      people,
      parentChild,
      marriages,
      peopleById: new Map(people.map((person) => [person.id, person])),
      parentChildById: new Map(parentChild.map((relation) => [relation.id, relation])),
      marriagesById: new Map(marriages.map((marriage) => [marriage.id, marriage])),
      parentsByChild,
      marriagesByPerson
    };
  }

  private planFromSnapshot(snapshot: Snapshot, input: ParentCompletionRequest): ParentCompletionPlanningResult {
    this.requirePerson(snapshot, input.knownParentId);
    this.requirePerson(snapshot, input.childId);
    const marriages = snapshot.marriagesByPerson.get(input.knownParentId) ?? [];
    const existingParents = snapshot.parentsByChild.get(input.childId) ?? [];
    const relevantPersonIds = new Set<string>([input.knownParentId, input.childId]);
    for (const marriage of marriages) {
      relevantPersonIds.add(marriage.spouseAId);
      relevantPersonIds.add(marriage.spouseBId);
    }
    for (const relation of existingParents) relevantPersonIds.add(relation.parentId);
    if (input.selectedSpouseId !== undefined) relevantPersonIds.add(input.selectedSpouseId);
    const domainInput: ParentCompletionInput = {
      people: [...relevantPersonIds]
        .map((id) => snapshot.peopleById.get(id))
        .filter((person): person is PersonRecord => person !== undefined)
        .map(({ id, gender, birth }) => ({ id, gender, birth })),
      knownParentId: input.knownParentId,
      childId: input.childId,
      parentRole: input.parentRole,
      marriages,
      existingParents,
      ...(input.selectedSpouseId === undefined ? {} : { selectedSpouseId: input.selectedSpouseId })
    };
    const domainPlan = this.planner.plan(domainInput);
    const plan = this.toDto(snapshot, domainPlan);
    const planningFingerprint = createHash("sha256").update(JSON.stringify({
      request: {
        knownParentId: input.knownParentId,
        childId: input.childId,
        parentRole: input.parentRole,
        selectedSpouseId: input.selectedSpouseId ?? null
      },
      evidence: plan.evidence
    })).digest("hex");
    return { plan, planningFingerprint };
  }

  private toDto(snapshot: Snapshot, plan: ParentCompletionPlan): ParentCompletionPlanDto {
    const candidates = plan.candidates.map((candidate): ParentCompletionCandidateDto => ({
      personId: candidate.spouseId,
      personName: this.requirePerson(snapshot, candidate.spouseId).displayName,
      intervalRelation: candidate.intervalRelation,
      marriageEpisodes: candidate.marriageIds.map((id) => {
        const marriage = snapshot.marriagesById.get(id);
        if (!marriage) throw new Error(`Missing marriage evidence: ${id}`);
        return {
          id: marriage.id,
          status: marriage.status,
          start: marriage.start,
          end: marriage.end,
          rowVersion: marriage.rowVersion
        };
      }),
      reason: candidateReason(
        candidate.intervalRelation,
        plan.basis,
        plan.suggested?.parentId === candidate.spouseId
      ),
      evidenceIds: candidate.evidenceIds
    }));
    const explicit = this.relationDto(snapshot, plan.explicit);
    const suggested = plan.suggested
      ? this.relationDto(snapshot, plan.suggested, plan.suggested.inferredFromMarriageId)
      : undefined;
    return {
      status: plan.status,
      basis: plan.basis,
      explicit,
      ...(suggested ? { suggested } : {}),
      candidates,
      issues: plan.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issueMessage(snapshot, plan, issue),
        evidenceIds: issue.evidenceIds
      })),
      evidence: plan.evidenceIds.flatMap((id) => {
        const evidence = evidenceDto(snapshot, id);
        return evidence ? [evidence] : [];
      })
    };
  }

  private relationDto(
    snapshot: Snapshot,
    relation: { parentId: string; childId: string; parentRole: ParentRole },
    inferredFromMarriageId?: string | null
  ): ParentCompletionRelationDto {
    return {
      parentId: relation.parentId,
      parentName: this.requirePerson(snapshot, relation.parentId).displayName,
      childId: relation.childId,
      childName: this.requirePerson(snapshot, relation.childId).displayName,
      parentRole: relation.parentRole,
      ...(inferredFromMarriageId === undefined ? {} : { inferredFromMarriageId })
    };
  }

  private requirePerson(snapshot: Snapshot, id: string): PersonRecord {
    const person = snapshot.peopleById.get(id);
    if (!person) throw new ParentCompletionServiceError("NOT_FOUND", "人物不存在", id);
    return person;
  }
}

function addToIndex<T>(index: Map<string, T[]>, key: string, value: T): void {
  const entries = index.get(key) ?? [];
  entries.push(value);
  index.set(key, entries);
}

function scanClassification(status: ParentCompletionPlan["status"]): ParentCompletionScanClassification {
  if (status === "suggested") return "safe";
  if (status === "ambiguous") return "ambiguous";
  if (status === "no_candidate") return "no-candidate";
  return "conflict";
}

function candidateReason(
  relation: ParentCompletionCandidateDto["intervalRelation"],
  basis: ParentCompletionPlan["basis"],
  selected: boolean
): string {
  if (selected && basis === "unique_spouse") return "已确认婚姻中唯一的配偶候选";
  if (selected && basis === "administrator_selected") return "管理员从已确认婚姻配偶中选择了此人";
  if (relation === "inside") return "婚姻时间包含孩子出生时间，可作为另一位生物学父母候选";
  if (relation === "outside") return "婚姻时间明确不包含孩子出生时间";
  return "已确认婚姻配偶，但出生时间证据不足以唯一判断";
}

function issueMessage(snapshot: Snapshot, plan: ParentCompletionPlan, issue: ParentCompletionIssue): string {
  const childName = snapshot.peopleById.get(plan.explicit.childId)?.displayName ?? plan.explicit.childId;
  const knownName = snapshot.peopleById.get(plan.explicit.parentId)?.displayName ?? plan.explicit.parentId;
  const suggestedName = plan.suggested
    ? snapshot.peopleById.get(plan.suggested.parentId)?.displayName ?? plan.suggested.parentId
    : "候选人物";
  if (issue.code === "PARENT_COMPLETION_NO_CANDIDATE") return `${knownName}没有可用于补全${childName}另一位父母的已确认婚姻配偶`;
  if (issue.code === "PARENT_COMPLETION_AMBIGUOUS") return `${childName}存在多个配偶候选，婚姻和出生时间不足以唯一判断`;
  if (issue.code === "PARENT_COMPLETION_INVALID_SELECTION") return `管理员选择的人物不是${knownName}的已确认婚姻配偶`;
  if (issue.code === "PARENT_GENDER_MISMATCH") return `${suggestedName}的性别与拟补全的${plan.suggested ? roleName(plan.suggested.parentRole) : "父母角色"}不一致，请管理员核对`;
  const occupied = issue.evidenceIds
    .map((id) => snapshot.parentChildById.get(id.replace(/^parent-child:/u, "")))
    .find((relation): relation is ParentChildRecord => relation !== undefined);
  const occupiedName = occupied
    ? snapshot.peopleById.get(occupied.parentId)?.displayName ?? occupied.parentId
    : "另一人物";
  return `孩子${childName}的${plan.suggested ? roleName(plan.suggested.parentRole) : "另一位父母"}已是${occupiedName}，不能用建议候选${suggestedName}覆盖`;
}

function evidenceDto(snapshot: Snapshot, evidenceId: string): ParentCompletionEvidenceDto | null {
  const separator = evidenceId.indexOf(":");
  const kind = separator < 0 ? "" : evidenceId.slice(0, separator);
  const id = separator < 0 ? evidenceId : evidenceId.slice(separator + 1);
  if (kind === "person") {
    const person = snapshot.peopleById.get(id);
    return person ? { entityType: "person", id: person.id, rowVersion: person.rowVersion, displayName: person.displayName, birth: person.birth } : null;
  }
  if (kind === "parent-child") {
    const relation = snapshot.parentChildById.get(id);
    return relation ? { entityType: "parent_child", id: relation.id, rowVersion: relation.rowVersion, parentId: relation.parentId, childId: relation.childId, parentRole: relation.parentRole } : null;
  }
  if (kind === "marriage") {
    const marriage = snapshot.marriagesById.get(id);
    return marriage ? {
      entityType: "marriage",
      id: marriage.id,
      rowVersion: marriage.rowVersion,
      spouseAId: marriage.spouseAId,
      spouseBId: marriage.spouseBId,
      status: marriage.status,
      start: marriage.start,
      end: marriage.end
    } : null;
  }
  return null;
}
