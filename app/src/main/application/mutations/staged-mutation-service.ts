import { randomUUID } from "node:crypto";
import type {
  MutationChange,
  MutationIntent,
  MutationIssue,
  MutationPreview,
  MutationReceipt
} from "../../../shared/mutations.js";
import { MAX_MUTATION_CHANGES as mutationChangeLimit, MAX_MUTATION_INTENTS as mutationIntentLimit } from "../../../shared/mutations.js";
import type { ParentCompletionPlanDto } from "../../../shared/contracts.js";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import { LineageRepository } from "../../database/repositories/lineage-repository.js";
import { PersonRepository } from "../../database/repositories/person-repository.js";
import { createUnitOfWork, type TransactionContext } from "../../database/unit-of-work.js";
import { FactCommandError, FactCommandService } from "../facts/fact-command-service.js";
import type { FactCommand, SourceDraft } from "../facts/fact-commands.js";
import { FactQueries } from "../facts/fact-queries.js";
import { LineageCommandError, LineageCommandService } from "../lineages/lineage-command-service.js";
import {
  ParentCompletionService,
  type ParentCompletionRequest
} from "../relations/parent-completion-service.js";

type DraftStatus = "active" | "superseded" | "confirmed";
interface InternalChange {
  public: MutationChange;
  intent: MutationIntent;
  command: FactCommand | null;
  previewIssues: MutationIssue[];
  planning?: StoredParentCompletionPlan;
}
interface StoredParentCompletionPlan {
  input: ParentCompletionRequest;
  planningFingerprint: string;
  plan: ParentCompletionPlanDto;
}
interface StoredDraft {
  preview: MutationPreview;
  changes: Map<string, InternalChange>;
  plans: StoredParentCompletionPlan[];
  status: DraftStatus;
}

class PreviewRollback extends Error {
  constructor(readonly changes: MutationChange[], readonly issues: MutationIssue[]) { super("Rollback mutation preview"); }
}

export class MutationValidationError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "VALIDATION" | "CONFLICT" | "EXPIRED",
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = "MutationValidationError";
  }
}

