import { randomUUID } from "node:crypto";
import { conversationMutationDraftSchema, type ConversationConfirmationReceipt, type ConversationDraftChangeDto, type ConversationDraftPreview, type ConversationMutationDraft } from "../../../shared/chat.js";
import type { ParentCompletionPlanDto, PersonCandidate } from "../../../shared/contracts.js";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import type { PersonRecord } from "../../database/repositories/person-repository.js";
import { createUnitOfWork, type TransactionContext } from "../../database/unit-of-work.js";
import { FactCommandError, FactCommandService } from "../facts/fact-command-service.js";
import type { FactCommand } from "../facts/fact-commands.js";
import { FactQueries } from "../facts/fact-queries.js";
import type { ModelAdapter } from "../../llm/model-adapter.js";
import { validateMarriageFact, validateParentChildFact } from "../../domain/validation/fact-validator.js";
import { validatePartialDate, type DomainIssue } from "../../domain/validation/partial-date-validator.js";
import {
  ParentCompletionService,
  type ParentCompletionPlanningResult,
  type ParentCompletionRequest
} from "../relations/parent-completion-service.js";
import { selectRelevantCandidates } from "./context-minimizer.js";

type DraftStatus = "active" | "superseded" | "confirmed" | "invalidated";
interface InternalChange {
  public: ConversationDraftChangeDto;
  expectedVersion?: number;
  readVersions: Readonly<Record<string, number>>;
  command(expectedVersions: Readonly<Record<string, number>>): FactCommand;
}
interface StoredParentCompletionReadVersion {
  entityType: "person" | "parent_child" | "marriage";
  id: string;
  rowVersion: number;
}
interface StoredParentCompletionPlan {
  input: ParentCompletionRequest;
  expected: ParentCompletionPlanningResult;
  prospectivePeople: readonly PersonRecord[];
  readVersions: readonly StoredParentCompletionReadVersion[];
  explicitChangeId: string | null;
  warningChangeId: string | null;
}
interface IssueFingerprint { changeId: string; severity: "warning" | "conflict"; code: string; message: string; occurrence: number; }
interface PlanValidation { fingerprints: IssueFingerprint[]; }
interface StoredDraft {
  preview: ConversationDraftPreview;
  changes: Map<string, InternalChange>;
  expectedVersions: Readonly<Record<string, number>>;
  fingerprints: readonly IssueFingerprint[];
  parentCompletionPlans: readonly StoredParentCompletionPlan[];
  status: DraftStatus;
}

export class DraftValidationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "DraftValidationError"; }
}

const normalize = (value: string): string => value.trim().toLocaleLowerCase();
const equalJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const parentRoleName = (role: "father" | "mother"): string => role === "father" ? "父亲" : "母亲";
const complementaryRole = (role: "father" | "mother"): "father" | "mother" => role === "father" ? "mother" : "father";
const completionBasisName = (basis: ParentCompletionPlanDto["basis"]): string => {
  if (basis === "unique_spouse") return "唯一已确认配偶";
  if (basis === "birth_interval") return "孩子出生时间与婚姻区间唯一匹配";
  if (basis === "administrator_selected") return "管理员指定的已确认配偶";
  return "已确认婚姻关系";
};
const completionReason = (plan: ParentCompletionPlanDto): string => {
  if (plan.status === "unchanged" && plan.suggested) {
    return `${plan.suggested.parentName}已是${plan.suggested.childName}的${parentRoleName(plan.suggested.parentRole)}，无需变更`;
  }
  if (["no_candidate", "ambiguous", "conflict"].includes(plan.status) && plan.issues[0]) return plan.issues[0].message;
  const suggestedCandidate = plan.suggested
    ? plan.candidates.find((candidate) => candidate.personId === plan.suggested?.parentId)
    : undefined;
  if (suggestedCandidate) return suggestedCandidate.reason;
  if (plan.issues[0]) return plan.issues[0].message;
  return "根据已确认婚姻关系检查另一位父母";
};
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
};
const existingEdgesForPerson = (edges: ReadonlyArray<{ parentId: string; childId: string }>, personId: string): string[] => edges.flatMap((edge) => {
  if (edge.parentId === personId) return [edge.childId];
  if (edge.childId === personId) return [edge.parentId];
  return [];
});
class PlanRollback extends Error {
  constructor(readonly validation: PlanValidation) { super("Rollback prospective draft validation"); }
}

