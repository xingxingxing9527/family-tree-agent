import { randomUUID } from "node:crypto";
import type { ConversationConfirmationReceipt, ConversationDraftChangeDto, ConversationDraftPreview, ConversationMutationDraft } from "../../../shared/chat.js";
import type { PersonCandidate } from "../../../shared/contracts.js";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import { createUnitOfWork } from "../../database/unit-of-work.js";
import { FactCommandService } from "../facts/fact-command-service.js";
import type { FactCommand } from "../facts/fact-commands.js";
import { FactQueries } from "../facts/fact-queries.js";
import type { ModelAdapter } from "../../llm/model-adapter.js";
import { validateMarriageFact, validateParentChildFact } from "../../domain/validation/fact-validator.js";
import { validatePartialDate, type DomainIssue } from "../../domain/validation/partial-date-validator.js";
import { selectRelevantCandidates } from "./context-minimizer.js";

type DraftStatus = "active" | "superseded" | "confirmed" | "invalidated";
interface InternalChange {
  public: ConversationDraftChangeDto;
  expectedVersion?: number;
  command(expectedVersions: Readonly<Record<string, number>>): FactCommand;
}
interface StoredDraft { preview: ConversationDraftPreview; changes: Map<string, InternalChange>; status: DraftStatus; }

export class DraftValidationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "DraftValidationError"; }
}

