import type { WorkspaceDatabase } from "../../database/open-database.js";
import { PersonRepository, type PersonRecord } from "../../database/repositories/person-repository.js";
import { CompletenessRepository } from "../../database/repositories/completeness-repository.js";
import { RelationRepository, type MarriageRecord, type ParentChildRecord } from "../../database/repositories/relation-repository.js";
import { createUnitOfWork, type TransactionContext, type UnitOfWork } from "../../database/unit-of-work.js";
import { MAX_WORKSPACE_PEOPLE, WORKSPACE_PEOPLE_LIMIT_MESSAGE, countActiveWorkspacePeople } from "../../database/workspace-people-limit.js";
import { validateMarriageFact, validateParentChildFact } from "../../domain/validation/fact-validator.js";
import { validatePartialDate, type DomainIssue } from "../../domain/validation/partial-date-validator.js";
import type { ExecuteFactCommandOptions, FactCommand, MutationResult } from "./fact-commands.js";

interface PreparedCommand {
  ids: Readonly<Record<string, string>>;
  errors: DomainIssue[];
  warnings: DomainIssue[];
}

export interface FactCommandPreview {
  errors: DomainIssue[];
  warnings: DomainIssue[];
  changes: Array<{ entityType: string; entityId: string | null; disposition: "create" | "update" }>;
  expectedVersions: Record<string, number>;
}

interface IdRow { workspace_id: string; }
interface RedirectRow { new_person_id: string; }

const issue = (code: string, message: string, details?: Readonly<Record<string, unknown>>): DomainIssue => ({
  code,
  message,
  ...(details ? { details } : {})
});

export class FactCommandError extends Error {
  constructor(public readonly issues: DomainIssue[]) {
    super(issues.map((entry) => entry.message).join("; "));
    this.name = "FactCommandError";
  }
}