export class DraftService {
  private readonly drafts = new Map<string, StoredDraft>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly workspaceId: string,
    private readonly model?: ModelAdapter,
    options: { now?: () => number; ttlMs?: number } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
  }

  async stageFromText(text: string, candidatePeople: PersonCandidate[]): Promise<ConversationDraftPreview> {
    if (!this.model) throw new DraftValidationError("MODEL_UNAVAILABLE", "No model adapter is configured");
    return this.stage(await this.model.extractDraft({ text, candidatePeople: selectRelevantCandidates(text, candidatePeople) }));
  }

  stage(draft: ConversationMutationDraft, version = 1): ConversationDraftPreview {
    this.evictTerminalDrafts();
    draft = deepFreeze(conversationMutationDraftSchema.parse(structuredClone(draft)));
    this.ensureUniqueReferences(draft);
    const queries = new FactQueries(this.database, this.workspaceId);
    const existing = queries.listPeople();
    const existingById = new Map(existing.map((person) => [person.id, person]));
    const id = randomUUID();
    const internal: InternalChange[] = [];
    const stagedVersions: Record<string, number> = {};
    const warnings: Array<{ code: string; message: string }> = [];
    const conflicts: Array<{ code: string; message: string }> = [];
    const parentCompletionWarnings: IssueFingerprint[] = [];
    const parentCompletionPlans: StoredParentCompletionPlan[] = [];
    const unresolved = draft.unresolvedReferences.map((entry) => ({ ...entry, candidatePersonIds: [...entry.candidatePersonIds] }));
    const resolved = new Map<string, { entityId: string; dependencyId?: string; person: PersonRecord }>();
    const existingReferenceByPersonId = new Map<string, string>();
    const snapshotVersions = (personIds: readonly string[]): Readonly<Record<string, number>> => Object.freeze(Object.fromEntries(
      [...new Set(personIds)].flatMap((personId) => {
        const person = existingById.get(personId);
        return person ? [[personId, person.rowVersion] as const] : [];
      })
    ));
    const addIssues = (issues: DomainIssue[], target: Array<{ code: string; message: string }>): void => {
      for (const entry of issues) if (!target.some((known) => known.code === entry.code && known.message === entry.message)) target.push({ code: entry.code, message: entry.message });
    };

    for (const candidate of draft.candidatePeople) {
      const stated = new Set(candidate.statedFields);
      if (stated.size !== candidate.statedFields.length) throw new DraftValidationError("DUPLICATE_FIELD_INTENT", "Person field intents must be unique");
      for (const [field, date] of [["birth", candidate.birth], ["death", candidate.death]] as const) if (stated.has(field) && date) addIssues(validatePartialDate(date).errors, conflicts);
      let match = candidate.matchedPersonId ? existing.find((person) => person.id === candidate.matchedPersonId) : undefined;
      if (candidate.matchedPersonId && !match) {
        unresolved.push({ reference: candidate.referenceId, candidatePersonIds: [], reason: "The selected person no longer exists" });
        continue;
      }
      if (!candidate.matchedPersonId) {
        const target = normalize(candidate.displayName);
        const matches = existing.filter((person) => normalize(person.displayName) === target || queries.listAliases(person.id).some((alias) => normalize(alias.name) === target));
        if (matches.length > 1) {
          unresolved.push({ reference: candidate.referenceId, candidatePersonIds: matches.map((person) => person.id), reason: "Multiple people have the same name" });
          continue;
        }
        match = matches[0];
      }
      if (match) {
        const priorReference = existingReferenceByPersonId.get(match.id);
        if (priorReference && priorReference !== candidate.referenceId) {
          throw new DraftValidationError("DUPLICATE_EXISTING_PERSON_REFERENCE", "Multiple candidate references resolve to the same existing person");
        }
        existingReferenceByPersonId.set(match.id, candidate.referenceId);
      }
      if (!match) {
        if (!stated.has("displayName") || !stated.has("gender")) throw new DraftValidationError("MISSING_IDENTITY", "A new person requires explicit display name and gender fields");
        const entityId = randomUUID();
        const changeId = randomUUID();
        const timestamp = new Date(this.now()).toISOString();
        resolved.set(candidate.referenceId, {
          entityId,
          dependencyId: changeId,
          person: {
            id: entityId,
            workspaceId: this.workspaceId,
            personCode: `draft:${entityId}`,
            displayName: candidate.displayName,
            gender: candidate.gender,
            birth: candidate.birth,
            death: candidate.death,
            notes: candidate.notes,
            createdAt: timestamp,
            updatedAt: timestamp,
            deletedAt: null,
            rowVersion: 0,
            childrenComplete: false
          }
        });
        internal.push({
          public: {
            id: changeId, kind: "create", entityType: "person", entityId, summary: `创建人物 ${candidate.displayName}`, dependsOnChangeIds: [],
            originKind: "explicit", selectedByDefault: true,
            fieldChanges: [
              { field: "displayName", before: null, after: candidate.displayName }, { field: "aliases", before: [], after: candidate.aliases },
              { field: "gender", before: null, after: candidate.gender }, { field: "birth", before: null, after: candidate.birth },
              { field: "death", before: null, after: candidate.death }, { field: "notes", before: null, after: candidate.notes }
            ]
          },
          readVersions: Object.freeze({}),
          command: () => ({
            type: "person.create",
            draft: { id: entityId, workspaceId: this.workspaceId, displayName: candidate.displayName, aliases: candidate.aliases, gender: candidate.gender, birth: candidate.birth, death: candidate.death, notes: candidate.notes },
            source: this.source(id, changeId, draft, "对话录入")
          })
        });
        continue;
      }
      const aliases = queries.listAliases(match.id).map((alias) => alias.name).sort();
      const merged = {
        displayName: stated.has("displayName") ? candidate.displayName : match.displayName,
        aliases: stated.has("aliases") ? [...candidate.aliases] : aliases,
        gender: stated.has("gender") ? candidate.gender : match.gender,
        birth: stated.has("birth") ? candidate.birth : match.birth,
        death: stated.has("death") ? candidate.death : match.death,
        notes: stated.has("notes") ? candidate.notes : match.notes
      };
      const changed = match.displayName !== merged.displayName || match.gender !== merged.gender
        || !equalJson(match.birth, merged.birth) || !equalJson(match.death, merged.death)
        || match.notes !== merged.notes || !equalJson(aliases, [...merged.aliases].sort());
      if (changed) {
        stagedVersions[match.id] = match.rowVersion;
        const changeId = randomUUID();
        const fieldChanges = [
          ["displayName", match.displayName, merged.displayName], ["aliases", aliases, merged.aliases], ["gender", match.gender, merged.gender],
          ["birth", match.birth, merged.birth], ["death", match.death, merged.death], ["notes", match.notes, merged.notes]
        ].filter(([field, before, after]) => stated.has(field as never) && !equalJson(before, after)).map(([field, before, after]) => ({ field: field as string, before, after }));
        internal.push({
          public: {
            id: changeId, kind: "update", entityType: "person", entityId: match.id, summary: `更新人物 ${candidate.displayName}`,
            dependsOnChangeIds: [], originKind: "explicit", selectedByDefault: true, fieldChanges
          },
          expectedVersion: match.rowVersion,
          readVersions: snapshotVersions([match.id, ...existingEdgesForPerson(queries.listParentChild(), match.id)]),
          command: (versions) => ({
            type: "person.update", personId: match!.id, expectedVersion: versions[match!.id]!,
            patch: Object.fromEntries(fieldChanges.map((change) => [change.field, change.after])),
            source: this.source(id, changeId, draft, "对话修订")
          })
        });
        resolved.set(candidate.referenceId, {
          entityId: match.id,
          dependencyId: changeId,
          person: { ...match, ...merged }
        });
      } else {
        resolved.set(candidate.referenceId, { entityId: match.id, person: { ...match, ...merged } });
      }
    }

    const candidateByRef = new Map(draft.candidatePeople.map((candidate) => [candidate.referenceId, candidate]));
    const existingEdges = queries.listParentChild().map((edge) => ({ parentId: edge.parentId, childId: edge.childId }));
    const prospectivePeople = [...new Map([...resolved.values()].map(({ person }) => [person.id, person])).values()];
    const dependencyByPersonId = new Map([...resolved.values()].flatMap(({ entityId, dependencyId }) =>
      dependencyId ? [[entityId, dependencyId] as const] : []));
    const prospectiveFact = (reference: string) => {
      const candidate = candidateByRef.get(reference); const resolution = resolved.get(reference);
      return candidate && resolution ? { id: resolution.entityId, workspaceId: this.workspaceId, birth: resolution.person.birth } : null;
    };
    const planCompletion = (input: ParentCompletionRequest): ParentCompletionPlanningResult =>
      this.planParentCompletion(queries, prospectivePeople, input);
    const storeCompletionPlan = (
      input: ParentCompletionRequest,
      expected: ParentCompletionPlanningResult,
      explicitChangeId: string | undefined,
      warningChangeId: string | null
    ): void => {
      const readVersions = expected.plan.evidence.flatMap((entry): StoredParentCompletionReadVersion[] => {
        if (entry.entityType === "person" && !existingById.has(entry.id)) return [];
        return [{ entityType: entry.entityType, id: entry.id, rowVersion: entry.rowVersion }];
      });
      parentCompletionPlans.push({
        input: Object.freeze({ ...input }),
        expected: deepFreeze(structuredClone(expected)),
        prospectivePeople: deepFreeze(structuredClone(prospectivePeople)),
        readVersions: Object.freeze(readVersions.map((entry) => Object.freeze({ ...entry }))),
        explicitChangeId: explicitChangeId ?? null,
        warningChangeId
      });
    };
    const completionDependencies = (explicitChangeId: string | undefined, plan: ParentCompletionPlanDto): string[] => [...new Set([
      ...(explicitChangeId ? [explicitChangeId] : []),
      ...plan.evidence.flatMap((entry) => entry.entityType === "person"
        ? [dependencyByPersonId.get(entry.id)].filter((value): value is string => Boolean(value))
        : [])
    ])];
    const completionReadVersions = (plan: ParentCompletionPlanDto): Readonly<Record<string, number>> => snapshotVersions(
      plan.evidence.flatMap((entry) => entry.entityType === "person" ? [entry.id] : [])
    );
    const addCompletionWarnings = (changeId: string, plan: ParentCompletionPlanDto): void => {
      const occurrences = new Map<string, number>();
      for (const issue of plan.issues.filter(({ severity }) => severity === "warning")) {
        const occurrence = (occurrences.get(issue.code) ?? 0) + 1;
        occurrences.set(issue.code, occurrence);
        parentCompletionWarnings.push({ changeId, severity: "warning", code: issue.code, message: issue.message, occurrence });
      }
    };
    const plannedEdges = [...existingEdges];
    for (const relation of draft.parentChildFacts) {
      const parent = resolved.get(relation.parentRef); const child = resolved.get(relation.childRef);
      if (!parent || !child) { this.addMissing(unresolved, !parent ? relation.parentRef : relation.childRef); continue; }
      const occupiedExplicitRole = queries.listParentChild().find((edge) => edge.childId === child.entityId && edge.parentRole === relation.parentRole);
      const explicitAlreadyConfirmed = occupiedExplicitRole?.parentId === parent.entityId;
      const validation = validateParentChildFact(prospectiveFact(relation.parentRef)!, prospectiveFact(relation.childRef)!, plannedEdges);
      addIssues(validation.errors, conflicts); addIssues(validation.warnings, warnings);
      if (occupiedExplicitRole && !explicitAlreadyConfirmed) {
        addIssues([{ code: "PARENT_ROLE_OCCUPIED", message: `The child already has an active biological ${relation.parentRole}` }], conflicts);
      }
      let explicitChange: InternalChange | undefined;
      if (!explicitAlreadyConfirmed) {
        plannedEdges.push({ parentId: parent.entityId, childId: child.entityId });
        const changeId = randomUUID();
        const entityId = randomUUID();
        explicitChange = {
          public: {
            id: changeId, kind: "create", entityType: "parentChild", entityId,
            summary: `${parent.person.displayName} → ${child.person.displayName}：${parentRoleName(relation.parentRole)}`,
            originKind: "explicit", selectedByDefault: true,
            dependsOnChangeIds: [parent.dependencyId, child.dependencyId].filter((value): value is string => Boolean(value)),
            fieldChanges: [{ field: "parentId", before: null, after: parent.entityId }, { field: "childId", before: null, after: child.entityId }, { field: "parentRole", before: null, after: relation.parentRole }]
          },
          readVersions: snapshotVersions([parent.entityId, child.entityId]),
          command: () => ({
            type: "parentChild.add",
            draft: {
              id: entityId,
              workspaceId: this.workspaceId,
              parentId: parent.entityId,
              childId: child.entityId,
              parentRole: relation.parentRole,
              originKind: "explicit",
              inferredFromMarriageId: null
            },
            source: this.source(id, changeId, draft, "对话亲子事实", relation.sourceRef)
          })
        };
        internal.push(explicitChange);
      }
      const explicitChangeId = explicitChange?.public.id;
      const selectionGroupId = explicitChangeId ?? randomUUID();

      const explicitComplement = draft.parentChildFacts.some((candidate) => {
        if (candidate === relation || candidate.parentRole !== complementaryRole(relation.parentRole)) return false;
        const candidateChild = resolved.get(candidate.childRef);
        const candidateParent = resolved.get(candidate.parentRef);
        return Boolean(candidateChild && candidateParent && candidateChild.entityId === child.entityId);
      });
      if (explicitComplement) {
        if (explicitChange) {
          explicitChange.public.parentCompletion = {
            status: "unchanged",
            basis: null,
            reason: `${child.person.displayName}的另一位父母已在本次草稿中明确录入，不再自动补全`,
            candidates: []
          };
        }
        continue;
      }

      const input: ParentCompletionRequest = {
        knownParentId: parent.entityId,
        childId: child.entityId,
        parentRole: relation.parentRole
      };
      const planning = planCompletion(input);
      const plan = planning.plan;
      if (plan.status === "suggested" && plan.suggested) {
        const automaticId = randomUUID();
        const automaticEntityId = randomUUID();
        storeCompletionPlan(input, planning, explicitChangeId, automaticId);
        addCompletionWarnings(automaticId, plan);
        internal.push({
          public: {
            id: automaticId,
            kind: "create",
            entityType: "parentChild",
            entityId: automaticEntityId,
            summary: `${plan.suggested.parentName} → ${plan.suggested.childName}：${parentRoleName(plan.suggested.parentRole)}（依据：${completionBasisName(plan.basis)}）`,
            originKind: "spouse_default",
            selectedByDefault: true,
            dependsOnChangeIds: completionDependencies(explicitChangeId, plan),
            parentCompletion: {
              status: plan.status,
              basis: plan.basis,
              reason: completionReason(plan),
              candidatePersonId: plan.suggested.parentId,
              candidates: plan.candidates
            },
            fieldChanges: [
              { field: "parentId", before: null, after: plan.suggested.parentId },
              { field: "childId", before: null, after: plan.suggested.childId },
              { field: "parentRole", before: null, after: plan.suggested.parentRole }
            ]
          },
          readVersions: completionReadVersions(plan),
          command: () => ({
            type: "parentChild.add",
            draft: {
              id: automaticEntityId,
              workspaceId: this.workspaceId,
              parentId: plan.suggested!.parentId,
              childId: plan.suggested!.childId,
              parentRole: plan.suggested!.parentRole,
              originKind: "spouse_default",
              inferredFromMarriageId: plan.suggested!.inferredFromMarriageId ?? null
            },
            source: this.source(id, automaticId, draft, "根据已确认婚姻自动补全")
          })
        });
        continue;
      }

      storeCompletionPlan(input, planning, explicitChangeId, null);

      if (explicitChange) {
        explicitChange.public.parentCompletion = {
          status: plan.status,
          basis: plan.basis,
          reason: completionReason(plan),
          candidates: plan.candidates
        };
      }
      if (plan.status !== "ambiguous") continue;

      for (const candidate of plan.candidates) {
        const candidateInput: ParentCompletionRequest = { ...input, selectedSpouseId: candidate.personId };
        const candidatePlanning = planCompletion(candidateInput);
        const selectedPlan = candidatePlanning.plan;
        const automaticId = randomUUID();
        storeCompletionPlan(
          candidateInput,
          candidatePlanning,
          explicitChangeId,
          selectedPlan.status === "suggested" && selectedPlan.suggested ? automaticId : null
        );
        if (selectedPlan.status !== "suggested" || !selectedPlan.suggested) continue;
        const automaticEntityId = randomUUID();
        addCompletionWarnings(automaticId, selectedPlan);
        internal.push({
          public: {
            id: automaticId,
            kind: "create",
            entityType: "parentChild",
            entityId: automaticEntityId,
            summary: `${selectedPlan.suggested.parentName} → ${selectedPlan.suggested.childName}：${parentRoleName(selectedPlan.suggested.parentRole)}（管理员候选）`,
            originKind: "spouse_default",
            selectedByDefault: false,
            selectionGroupId,
            dependsOnChangeIds: completionDependencies(explicitChangeId, selectedPlan),
            parentCompletion: {
              status: selectedPlan.status,
              basis: selectedPlan.basis,
              reason: candidate.reason,
              candidatePersonId: candidate.personId,
              candidates: plan.candidates
            },
            fieldChanges: [
              { field: "parentId", before: null, after: selectedPlan.suggested.parentId },
              { field: "childId", before: null, after: selectedPlan.suggested.childId },
              { field: "parentRole", before: null, after: selectedPlan.suggested.parentRole }
            ]
          },
          readVersions: completionReadVersions(selectedPlan),
          command: () => ({
            type: "parentChild.add",
            draft: {
              id: automaticEntityId,
              workspaceId: this.workspaceId,
              parentId: selectedPlan.suggested!.parentId,
              childId: selectedPlan.suggested!.childId,
              parentRole: selectedPlan.suggested!.parentRole,
              originKind: "spouse_default",
              inferredFromMarriageId: selectedPlan.suggested!.inferredFromMarriageId ?? null
            },
            source: this.source(id, automaticId, draft, "根据管理员选择的已确认婚姻配偶自动补全")
          })
        });
      }
    }
    for (const marriage of draft.marriages) {
      const spouseA = resolved.get(marriage.spouseARef); const spouseB = resolved.get(marriage.spouseBRef);
      if (!spouseA || !spouseB) { this.addMissing(unresolved, !spouseA ? marriage.spouseARef : marriage.spouseBRef); continue; }
      const validation = validateMarriageFact(prospectiveFact(marriage.spouseARef)!, prospectiveFact(marriage.spouseBRef)!);
      addIssues(validation.errors, conflicts); addIssues(validation.warnings, warnings);
      if (queries.listMarriages().some((entry) => entry.status === "active" && [entry.spouseAId, entry.spouseBId].some((id) => id === spouseA.entityId || id === spouseB.entityId))) {
        addIssues([{ code: "ACTIVE_MARRIAGE_EXISTS", message: "Each spouse must end their active marriage before starting another" }], conflicts);
      }
      const changeId = randomUUID(); const entityId = randomUUID();
      internal.push({
        public: {
          id: changeId, kind: "create", entityType: "marriage", entityId, summary: "创建婚姻关系",
          originKind: "explicit", selectedByDefault: true,
          dependsOnChangeIds: [spouseA.dependencyId, spouseB.dependencyId].filter((value): value is string => Boolean(value)),
          fieldChanges: [{ field: "spouseAId", before: null, after: spouseA.entityId }, { field: "spouseBId", before: null, after: spouseB.entityId }, { field: "start", before: null, after: marriage.start }]
        },
        readVersions: snapshotVersions([spouseA.entityId, spouseB.entityId]),
        command: () => ({
          type: "marriage.add", draft: { id: entityId, workspaceId: this.workspaceId, spouseAId: spouseA.entityId, spouseBId: spouseB.entityId, start: marriage.start },
          source: this.source(id, changeId, draft, "对话婚姻事实", marriage.sourceRef)
        })
      });
    }

    const canonicalValidation = this.validatePreviewPlan(internal, stagedVersions);
    const canonicalFingerprints = [...canonicalValidation.fingerprints, ...parentCompletionWarnings];
    warnings.splice(0, warnings.length, ...canonicalFingerprints.filter((entry) => entry.severity === "warning"));
    conflicts.splice(0, conflicts.length, ...canonicalFingerprints.filter((entry) => entry.severity === "conflict"));

    const preview = deepFreeze<ConversationDraftPreview>({
      id, workspaceId: this.workspaceId, version, expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      changes: internal.map((change) => change.public),
      creates: internal.filter((change) => change.public.kind === "create").length,
      updates: internal.filter((change) => change.public.kind === "update").length,
      warnings, conflicts, unresolvedReferences: unresolved
    });
    this.drafts.set(id, {
      preview,
      changes: new Map(internal.map((change) => [change.public.id, change])),
      expectedVersions: Object.freeze({ ...stagedVersions }),
      fingerprints: Object.freeze(canonicalFingerprints.map((entry) => Object.freeze({ ...entry }))),
      parentCompletionPlans: Object.freeze(parentCompletionPlans.map((plan) => Object.freeze(plan))),
      status: "active"
    });
    return preview;
  }

  revise(draftId: string, replacement: ConversationMutationDraft): ConversationDraftPreview {
    const current = this.requireDraft(draftId);
    this.ensureActive(current);
    if (Date.parse(current.preview.expiresAt) < this.now()) throw new DraftValidationError("EXPIRED", "Draft has expired");
    const revised = this.stage(replacement, current.preview.version + 1);
    current.status = "superseded";
    return revised;
  }

  confirm(draftId: string, draftVersion: number, selectedChangeIds: string[], expectedVersions: Readonly<Record<string, number>>, acknowledgedWarningCodes: string[]): ConversationConfirmationReceipt {
    const stored = this.requireDraft(draftId);
    this.ensureActive(stored);
    if (Date.parse(stored.preview.expiresAt) < this.now()) throw new DraftValidationError("EXPIRED", "Draft has expired");
    if (stored.preview.version !== draftVersion) throw new DraftValidationError("VERSION_CONFLICT", "Draft version does not match the confirmation");
    if (stored.preview.unresolvedReferences.length > 0) throw new DraftValidationError("UNRESOLVED_REFERENCES", "Draft contains unresolved references");
    const selected = new Set(selectedChangeIds);
    if (selected.size === 0) throw new DraftValidationError("INVALID_SELECTION", "Select at least one change to confirm");
    if (selected.size !== selectedChangeIds.length || [...selected].some((id) => !stored.changes.has(id))) throw new DraftValidationError("INVALID_SELECTION", "Unknown or duplicate change selection");
    for (const changeId of selected) {
      const change = stored.changes.get(changeId)!;
      if (change.public.dependsOnChangeIds.some((dependency) => !selected.has(dependency))) throw new DraftValidationError("MISSING_DEPENDENCY", "Selected changes have an invalid dependency subset");
      if (change.expectedVersion !== undefined) {
        const current = new FactQueries(this.database, this.workspaceId).getPerson(change.public.entityId);
        if (!current || expectedVersions[change.public.entityId] !== current.rowVersion || current.rowVersion !== change.expectedVersion) {
          throw new DraftValidationError("VERSION_CONFLICT", "Expected row version does not match the current person version");
        }
      }
    }
    const selectedChanges = [...stored.changes.values()].filter((change) => selected.has(change.public.id));
    const selectedGroups = new Map<string, number>();
    for (const change of selectedChanges) {
      if (!change.public.selectionGroupId) continue;
      selectedGroups.set(change.public.selectionGroupId, (selectedGroups.get(change.public.selectionGroupId) ?? 0) + 1);
    }
    if ([...selectedGroups.values()].some((count) => count > 1)) {
      throw new DraftValidationError("INVALID_SELECTION", "At most one parent-completion candidate may be selected");
    }
    const expectedFingerprints = stored.fingerprints.filter((entry) => selected.has(entry.changeId));
    if (expectedFingerprints.some((entry) => entry.severity === "conflict")) throw new DraftValidationError("CONFLICT", "Selected draft changes contain conflicts");
    const requiredWarnings = [...new Set(expectedFingerprints.filter((entry) => entry.severity === "warning").map((entry) => entry.code))].sort();
    const acknowledged = [...new Set(acknowledgedWarningCodes)].sort();
    if (acknowledged.length !== acknowledgedWarningCodes.length || !equalJson(requiredWarnings, acknowledged)) {
      throw new DraftValidationError("WARNING_ACK_REQUIRED", "Every selected draft warning must be explicitly acknowledged");
    }
    const warningChangeIds = new Set(expectedFingerprints.filter((entry) => entry.severity === "warning").map((entry) => entry.changeId));
    const service = new FactCommandService(this.database, this.workspaceId);
    const result = createUnitOfWork(this.database, this.workspaceId).run("conversation.confirm", (ctx) => {
      const currentQueries = new FactQueries(this.database, this.workspaceId);
      const currentCompletionWarnings = this.requireFreshParentCompletionPlans(currentQueries, stored.parentCompletionPlans, selected);
      for (const change of selectedChanges) for (const [personId, rowVersion] of Object.entries(change.readVersions)) {
        if (currentQueries.getPerson(personId)?.rowVersion !== rowVersion) throw new DraftValidationError("VERSION_CONFLICT", "A person read by the draft changed; restage before confirmation");
      }
      const currentValidation = this.validatePlanInSavepoint(ctx, selectedChanges, stored.expectedVersions);
      if (!this.sameFingerprints(expectedFingerprints, [...currentValidation.fingerprints, ...currentCompletionWarnings])) {
        throw new DraftValidationError("VERSION_CONFLICT", "Draft validation changed; restage before confirmation");
      }
      const changedEntityIds: string[] = [];
      for (const change of selectedChanges) {
        changedEntityIds.push(...service.executeInTransaction(ctx, change.command(expectedVersions), { confirmWarnings: warningChangeIds.has(change.public.id) }).changedEntityIds);
      }
      return { operationGroupId: ctx.operationGroupId, changedEntityIds };
    });
    stored.status = "confirmed";
    return { draftId, ...result };
  }

  invalidate(): void { for (const draft of this.drafts.values()) if (draft.status === "active") draft.status = "invalidated"; }

  private requireDraft(id: string): StoredDraft {
    const draft = this.drafts.get(id);
    if (!draft) throw new DraftValidationError("NOT_FOUND", "Draft was not found in this workspace");
    return draft;
  }
  private ensureActive(draft: StoredDraft): void {
    if (draft.status !== "active") throw new DraftValidationError(draft.status.toUpperCase(), `Draft is ${draft.status}`);
  }
  private addMissing(unresolved: ConversationMutationDraft["unresolvedReferences"], reference: string): void {
    if (!unresolved.some((entry) => entry.reference === reference)) unresolved.push({ reference, candidatePersonIds: [], reason: "Referenced person was not resolved" });
  }
  private source(draftId: string, changeId: string, draft: ConversationMutationDraft, fallback: string, sourceRef?: string | null) {
    const source = sourceRef ? draft.sources.find((entry) => entry.referenceId === sourceRef) : undefined;
    return { sourceKey: `conversation:${draftId}:${changeId}`, title: source?.title ?? fallback, kind: source?.kind ?? "conversation", citation: source?.citation ?? undefined };
  }

  private ensureUniqueReferences(draft: ConversationMutationDraft): void {
    for (const [kind, values] of [["candidate", draft.candidatePeople.map((entry) => entry.referenceId)], ["source", draft.sources.map((entry) => entry.referenceId)]] as const) {
      if (new Set(values).size !== values.length) throw new DraftValidationError("DUPLICATE_REFERENCE", `Duplicate ${kind} reference IDs are not allowed`);
    }
  }

  private evictTerminalDrafts(): void {
    for (const [id, draft] of this.drafts) if (draft.status !== "active" || Date.parse(draft.preview.expiresAt) < this.now()) this.drafts.delete(id);
  }

  private planParentCompletion(
    queries: FactQueries,
    prospectivePeople: readonly PersonRecord[],
    input: ParentCompletionRequest
  ): ParentCompletionPlanningResult {
    const people = new Map(queries.listPeople().map((person) => [person.id, person]));
    for (const person of prospectivePeople) people.set(person.id, person);
    return new ParentCompletionService({
      listPeople: () => [...people.values()],
      listParentChild: () => queries.listParentChild(),
      // Deliberately persisted-only: an unconfirmed marriage from this conversation is not evidence.
      listMarriages: () => queries.listMarriages()
    }).plan(input);
  }

  private requireFreshParentCompletionPlans(
    queries: FactQueries,
    plans: readonly StoredParentCompletionPlan[],
    selectedChangeIds: ReadonlySet<string>
  ): IssueFingerprint[] {
    const warnings: IssueFingerprint[] = [];
    const currentParents = new Map(queries.listParentChild().map((entry) => [entry.id, entry]));
    const currentMarriages = new Map(queries.listMarriages().map((entry) => [entry.id, entry]));
    for (const stored of plans) {
      for (const evidence of stored.readVersions) {
        const currentVersion = evidence.entityType === "person"
          ? queries.getPerson(evidence.id)?.rowVersion
          : evidence.entityType === "parent_child"
            ? currentParents.get(evidence.id)?.rowVersion
            : currentMarriages.get(evidence.id)?.rowVersion;
        if (currentVersion !== evidence.rowVersion) {
          throw new DraftValidationError("VERSION_CONFLICT", "父母补全读取的数据在预览后发生变化，请刷新后重试");
        }
      }
      const current = this.planParentCompletion(queries, stored.prospectivePeople, stored.input);
      if (current.planningFingerprint !== stored.expected.planningFingerprint || !equalJson(current.plan, stored.expected.plan)) {
        throw new DraftValidationError("VERSION_CONFLICT", "父母补全依据在预览后发生变化，请刷新后重试");
      }
      if (!stored.warningChangeId || !selectedChangeIds.has(stored.warningChangeId)) continue;
      const occurrences = new Map<string, number>();
      for (const issue of current.plan.issues.filter(({ severity }) => severity === "warning")) {
        const occurrence = (occurrences.get(issue.code) ?? 0) + 1;
        occurrences.set(issue.code, occurrence);
        warnings.push({ changeId: stored.warningChangeId, severity: "warning", code: issue.code, message: issue.message, occurrence });
      }
    }
    return warnings;
  }

  private validatePreviewPlan(changes: readonly InternalChange[], expectedVersions: Readonly<Record<string, number>>): PlanValidation {
    const baseChanges = changes.filter((change) => !change.public.selectionGroupId);
    const fingerprints = [...this.validatePlan(baseChanges, expectedVersions).fingerprints];
    const changesById = new Map(changes.map((change) => [change.public.id, change]));
    for (const alternative of changes.filter((change) => Boolean(change.public.selectionGroupId))) {
      const included = new Set<string>();
      const include = (changeId: string): void => {
        if (included.has(changeId)) return;
        const change = changesById.get(changeId);
        if (!change) return;
        included.add(changeId);
        for (const dependencyId of change.public.dependsOnChangeIds) include(dependencyId);
      };
      include(alternative.public.id);
      const validation = this.validatePlan(changes.filter((change) => included.has(change.public.id)), expectedVersions);
      fingerprints.push(...validation.fingerprints.filter((entry) => entry.changeId === alternative.public.id));
    }
    return { fingerprints };
  }

  private validatePlan(changes: readonly InternalChange[], expectedVersions: Readonly<Record<string, number>>): PlanValidation {
    try {
      createUnitOfWork(this.database, this.workspaceId).run("conversation.validate", (ctx) => {
        const validation = this.collectPlanValidation(ctx, changes, expectedVersions);
        throw new PlanRollback(validation);
      });
    } catch (error) {
      if (error instanceof PlanRollback) return error.validation;
      throw error;
    }
    throw new Error("Prospective validation did not roll back");
  }

  private validatePlanInSavepoint(ctx: TransactionContext, changes: readonly InternalChange[], expectedVersions: Readonly<Record<string, number>>): PlanValidation {
    this.database.exec("SAVEPOINT conversation_draft_validation");
    try { return this.collectPlanValidation(ctx, changes, expectedVersions); }
    finally {
      this.database.exec("ROLLBACK TO conversation_draft_validation");
      this.database.exec("RELEASE conversation_draft_validation");
    }
  }

  private collectPlanValidation(ctx: TransactionContext, changes: readonly InternalChange[], expectedVersions: Readonly<Record<string, number>>): PlanValidation {
    const fingerprints: IssueFingerprint[] = [];
    const add = (changeId: string, severity: IssueFingerprint["severity"], issues: readonly DomainIssue[]): void => {
      const occurrences = new Map<string, number>();
      for (const { code, message } of issues) {
        const key = `${severity}\u0000${code}\u0000${message}`;
        const occurrence = (occurrences.get(key) ?? 0) + 1; occurrences.set(key, occurrence);
        fingerprints.push({ changeId, severity, code, message, occurrence });
      }
    };
    const service = new FactCommandService(this.database, this.workspaceId);
    for (const change of changes) {
      try {
        add(change.public.id, "warning", service.executeInTransaction(ctx, change.command(expectedVersions), { confirmWarnings: true, recordSource: false }).warnings);
      } catch (error) {
        if (error instanceof FactCommandError) add(change.public.id, "conflict", error.issues);
        else throw error;
      }
    }
    return { fingerprints };
  }

  private sameFingerprints(left: readonly IssueFingerprint[], right: readonly IssueFingerprint[]): boolean {
    const normalizeIssues = (issues: readonly IssueFingerprint[]) => [...issues]
      .sort((a, b) => a.changeId.localeCompare(b.changeId) || a.severity.localeCompare(b.severity) || a.code.localeCompare(b.code)
        || a.message.localeCompare(b.message) || a.occurrence - b.occurrence);
    return equalJson(normalizeIssues(left), normalizeIssues(right));
  }
}