const normalize = (value: string): string => value.trim().toLocaleLowerCase();
const equalJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
};

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
    this.ensureUniqueReferences(draft);
    const queries = new FactQueries(this.database, this.workspaceId);
    const existing = queries.listPeople();
    const id = randomUUID();
    const internal: InternalChange[] = [];
    const warnings: Array<{ code: string; message: string }> = [];
    const conflicts: Array<{ code: string; message: string }> = [];
    const unresolved = draft.unresolvedReferences.map((entry) => ({ ...entry, candidatePersonIds: [...entry.candidatePersonIds] }));
    const resolved = new Map<string, { entityId: string; dependencyId?: string; birth: ConversationMutationDraft["candidatePeople"][number]["birth"] }>();
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
      if (!match) {
        if (!stated.has("displayName") || !stated.has("gender")) throw new DraftValidationError("MISSING_IDENTITY", "A new person requires explicit display name and gender fields");
        const entityId = randomUUID();
        const changeId = randomUUID();
        resolved.set(candidate.referenceId, { entityId, dependencyId: changeId, birth: candidate.birth });
        internal.push({
          public: {
            id: changeId, kind: "create", entityType: "person", entityId, summary: `创建人物 ${candidate.displayName}`, dependsOnChangeIds: [],
            fieldChanges: [
              { field: "displayName", before: null, after: candidate.displayName }, { field: "aliases", before: [], after: candidate.aliases },
              { field: "gender", before: null, after: candidate.gender }, { field: "birth", before: null, after: candidate.birth },
              { field: "death", before: null, after: candidate.death }, { field: "notes", before: null, after: candidate.notes }
            ]
          },
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
      resolved.set(candidate.referenceId, { entityId: match.id, birth: merged.birth });
      const changed = match.displayName !== merged.displayName || match.gender !== merged.gender
        || !equalJson(match.birth, merged.birth) || !equalJson(match.death, merged.death)
        || match.notes !== merged.notes || !equalJson(aliases, [...merged.aliases].sort());
      if (changed) {
        const changeId = randomUUID();
        const fieldChanges = [
          ["displayName", match.displayName, merged.displayName], ["aliases", aliases, merged.aliases], ["gender", match.gender, merged.gender],
          ["birth", match.birth, merged.birth], ["death", match.death, merged.death], ["notes", match.notes, merged.notes]
        ].filter(([field, before, after]) => stated.has(field as never) && !equalJson(before, after)).map(([field, before, after]) => ({ field: field as string, before, after }));
        internal.push({
          public: { id: changeId, kind: "update", entityType: "person", entityId: match.id, summary: `更新人物 ${candidate.displayName}`, dependsOnChangeIds: [], fieldChanges },
          expectedVersion: match.rowVersion,
          command: (versions) => ({
            type: "person.update", personId: match!.id, expectedVersion: versions[match!.id]!,
            patch: Object.fromEntries(fieldChanges.map((change) => [change.field, change.after])),
            source: this.source(id, changeId, draft, "对话修订")
          })
        });
      }
    }

    const candidateByRef = new Map(draft.candidatePeople.map((candidate) => [candidate.referenceId, candidate]));
    const existingEdges = queries.listParentChild().map((edge) => ({ parentId: edge.parentId, childId: edge.childId }));
    const prospectiveFact = (reference: string) => {
      const candidate = candidateByRef.get(reference); const resolution = resolved.get(reference);
      return candidate && resolution ? { id: resolution.entityId, workspaceId: this.workspaceId, birth: resolution.birth } : null;
    };
    const plannedEdges = [...existingEdges];
    for (const relation of draft.parentChildFacts) {
      const parent = resolved.get(relation.parentRef); const child = resolved.get(relation.childRef);
      if (!parent || !child) { this.addMissing(unresolved, !parent ? relation.parentRef : relation.childRef); continue; }
      const validation = validateParentChildFact(prospectiveFact(relation.parentRef)!, prospectiveFact(relation.childRef)!, plannedEdges);
      addIssues(validation.errors, conflicts); addIssues(validation.warnings, warnings);
      if (queries.listParentChild().some((edge) => edge.childId === child.entityId && edge.parentRole === relation.parentRole)) {
        addIssues([{ code: "PARENT_ROLE_OCCUPIED", message: `The child already has an active biological ${relation.parentRole}` }], conflicts);
      }
      plannedEdges.push({ parentId: parent.entityId, childId: child.entityId });
      const changeId = randomUUID();
      const entityId = randomUUID();
      internal.push({
        public: {
          id: changeId, kind: "create", entityType: "parentChild", entityId, summary: "创建亲子关系",
          dependsOnChangeIds: [parent.dependencyId, child.dependencyId].filter((value): value is string => Boolean(value)),
          fieldChanges: [{ field: "parentId", before: null, after: parent.entityId }, { field: "childId", before: null, after: child.entityId }, { field: "parentRole", before: null, after: relation.parentRole }]
        },
        command: () => ({
          type: "parentChild.add", draft: { id: entityId, workspaceId: this.workspaceId, parentId: parent.entityId, childId: child.entityId, parentRole: relation.parentRole },
          source: this.source(id, changeId, draft, "对话亲子事实", relation.sourceRef)
        })
      });
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
          dependsOnChangeIds: [spouseA.dependencyId, spouseB.dependencyId].filter((value): value is string => Boolean(value)),
          fieldChanges: [{ field: "spouseAId", before: null, after: spouseA.entityId }, { field: "spouseBId", before: null, after: spouseB.entityId }, { field: "start", before: null, after: marriage.start }]
        },
        command: () => ({
          type: "marriage.add", draft: { id: entityId, workspaceId: this.workspaceId, spouseAId: spouseA.entityId, spouseBId: spouseB.entityId, start: marriage.start },
          source: this.source(id, changeId, draft, "对话婚姻事实", marriage.sourceRef)
        })
      });
    }

    const preview = deepFreeze<ConversationDraftPreview>({
      id, workspaceId: this.workspaceId, version, expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      changes: internal.map((change) => change.public),
      creates: internal.filter((change) => change.public.kind === "create").length,
      updates: internal.filter((change) => change.public.kind === "update").length,
      warnings, conflicts, unresolvedReferences: unresolved
    });
    this.drafts.set(id, { preview, changes: new Map(internal.map((change) => [change.public.id, change])), status: "active" });
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
    if (stored.preview.conflicts.length > 0) throw new DraftValidationError("CONFLICT", "Draft contains conflicts");
    const requiredWarnings = [...new Set(stored.preview.warnings.map((warning) => warning.code))].sort();
    const acknowledged = [...new Set(acknowledgedWarningCodes)].sort();
    if (acknowledged.length !== acknowledgedWarningCodes.length || !equalJson(requiredWarnings, acknowledged)) {
      throw new DraftValidationError("WARNING_ACK_REQUIRED", "Every draft warning must be explicitly acknowledged");
    }
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
    const service = new FactCommandService(this.database, this.workspaceId);
    const result = createUnitOfWork(this.database, this.workspaceId).run("conversation.confirm", (ctx) => {
      const changedEntityIds: string[] = [];
      for (const change of stored.changes.values()) {
        if (!selected.has(change.public.id)) continue;
        changedEntityIds.push(...service.executeInTransaction(ctx, change.command(expectedVersions), { confirmWarnings: requiredWarnings.length > 0 }).changedEntityIds);
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
}