const source = (description: string, draftId: string, changeId: string): SourceDraft => ({
  sourceKey: `mutation:${draftId}:${changeId}`,
  title: description.trim() || "表单录入",
  kind: "form"
});
const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return JSON.stringify(a) === JSON.stringify(b);
};
const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const normalizedAliases = (values: readonly string[]): string[] => [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
const parentRoleName = (role: "father" | "mother"): string => role === "father" ? "父亲" : "母亲";
const completionBasisName = (basis: ParentCompletionPlanDto["basis"]): string => {
  if (basis === "unique_spouse") return "唯一已确认配偶";
  if (basis === "birth_interval") return "孩子出生时间与婚姻区间唯一匹配";
  if (basis === "administrator_selected") return "管理员指定的已确认配偶";
  return "已确认婚姻关系";
};

export class StagedMutationService {
  private readonly drafts = new Map<string, StoredDraft>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string, options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
  }

  stage(input: { intents: MutationIntent[] }, version = 1): MutationPreview {
    this.evictExpired();
    if (input.intents.length === 0 || input.intents.length > mutationIntentLimit) {
      throw new MutationValidationError("VALIDATION", `Stage between 1 and ${mutationIntentLimit} intents`);
    }
    const draftId = randomUUID();
    const changes = input.intents.flatMap((intent) => this.compile(draftId, structuredClone(intent)));
    if (changes.length > mutationChangeLimit) {
      throw new MutationValidationError("VALIDATION", `A preview may contain at most ${mutationChangeLimit} expanded changes`);
    }
    const validated = this.previewChanges(changes);
    const expectedVersions = Object.fromEntries(input.intents.flatMap((intent) => {
      if ("expectedVersion" in intent) {
        const id = "personId" in intent ? intent.personId : "marriageId" in intent ? intent.marriageId : "lineageId" in intent ? intent.lineageId : "membershipId" in intent ? intent.membershipId : null;
        return id ? [[id, intent.expectedVersion] as const] : [];
      }
      return [];
    }));
    const preview: MutationPreview = Object.freeze({
      id: draftId,
      workspaceId: this.workspaceId,
      version,
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      expectedVersions,
      changes: validated.changes,
      issues: validated.issues,
      canConfirm: validated.changes.some((change) => change.disposition === "create" || change.disposition === "update")
    });
    this.drafts.set(draftId, {
      preview,
      changes: new Map(changes.map((change) => [change.public.id, change])),
      plans: changes.flatMap((change) => change.planning ? [change.planning] : []),
      status: "active"
    });
    return preview;
  }

  revise(input: { draftId: string; intents: MutationIntent[] }): MutationPreview {
    const current = this.require(input.draftId);
    this.requireActive(current);
    const revised = this.stage({ intents: input.intents }, current.preview.version + 1);
    current.status = "superseded";
    return revised;
  }

  confirm(input: { draftId: string; draftVersion: number; selectedChangeIds: string[]; acknowledgedWarningCodes: string[] }): MutationReceipt {
    const stored = this.require(input.draftId);
    this.requireActive(stored);
    if (stored.preview.version !== input.draftVersion) throw new MutationValidationError("CONFLICT", "Draft version changed");
    const selected = new Set(input.selectedChangeIds);
    if (selected.size === 0 || input.selectedChangeIds.length > mutationChangeLimit || selected.size !== input.selectedChangeIds.length) {
      throw new MutationValidationError("VALIDATION", `Select between 1 and ${mutationChangeLimit} unique changes`);
    }
    const selectedChanges = [...stored.changes.values()].filter((change) => selected.has(change.public.id));
    if (selectedChanges.length !== selected.size) throw new MutationValidationError("VALIDATION", "Unknown change selection");
    if (selectedChanges.some((change) => !["create", "update"].includes(stored.preview.changes.find((entry) => entry.id === change.public.id)?.disposition ?? "blocked"))) {
      throw new MutationValidationError("VALIDATION", "Blocked or unchanged changes cannot be confirmed");
    }
    this.validateDependencies(stored, selected);
    const requiredWarnings = stored.preview.issues
      .filter((issue) => selected.has(issue.changeId) && issue.severity === "warning")
      .map((issue) => issue.code);
    if (new Set(input.acknowledgedWarningCodes).size !== input.acknowledgedWarningCodes.length || !sameSet(requiredWarnings, input.acknowledgedWarningCodes)) {
      throw new MutationValidationError("VALIDATION", "Every selected warning must be acknowledged");
    }

    try {
      const receipt = createUnitOfWork(this.database, this.workspaceId).run("mutation.confirm", (ctx) => {
        this.requireFreshParentCompletionPlans(stored.plans);
        const service = new FactCommandService(this.database, this.workspaceId);
        const changedEntityIds: string[] = [];
        const currentWarnings: string[] = [];
        for (const change of selectedChanges) {
          const result = this.applyChange(ctx, change, service);
          changedEntityIds.push(...result.changedEntityIds);
          currentWarnings.push(...result.warnings.map((warning) => warning.code));
        }
        if (!sameSet(requiredWarnings, currentWarnings)) throw new MutationValidationError("CONFLICT", "Validation results changed after preview");
        return { draftId: stored.preview.id, operationGroupId: ctx.operationGroupId, changedEntityIds };
      });
      stored.status = "confirmed";
      return receipt;
    } catch (error) {
      if (error instanceof MutationValidationError) throw error;
      if (error instanceof FactCommandError) {
        const conflict = error.issues.some((issue) => issue.code === "CONFLICT");
        throw new MutationValidationError(conflict ? "CONFLICT" : "VALIDATION", error.message);
      }
      if (error instanceof LineageCommandError) throw new MutationValidationError(error.code === "CONFLICT" ? "CONFLICT" : error.code, error.message);
      throw new MutationValidationError("CONFLICT", "Selected changes could not be committed atomically");
    }
  }

  private validateDependencies(stored: StoredDraft, selected: ReadonlySet<string>): void {
    const previewById = new Map(stored.preview.changes.map((change) => [change.id, change]));
    for (const change of stored.preview.changes) {
      for (const dependencyId of change.dependsOnChangeIds) {
        if (!previewById.has(dependencyId)) throw new MutationValidationError("VALIDATION", "Change dependency is unknown");
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (changeId: string): void => {
      if (visiting.has(changeId)) throw new MutationValidationError("VALIDATION", "Change dependencies contain a cycle");
      if (visited.has(changeId)) return;
      visiting.add(changeId);
      for (const dependencyId of previewById.get(changeId)?.dependsOnChangeIds ?? []) visit(dependencyId);
      visiting.delete(changeId);
      visited.add(changeId);
    };
    for (const change of stored.preview.changes) visit(change.id);
    for (const changeId of selected) {
      const change = previewById.get(changeId)!;
      const missing = change.dependsOnChangeIds.find((dependencyId) => {
        const dependency = previewById.get(dependencyId)!;
        return dependency.disposition !== "unchanged" && !selected.has(dependencyId);
      });
      if (missing) throw new MutationValidationError("VALIDATION", "Automatic completion requires its explicit parent change");
    }
  }

  private requireFreshParentCompletionPlans(plans: readonly StoredParentCompletionPlan[]): void {
    if (plans.length === 0) return;
    const planner = new ParentCompletionService(new FactQueries(this.database, this.workspaceId));
    for (const stored of plans) {
      const current = planner.plan(stored.input);
      if (current.planningFingerprint !== stored.planningFingerprint || !sameValue(current.plan, stored.plan)) {
        throw new MutationValidationError(
          "CONFLICT",
          "父母补全依据在预览后发生变化，请刷新后重试",
          { code: "PARENT_COMPLETION_STALE" }
        );
      }
    }
  }

  private previewChanges(changes: InternalChange[]): { changes: MutationChange[]; issues: MutationIssue[] } {
    try {
      return createUnitOfWork(this.database, this.workspaceId).run("mutation.preview", (ctx) => {
        const service = new FactCommandService(this.database, this.workspaceId);
        const publicChanges: MutationChange[] = [];
        const issues: MutationIssue[] = [];
        for (const change of changes) {
          const dependencyBlocked = change.public.dependsOnChangeIds.some((dependencyId) =>
            publicChanges.some((entry) => entry.id === dependencyId && entry.disposition === "blocked")
          );
          if (dependencyBlocked) {
            publicChanges.push({ ...change.public, disposition: "blocked", selectedByDefault: false });
            issues.push({
              changeId: change.public.id,
              severity: "error",
              code: "DEPENDENCY_BLOCKED",
              message: "系统自动补全依赖的人工录入关系无法提交"
            });
            continue;
          }
          if (change.public.disposition === "unchanged" || change.public.disposition === "blocked") {
            publicChanges.push(change.public);
            issues.push(...change.previewIssues);
            continue;
          }
          this.database.exec(`SAVEPOINT "preview_${change.public.id.replaceAll("-", "_")}"`);
          try {
            const result = this.applyChange(ctx, change, service, false);
            publicChanges.push(change.public);
            issues.push(...change.previewIssues);
            issues.push(...result.warnings.map((warning) => ({ changeId: change.public.id, severity: "warning" as const, code: warning.code, message: warning.message })));
            this.database.exec(`RELEASE "preview_${change.public.id.replaceAll("-", "_")}"`);
          } catch (error) {
            this.database.exec(`ROLLBACK TO "preview_${change.public.id.replaceAll("-", "_")}"`);
            this.database.exec(`RELEASE "preview_${change.public.id.replaceAll("-", "_")}"`);
            const entries = error instanceof FactCommandError
              ? error.issues
              : [{ code: error instanceof MutationValidationError || error instanceof LineageCommandError ? error.code : "VALIDATION", message: error instanceof Error ? error.message : "Invalid change" }];
            publicChanges.push({ ...change.public, disposition: "blocked", selectedByDefault: false });
            issues.push(...entries.map((entry) => ({ changeId: change.public.id, severity: "error" as const, code: entry.code, message: entry.message })));
          }
        }
        throw new PreviewRollback(publicChanges, issues);
      });
    } catch (error) {
      if (error instanceof PreviewRollback) return { changes: error.changes, issues: error.issues };
      throw error;
    }
  }

  private compile(draftId: string, intent: MutationIntent): InternalChange[] {
    const generatedEntityId = randomUUID();
    type PublicInput = Omit<MutationChange, "id" | "originKind" | "selectedByDefault" | "dependsOnChangeIds"> &
      Partial<Pick<MutationChange, "originKind" | "selectedByDefault" | "dependsOnChangeIds">>;
    const make = (
      publicChange: PublicInput,
      command: FactCommand | null,
      options: { id?: string; previewIssues?: MutationIssue[]; planning?: StoredParentCompletionPlan } = {}
    ): InternalChange => {
      const id = options.id ?? randomUUID();
      const actionable = publicChange.disposition === "create" || publicChange.disposition === "update";
      return {
        public: {
          id,
          ...publicChange,
          originKind: publicChange.originKind ?? "explicit",
          selectedByDefault: publicChange.selectedByDefault ?? actionable,
          dependsOnChangeIds: publicChange.dependsOnChangeIds ?? []
        },
        intent,
        command,
        previewIssues: options.previewIssues ?? [],
        ...(options.planning ? { planning: options.planning } : {})
      };
    };
    switch (intent.type) {
      case "person.create": {
        const id = randomUUID();
        return [make({ disposition: "create", entityType: "person", entityId: generatedEntityId, summary: `创建人物 ${intent.draft.displayName}`, fieldChanges: [] }, {
          type: "person.create",
          draft: { id: generatedEntityId, workspaceId: this.workspaceId, ...intent.draft },
          source: source(intent.draft.sourceDescription, draftId, id)
        }, { id })];
      }
      case "person.update": {
        const id = randomUUID();
        const { sourceDescription, ...patch } = intent.patch;
        const person = new PersonRepository(this.database, this.workspaceId).get(intent.personId);
        const fieldChanges: MutationChange["fieldChanges"] = [];
        if (person && person.rowVersion === intent.expectedVersion) {
          for (const field of ["displayName", "gender", "birth", "death", "notes"] as const) {
            const after = patch[field];
            if (after !== undefined && !sameValue(person[field], after)) fieldChanges.push({ field, before: person[field], after });
          }
          if (patch.aliases !== undefined) {
            const before = new PersonRepository(this.database, this.workspaceId).listAliases(intent.personId).map((alias) => alias.name);
            if (!sameValue(normalizedAliases(before), normalizedAliases(patch.aliases))) fieldChanges.push({ field: "aliases", before, after: patch.aliases });
          }
        }
        const disposition = person && person.rowVersion === intent.expectedVersion && fieldChanges.length === 0 ? "unchanged" : "update";
        return [make({ disposition, entityType: "person", entityId: intent.personId, summary: disposition === "unchanged" ? "人物资料没有变化" : "更新人物资料", fieldChanges }, {
          type: "person.update", personId: intent.personId, patch, expectedVersion: intent.expectedVersion,
          source: source(sourceDescription ?? "表单修订", draftId, id)
        }, { id })];
      }
      case "parentChild.add": {
        const id = randomUUID();
        return [make({ disposition: "create", entityType: "parentChild", entityId: generatedEntityId, summary: "创建亲子关系", fieldChanges: [] }, {
          type: "parentChild.add", draft: { id: generatedEntityId, workspaceId: this.workspaceId, parentId: intent.draft.parentId, childId: intent.draft.childId, parentRole: intent.draft.parentRole },
          source: source(intent.draft.sourceDescription, draftId, id)
        }, { id })];
      }
      case "parentFamily.add": return this.compileParentFamily(draftId, intent, make);
      case "marriage.add": {
        const id = randomUUID();
        return [make({ disposition: "create", entityType: "marriage", entityId: generatedEntityId, summary: "创建婚姻关系", fieldChanges: [] }, {
          type: "marriage.add", draft: { id: generatedEntityId, workspaceId: this.workspaceId, spouseAId: intent.draft.spouseAId, spouseBId: intent.draft.spouseBId, start: intent.draft.start },
          source: source(intent.draft.sourceDescription, draftId, id)
        }, { id })];
      }
      case "marriage.divorce": {
        const id = randomUUID();
        return [make({ disposition: "update", entityType: "marriage", entityId: intent.marriageId, summary: "登记离婚", fieldChanges: [] }, {
          type: "marriage.divorce", marriageId: intent.marriageId, endDate: intent.endDate, expectedVersion: intent.expectedVersion,
          source: source("离婚登记", draftId, id)
        }, { id })];
      }
      case "person.childrenCompleteness.set": {
        const id = randomUUID();
        const person = new PersonRepository(this.database, this.workspaceId).get(intent.personId);
        const unchanged = person?.rowVersion === intent.expectedVersion && person.childrenComplete === intent.complete;
        return [make({
          disposition: unchanged ? "unchanged" : "update",
          entityType: "personCompleteness",
          entityId: intent.personId,
          summary: unchanged ? "子女资料完整度没有变化" : "确认子女资料完整度",
          fieldChanges: unchanged || !person ? [] : [{ field: "childrenComplete", before: person.childrenComplete, after: intent.complete }]
        }, {
          type: "person.childrenCompleteness.set", personId: intent.personId, complete: intent.complete, expectedVersion: intent.expectedVersion,
          source: source(intent.sourceDescription, draftId, id)
        }, { id })];
      }
      case "lineage.create": return [make({ disposition: "create", entityType: "lineage", entityId: generatedEntityId, summary: `创建支系 ${intent.name}`, fieldChanges: [] }, null)];
      case "lineage.update": {
        const lineage = new LineageRepository(this.database, this.workspaceId).get(intent.lineageId);
        const fieldChanges: MutationChange["fieldChanges"] = [];
        if (lineage?.rowVersion === intent.expectedVersion) {
          for (const field of ["name", "founderPersonId", "description"] as const) {
            const after = intent.patch[field];
            if (after !== undefined && !sameValue(lineage[field], after)) fieldChanges.push({ field, before: lineage[field], after });
          }
        }
        const disposition = lineage?.rowVersion === intent.expectedVersion && fieldChanges.length === 0 ? "unchanged" : "update";
        return [make({ disposition, entityType: "lineage", entityId: intent.lineageId, summary: disposition === "unchanged" ? "支系资料没有变化" : "更新支系", fieldChanges }, null)];
      }
      case "lineage.archive": return [make({ disposition: "update", entityType: "lineage", entityId: intent.lineageId, summary: "归档支系", fieldChanges: [] }, null)];
      case "lineageMembership.add": return [make({ disposition: "create", entityType: "lineageMembership", entityId: generatedEntityId, summary: "添加人物支系归属", fieldChanges: [] }, null)];
      case "lineageMembership.update": {
        const membership = new LineageRepository(this.database, this.workspaceId).getMembership(intent.membershipId);
        const fieldChanges: MutationChange["fieldChanges"] = [];
        if (membership?.rowVersion === intent.expectedVersion) {
          for (const field of ["lineageRole", "isPrimary", "declaredGeneration", "generationMarker"] as const) {
            const after = intent.patch[field];
            if (after !== undefined && !sameValue(membership[field], after)) fieldChanges.push({ field, before: membership[field], after });
          }
        }
        const disposition = membership?.rowVersion === intent.expectedVersion && fieldChanges.length === 0 ? "unchanged" : "update";
        return [make({ disposition, entityType: "lineageMembership", entityId: intent.membershipId, summary: disposition === "unchanged" ? "人物支系归属没有变化" : "更新人物支系归属", fieldChanges }, null)];
      }
      case "lineageMembership.remove": return [make({ disposition: "update", entityType: "lineageMembership", entityId: intent.membershipId, summary: "移除人物支系归属", fieldChanges: [] }, null)];
    }
  }

  private compileParentFamily(
    draftId: string,
    intent: Extract<MutationIntent, { type: "parentFamily.add" }>,
    make: (
      publicChange: Omit<MutationChange, "id" | "originKind" | "selectedByDefault" | "dependsOnChangeIds"> & Partial<Pick<MutationChange, "originKind" | "selectedByDefault" | "dependsOnChangeIds">>,
      command: FactCommand | null,
      options?: { id?: string; previewIssues?: MutationIssue[]; planning?: StoredParentCompletionPlan }
    ) => InternalChange
  ): InternalChange[] {
    const input: ParentCompletionRequest = {
      knownParentId: intent.knownParentId,
      childId: intent.childId,
      parentRole: intent.parentRole,
      ...(intent.selectedSpouseId === undefined ? {} : { selectedSpouseId: intent.selectedSpouseId })
    };
    const planned = new ParentCompletionService(new FactQueries(this.database, this.workspaceId)).plan(input);
    const planning: StoredParentCompletionPlan = { input, ...planned };
    const explicitId = randomUUID();
    const explicitEvidence = planned.plan.evidence.find((entry) => entry.entityType === "parent_child"
      && entry.parentId === intent.knownParentId
      && entry.childId === intent.childId
      && entry.parentRole === intent.parentRole);
    const explicitUnchanged = explicitEvidence !== undefined;
    const explicitEntityId = explicitEvidence?.id ?? randomUUID();
    const explicit = make({
      disposition: explicitUnchanged ? "unchanged" : "create",
      entityType: "parentChild",
      entityId: explicitEntityId,
      summary: `${planned.plan.explicit.parentName} → ${planned.plan.explicit.childName}：${parentRoleName(intent.parentRole)}`,
      fieldChanges: [],
      originKind: "explicit",
      selectedByDefault: !explicitUnchanged,
      dependsOnChangeIds: []
    }, explicitUnchanged ? null : {
      type: "parentChild.add",
      draft: {
        id: explicitEntityId,
        workspaceId: this.workspaceId,
        parentId: intent.knownParentId,
        childId: intent.childId,
        parentRole: intent.parentRole,
        originKind: "explicit",
        inferredFromMarriageId: null
      },
      source: source(intent.sourceDescription, draftId, explicitId)
    }, { id: explicitId, planning });
    if (intent.skipCompletion) return [explicit];

    const automaticId = randomUUID();
    const suggested = planned.plan.suggested;
    const basis = completionBasisName(planned.plan.basis);
    const automaticIssues: MutationIssue[] = planned.plan.issues.map((issue) => ({
      changeId: automaticId,
      severity: issue.severity,
      code: issue.code,
      message: issue.message
    }));
    const dependencyIds = explicitUnchanged ? [] : [explicitId];
    if (planned.plan.status === "suggested" && suggested) {
      const entityId = randomUUID();
      return [explicit, make({
        disposition: "create",
        entityType: "parentChild",
        entityId,
        summary: `${suggested.parentName} → ${suggested.childName}：${parentRoleName(suggested.parentRole)}（依据：${basis}）`,
        fieldChanges: [],
        originKind: "spouse_default",
        selectedByDefault: true,
        dependsOnChangeIds: dependencyIds
      }, {
        type: "parentChild.add",
        draft: {
          id: entityId,
          workspaceId: this.workspaceId,
          parentId: suggested.parentId,
          childId: suggested.childId,
          parentRole: suggested.parentRole,
          originKind: "spouse_default",
          inferredFromMarriageId: suggested.inferredFromMarriageId ?? null
        },
        source: source(`根据已确认婚姻自动补全：${intent.sourceDescription}`, draftId, automaticId)
      }, { id: automaticId, previewIssues: automaticIssues })];
    }

    if (planned.plan.status === "unchanged" && suggested) {
      const existing = planned.plan.evidence.find((entry) => entry.entityType === "parent_child"
        && entry.parentId === suggested.parentId
        && entry.childId === suggested.childId
        && entry.parentRole === suggested.parentRole);
      return [explicit, make({
        disposition: "unchanged",
        entityType: "parentChild",
        entityId: existing?.id ?? null,
        summary: `${suggested.parentName}已是${suggested.childName}的${parentRoleName(suggested.parentRole)}，无需变更`,
        fieldChanges: [],
        originKind: "spouse_default",
        selectedByDefault: false,
        dependsOnChangeIds: []
      }, null, { id: automaticId, previewIssues: automaticIssues })];
    }

    const summary = suggested
      ? `${suggested.parentName}不能自动补全为${suggested.childName}的${parentRoleName(suggested.parentRole)}`
      : planned.plan.status === "no_candidate"
        ? `${planned.plan.explicit.childName}的另一位父母尚未确认`
        : `${planned.plan.explicit.childName}的另一位父母候选无法唯一判断`;
    return [explicit, make({
      disposition: "blocked",
      entityType: "parentChild",
      entityId: null,
      summary,
      fieldChanges: [],
      originKind: "spouse_default",
      selectedByDefault: false,
      dependsOnChangeIds: dependencyIds
    }, null, { id: automaticId, previewIssues: automaticIssues })];
  }

  private applyChange(ctx: TransactionContext, change: InternalChange, facts: FactCommandService, recordSource = true): { changedEntityIds: string[]; warnings: Array<{ code: string; message: string }> } {
    if (change.command) return facts.executeInTransaction(ctx, change.command, { confirmWarnings: true, recordSource });
    const lineages = new LineageCommandService(this.database, this.workspaceId);
    const intent = change.intent;
    let entityId: string;
    switch (intent.type) {
      case "lineage.create": entityId = lineages.createLineageInTransaction(ctx, { id: change.public.entityId!, ...intent }).id; break;
      case "lineage.update": entityId = lineages.updateLineageInTransaction(ctx, intent).id; break;
      case "lineage.archive": entityId = lineages.archiveLineageInTransaction(ctx, intent).id; break;
      case "lineageMembership.add": entityId = lineages.addMembershipInTransaction(ctx, { id: change.public.entityId!, ...intent }).id; break;
      case "lineageMembership.update": entityId = lineages.updateMembershipInTransaction(ctx, intent).id; break;
      case "lineageMembership.remove": entityId = lineages.removeMembershipInTransaction(ctx, intent).id; break;
      default: throw new MutationValidationError("VALIDATION", "Unsupported mutation intent");
    }
    return { changedEntityIds: [entityId], warnings: [] };
  }

  private require(id: string): StoredDraft {
    const stored = this.drafts.get(id);
    if (!stored) throw new MutationValidationError("NOT_FOUND", "Mutation draft was not found");
    return stored;
  }

  private requireActive(stored: StoredDraft): void {
    if (stored.status !== "active") throw new MutationValidationError("CONFLICT", "Mutation draft is no longer active");
    if (Date.parse(stored.preview.expiresAt) < this.now()) throw new MutationValidationError("EXPIRED", "Mutation draft expired");
  }

  private evictExpired(): void {
    for (const [id, stored] of this.drafts) if (stored.status !== "active" || Date.parse(stored.preview.expiresAt) < this.now()) this.drafts.delete(id);
  }
}