export class FactCommandService {
  private readonly people: PersonRepository;
  private readonly completeness: CompletenessRepository;
  private readonly relations: RelationRepository;
  private readonly unitOfWork: UnitOfWork;

  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly workspaceId: string,
    unitOfWork: UnitOfWork = createUnitOfWork(database, workspaceId)
  ) {
    this.people = new PersonRepository(database, workspaceId);
    this.completeness = new CompletenessRepository(database, workspaceId);
    this.relations = new RelationRepository(database, workspaceId);
    this.unitOfWork = unitOfWork;
  }

  execute(command: FactCommand, options: ExecuteFactCommandOptions = {}): MutationResult {
    const prepared = this.prepare(command);
    this.throwOnErrors(prepared.errors);
    if (prepared.warnings.length > 0 && !options.confirmWarnings) {
      return { operationGroupId: "", changedEntityIds: [], warnings: prepared.warnings };
    }

    return this.unitOfWork.run(command.type, (ctx) => this.executeInTransaction(ctx, command, options));
  }

  preview(command: FactCommand): FactCommandPreview {
    const prepared = this.prepare(command);
    const expectedVersions: Record<string, number> = {};
    if ("expectedVersion" in command) {
      const entityId = "personId" in command ? command.personId : "marriageId" in command ? command.marriageId : "entityId" in command ? command.entityId : null;
      if (entityId) expectedVersions[entityId] = command.expectedVersion;
    }
    const entityType = command.type === "fact.softDelete"
      ? command.entityType
      : command.type.startsWith("person.") ? "person" : command.type.startsWith("parentChild") ? "parentChild" : "marriage";
    const entityId = command.type === "person.create" || command.type === "parentChild.add" || command.type === "marriage.add"
      ? command.draft.id ?? null
      : "personId" in command ? command.personId : "marriageId" in command ? command.marriageId : "entityId" in command ? command.entityId : null;
    return {
      errors: [...prepared.errors],
      warnings: [...prepared.warnings],
      changes: [{ entityType, entityId, disposition: command.type === "person.create" || command.type === "parentChild.add" || command.type === "marriage.add" ? "create" : "update" }],
      expectedVersions
    };
  }

  executeInTransaction(ctx: TransactionContext, command: FactCommand, options: ExecuteFactCommandOptions = {}): MutationResult {
    const current = this.prepare(command);
    this.throwOnErrors(current.errors);
    if (current.warnings.length > 0 && !options.confirmWarnings) throw new FactCommandError(current.warnings);
    const changedEntityId = this.apply(ctx, command, current.ids, options.recordSource !== false);
    return { operationGroupId: ctx.operationGroupId, changedEntityIds: [changedEntityId], warnings: current.warnings };
  }

  private prepare(command: FactCommand): PreparedCommand {
    const errors: DomainIssue[] = [];
    const warnings: DomainIssue[] = [];
    const ids: Record<string, string> = {};

    switch (command.type) {
      case "person.create": {
        this.requireOpenWorkspace(command.draft.workspaceId, errors);
        if (countActiveWorkspacePeople(this.database, this.workspaceId) >= MAX_WORKSPACE_PEOPLE) {
          errors.push(issue("WORKSPACE_PERSON_LIMIT", WORKSPACE_PEOPLE_LIMIT_MESSAGE, { maximum: MAX_WORKSPACE_PEOPLE }));
        }
        this.validateOptionalDate(command.draft.birth, errors);
        this.validateOptionalDate(command.draft.death, errors);
        break;
      }
      case "person.update": {
        const person = this.loadPerson(command.personId, "person", ids, errors);
        if (!person) break;
        this.requireVersion(person.rowVersion, command.expectedVersion, "person", person.id, errors);
        this.validateOptionalDate(command.patch.birth, errors);
        this.validateOptionalDate(command.patch.death, errors);
        if (errors.length > 0) break;

        const prospective: PersonRecord = {
          ...person,
          ...command.patch,
          birth: command.patch.birth === undefined ? person.birth : command.patch.birth,
          death: command.patch.death === undefined ? person.death : command.patch.death
        };
        const edges = this.relations.listParentChild();
        for (const edge of edges) {
          if (edge.parentId === person.id) {
            const child = this.people.get(edge.childId);
            if (child) this.mergeValidation(validateParentChildFact(prospective, child, edges), errors, warnings);
          } else if (edge.childId === person.id) {
            const parent = this.people.get(edge.parentId);
            if (parent) this.mergeValidation(validateParentChildFact(parent, prospective, edges), errors, warnings);
          }
        }
        break;
      }
      case "parentChild.add": {
        this.requireOpenWorkspace(command.draft.workspaceId, errors);
        const parent = this.loadPerson(command.draft.parentId, "parentId", ids, errors);
        const child = this.loadPerson(command.draft.childId, "childId", ids, errors);
        if (!parent || !child) break;
        if ((command.draft.originKind ?? "explicit") === "spouse_default") {
          if (command.draft.inferredFromMarriageId) {
            const marriage = this.loadMarriage(command.draft.inferredFromMarriageId, errors);
            if (marriage) ids.inferredMarriageId = marriage.id;
          }
        }
        const edges = this.relations.listParentChild();
        this.mergeValidation(validateParentChildFact(parent, child, edges), errors, warnings);
        if (edges.some((edge) => edge.childId === child.id && edge.parentRole === command.draft.parentRole)) {
          errors.push(issue("PARENT_ROLE_OCCUPIED", `The child already has an active biological ${command.draft.parentRole}`));
        }
        break;
      }
      case "marriage.add": {
        this.requireOpenWorkspace(command.draft.workspaceId, errors);
        this.validateOptionalDate(command.draft.start, errors);
        this.validateOptionalDate(command.draft.end, errors);
        if ((command.draft.status ?? "active") === "divorced" && !command.draft.end) {
          errors.push(issue("DIVORCED_MARRIAGE_END_REQUIRED", "A divorced marriage requires an end date"));
        }
        const spouseA = this.loadPerson(command.draft.spouseAId, "spouseAId", ids, errors);
        const spouseB = this.loadPerson(command.draft.spouseBId, "spouseBId", ids, errors);
        if (!spouseA || !spouseB) break;
        this.mergeValidation(validateMarriageFact(spouseA, spouseB), errors, warnings);
        const activeMarriages = this.relations.listMarriages().filter((marriage) => marriage.status === "active");
        if ((command.draft.status ?? "active") === "active" && activeMarriages.some((marriage) => this.marriageContains(marriage, spouseA.id) || this.marriageContains(marriage, spouseB.id))) {
          errors.push(issue("ACTIVE_MARRIAGE_EXISTS", "Each spouse must end their active marriage before starting another"));
        }
        break;
      }
      case "marriage.divorce": {
        this.validateOptionalDate(command.endDate, errors);
        const marriage = this.loadMarriage(command.marriageId, errors);
        if (!marriage) break;
        ids.marriage = marriage.id;
        this.requireVersion(marriage.rowVersion, command.expectedVersion, "marriage", marriage.id, errors);
        if (marriage.status !== "active") {
          errors.push(issue("CONFLICT", "Only an active marriage can be divorced", { entityId: marriage.id }));
        }
        break;
      }
      case "marriage.correct": {
        this.validateOptionalDate(command.replacement.start, errors);
        this.validateOptionalDate(command.replacement.end, errors);
        if (command.replacement.status === "divorced" && !command.replacement.end) {
          errors.push(issue("DIVORCED_MARRIAGE_END_REQUIRED", "A divorced marriage requires an end date"));
        }
        const marriage = this.loadMarriage(command.marriageId, errors);
        if (!marriage) break;
        ids.marriage = marriage.id;
        this.requireVersion(marriage.rowVersion, command.expectedVersion, "marriage", marriage.id, errors);
        const spouseA = this.loadPerson(command.replacement.spouseAId, "spouseAId", ids, errors);
        const spouseB = this.loadPerson(command.replacement.spouseBId, "spouseBId", ids, errors);
        if (!spouseA || !spouseB) break;
        this.mergeValidation(validateMarriageFact(spouseA, spouseB), errors, warnings);
        const activeMarriages = this.relations.listMarriages().filter((candidate) => candidate.id !== marriage.id && candidate.status === "active");
        if (command.replacement.status === "active" && activeMarriages.some((candidate) => this.marriageContains(candidate, spouseA.id) || this.marriageContains(candidate, spouseB.id))) {
          errors.push(issue("ACTIVE_MARRIAGE_EXISTS", "Each spouse must end their active marriage before starting another"));
        }
        break;
      }
      case "person.childrenCompleteness.set": {
        const person = this.loadPerson(command.personId, "person", ids, errors);
        if (person) this.requireVersion(person.rowVersion, command.expectedVersion, "person", person.id, errors);
        break;
      }
      case "fact.softDelete": {
        this.prepareSoftDelete(command.entityType, command.entityId, command.expectedVersion, ids, errors);
        break;
      }
    }
    return { ids, errors, warnings };
  }

  private apply(ctx: TransactionContext, command: FactCommand, ids: Readonly<Record<string, string>>, recordSource = true): string {
    switch (command.type) {
      case "person.create": {
        const createdSource = recordSource ? ctx.sources.create(ctx, command.source) : null;
        const person = ctx.people.create(ctx, {
          id: command.draft.id,
          displayName: command.draft.displayName,
          gender: command.draft.gender,
          birth: command.draft.birth,
          death: command.draft.death,
          notes: command.draft.notes
        });
        this.syncAliases(ctx, person.id, command.draft.aliases);
        if (createdSource) ctx.factSources.link("person", person.id, createdSource.id, ctx.operationGroupId);
        return person.id;
      }
      case "person.update": {
        const createdSource = recordSource ? ctx.sources.create(ctx, command.source) : null;
        const { aliases, ...personPatch } = command.patch;
        const person = ctx.people.update(ctx, ids.person!, personPatch);
        this.syncAliases(ctx, person.id, aliases);
        if (createdSource) ctx.factSources.link("person", person.id, createdSource.id, ctx.operationGroupId);
        return person.id;
      }
      case "parentChild.add": {
        const createdSource = recordSource ? ctx.sources.create(ctx, command.source) : null;
        const relation = ctx.relations.createParentChild(ctx, {
          id: command.draft.id,
          parentId: ids.parentId!,
          childId: ids.childId!,
          parentRole: command.draft.parentRole,
          originKind: command.draft.originKind,
          inferredFromMarriageId: command.draft.originKind === "spouse_default" ? ids.inferredMarriageId ?? null : null
        });
        if (createdSource) ctx.factSources.link("parent_child", relation.id, createdSource.id, ctx.operationGroupId);
        return relation.id;
      }
      case "marriage.add": {
        const createdSource = recordSource ? ctx.sources.create(ctx, command.source) : null;
        const marriage = ctx.relations.createMarriage(ctx, {
          id: command.draft.id,
          spouseAId: ids.spouseAId!,
          spouseBId: ids.spouseBId!,
          start: command.draft.start,
          status: command.draft.status,
          end: command.draft.end
        });
        if (createdSource) ctx.factSources.link("marriage", marriage.id, createdSource.id, ctx.operationGroupId);
        return marriage.id;
      }
      case "marriage.divorce": {
        const createdSource = recordSource ? ctx.sources.create(ctx, command.source) : null;
        const marriage = ctx.relations.divorceMarriage(ctx, ids.marriage!, command.endDate);
        if (createdSource) ctx.factSources.link("marriage", marriage.id, createdSource.id, ctx.operationGroupId);
        return marriage.id;
      }
      case "marriage.correct": {
        const createdSource = recordSource ? ctx.sources.create(ctx, command.source) : null;
        const marriage = ctx.relations.correctMarriage(ctx, ids.marriage!, {
          spouseAId: ids.spouseAId!,
          spouseBId: ids.spouseBId!,
          status: command.replacement.status,
          start: command.replacement.start,
          end: command.replacement.end
        });
        if (createdSource) ctx.factSources.link("marriage", marriage.id, createdSource.id, ctx.operationGroupId);
        return marriage.id;
      }
      case "person.childrenCompleteness.set": {
        const createdSource = recordSource ? ctx.sources.create(ctx, command.source) : null;
        const completeness = this.completeness.setChildrenCompleteness(ctx, {
          personId: ids.person!,
          complete: command.complete,
          expectedVersion: command.expectedVersion
        });
        if (createdSource) ctx.factSources.link("person_completeness", completeness.id, createdSource.id, ctx.operationGroupId);
        return completeness.id;
      }
      case "fact.softDelete": {
        if (ids.entityType === "person") return ctx.people.archive(ctx, ids.entityId!).id;
        if (ids.entityType === "parent_child") return ctx.relations.archiveParentChild(ctx, ids.entityId!).id;
        return ctx.relations.archiveMarriage(ctx, ids.entityId!).id;
      }
    }
  }

  private loadPerson(
    requestedId: string,
    key: string,
    ids: Record<string, string>,
    errors: DomainIssue[]
  ): PersonRecord | null {
    const resolvedId = this.resolvePersonId(requestedId, errors);
    if (!resolvedId) return null;
    ids[key] = resolvedId;
    const person = this.people.get(resolvedId);
    if (person) return person;

    const row = this.database.prepare("SELECT workspace_id FROM person WHERE id = ?").get(resolvedId) as IdRow | undefined;
    errors.push(row && row.workspace_id !== this.workspaceId
      ? issue("WORKSPACE_MISMATCH", "Referenced person belongs to a different workspace", { entityId: requestedId })
      : issue("NOT_FOUND", "Referenced person was not found", { entityId: requestedId }));
    return null;
  }

  private resolvePersonId(requestedId: string, errors: DomainIssue[]): string | null {
    let currentId = requestedId;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(currentId)) {
        errors.push(issue("CONFLICT", "Person ID redirects contain a cycle", { entityId: requestedId }));
        return null;
      }
      visited.add(currentId);
      const redirect = this.database.prepare("SELECT new_person_id FROM id_redirect WHERE workspace_id = ? AND old_person_id = ?")
        .get(this.workspaceId, currentId) as RedirectRow | undefined;
      if (redirect) {
        currentId = redirect.new_person_id;
        continue;
      }
      const foreignRedirect = this.database.prepare("SELECT workspace_id FROM id_redirect WHERE old_person_id = ? AND workspace_id <> ?")
        .get(currentId, this.workspaceId) as IdRow | undefined;
      if (foreignRedirect) {
        errors.push(issue("WORKSPACE_MISMATCH", "Person ID redirect belongs to a different workspace", { entityId: requestedId }));
        return null;
      }
      return currentId;
    }
  }

  private loadMarriage(id: string, errors: DomainIssue[]): MarriageRecord | null {
    const marriage = this.relations.getMarriage(id);
    if (marriage) return marriage;
    const row = this.database.prepare("SELECT workspace_id FROM marriage WHERE id = ?").get(id) as IdRow | undefined;
    errors.push(row && row.workspace_id !== this.workspaceId
      ? issue("WORKSPACE_MISMATCH", "Marriage belongs to a different workspace", { entityId: id })
      : issue("NOT_FOUND", "Marriage was not found", { entityId: id }));
    return null;
  }

  private prepareSoftDelete(
    requestedType: string,
    requestedId: string,
    expectedVersion: number,
    ids: Record<string, string>,
    errors: DomainIssue[]
  ): void {
    const entityType = requestedType === "parentChild" ? "parent_child" : requestedType;
    ids.entityType = entityType;
    if (entityType === "person") {
      const person = this.loadPerson(requestedId, "entityId", ids, errors);
      if (person) {
        this.requireVersion(person.rowVersion, expectedVersion, entityType, person.id, errors);
        const origin = this.database.prepare("SELECT origin_person_id FROM workspace_meta WHERE workspace_id = ?")
          .get(this.workspaceId) as { origin_person_id: string | null } | undefined;
        if (origin?.origin_person_id === person.id) {
          errors.push(issue("CONFLICT", "The workspace origin person cannot be archived", { entityId: person.id }));
        }
      }
      return;
    }
    if (entityType === "marriage") {
      const marriage = this.loadMarriage(requestedId, errors);
      if (marriage) {
        ids.entityId = marriage.id;
        this.requireVersion(marriage.rowVersion, expectedVersion, entityType, marriage.id, errors);
      }
      return;
    }
    if (entityType === "parent_child") {
      const relation = this.relations.getParentChild(requestedId);
      if (relation) {
        ids.entityId = relation.id;
        this.requireVersion(relation.rowVersion, expectedVersion, entityType, relation.id, errors);
      } else {
        this.addMissingOrForeignIssue("parent_child", requestedId, errors);
      }
      return;
    }
    errors.push(issue("VALIDATION", "Unsupported fact type for soft deletion", { entityType: requestedType }));
  }

  private addMissingOrForeignIssue(table: "parent_child", id: string, errors: DomainIssue[]): void {
    const row = this.database.prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`).get(id) as IdRow | undefined;
    errors.push(row && row.workspace_id !== this.workspaceId
      ? issue("WORKSPACE_MISMATCH", "Fact belongs to a different workspace", { entityId: id })
      : issue("NOT_FOUND", "Fact was not found", { entityId: id }));
  }

  private validateOptionalDate(value: import("../../../shared/domain.js").PartialDate | null | undefined, errors: DomainIssue[]): void {
    if (value !== null && value !== undefined) errors.push(...validatePartialDate(value).errors);
  }

  private requireOpenWorkspace(candidate: string, errors: DomainIssue[]): void {
    if (candidate !== this.workspaceId) {
      errors.push(issue("WORKSPACE_MISMATCH", "Draft belongs to a different workspace"));
    }
  }

  private requireVersion(actual: number, expected: number, entityType: string, entityId: string, errors: DomainIssue[]): void {
    if (actual !== expected) {
      errors.push(issue("CONFLICT", "The fact changed since it was read", { entityType, entityId, expectedVersion: expected, actualVersion: actual }));
    }
  }

  private marriageContains(marriage: MarriageRecord, personId: string): boolean {
    return marriage.spouseAId === personId || marriage.spouseBId === personId;
  }

  private mergeValidation(
    result: { errors: DomainIssue[]; warnings: DomainIssue[] },
    errors: DomainIssue[],
    warnings: DomainIssue[]
  ): void {
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  private throwOnErrors(errors: DomainIssue[]): void {
    if (errors.length > 0) throw new FactCommandError(errors);
  }

  private syncAliases(ctx: TransactionContext, personId: string, aliases: string[] | undefined): void {
    if (aliases === undefined) return;
    const desired = new Map<string, string>();
    for (const alias of aliases) {
      const name = alias.trim();
      if (name) desired.set(name.toLowerCase(), name);
    }
    const existing = ctx.people.listAliases(personId);
    for (const alias of existing) {
      if (!desired.has(alias.normalizedName)) ctx.people.archiveAlias(ctx, alias.id);
      else desired.delete(alias.normalizedName);
    }
    for (const name of desired.values()) ctx.people.addAlias(ctx, { personId, name });
  }
}
