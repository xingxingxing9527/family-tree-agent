import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  AppErrorCode,
  AppResult,
  FactMutationReceipt,
  MarriageDraft as PublicMarriageDraft,
  ParentChildDraft as PublicParentChildDraft,
  PersonDetailReadModel,
  PersonDraft as PublicPersonDraft,
  PersonListItem,
  PersonPatch as PublicPersonPatch,
  RelatedPersonReadModel
} from "../../../shared/contracts.js";
import type { PartialDate } from "../../../shared/domain.js";
import { applyMigrations } from "../../database/migrations/index.js";
import { openDatabase, type WorkspaceDatabase } from "../../database/open-database.js";
import type { PersonRecord } from "../../database/repositories/person-repository.js";
import type { MarriageRecord, ParentChildRecord } from "../../database/repositories/relation-repository.js";
import type { SourceDraft } from "./fact-commands.js";
import { FactCommandError, FactCommandService } from "./fact-command-service.js";
import { FactQueries } from "./fact-queries.js";
import type { FactsGateway } from "../../ipc/facts-ipc.js";

export interface OpenWorkspaceContext {
  workspaceId: string;
  databasePath: string;
  mediaPath?: string;
}

export interface OpenWorkspaceContextProvider {
  getOpenWorkspaceContext(): OpenWorkspaceContext | null;
  synchronizeOriginPerson?(): Promise<void>;
}

const failure = <T>(code: AppErrorCode, message: string, details?: unknown): AppResult<T> => ({
  ok: false,
  error: { code, message, ...(details === undefined ? {} : { details }) }
});

const source = (description: string, operation: string): SourceDraft => ({
  sourceKey: `form:${operation}:${randomUUID()}`,
  title: description.trim() || "表单录入",
  kind: "form"
});

const receipt = (result: import("./fact-commands.js").MutationResult): FactMutationReceipt => ({
  entityId: result.changedEntityIds[0] ?? null,
  saved: result.changedEntityIds.length > 0,
  warnings: result.warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
    ...(warning.details ? { details: warning.details } : {})
  }))
});

function toListItem(person: PersonRecord, aliases: string[]): PersonListItem {
  return {
    id: person.id,
    displayName: person.displayName,
    aliases,
    gender: person.gender,
    birth: person.birth,
    death: person.death,
    notes: person.notes,
    rowVersion: person.rowVersion
  };
}

export class WorkspaceFactsGateway implements FactsGateway {
  constructor(private readonly workspaces: OpenWorkspaceContextProvider) {}

  async listPeople(input: { query?: string; limit: number; offset: number }): Promise<AppResult<PersonListItem[]>> {
    return this.withWorkspace((database, workspaceId) => {
      const queries = new FactQueries(database, workspaceId);
      const query = input.query?.trim().toLocaleLowerCase() ?? "";
      return queries.listPeople()
        .map((person) => toListItem(person, queries.listAliases(person.id).map((alias) => alias.name)))
        .filter((person) => !query || person.displayName.toLocaleLowerCase().includes(query) || person.aliases.some((alias) => alias.toLocaleLowerCase().includes(query)))
        .slice(input.offset, input.offset + input.limit);
    });
  }

  async getPerson(input: { personId: string }): Promise<AppResult<PersonDetailReadModel>> {
    return this.withWorkspace((database, workspaceId) => {
      const queries = new FactQueries(database, workspaceId);
      const person = queries.getPerson(input.personId);
      if (!person) throw new GatewayError("NOT_FOUND", "Person was not found", { entityId: input.personId });
      const aliases = queries.listAliases(person.id).map((alias) => alias.name);
      const edges = queries.listParentChild();
      const marriages = queries.listMarriages();
      const listItem = (record: PersonRecord): PersonListItem => toListItem(record, queries.listAliases(record.id).map((alias) => alias.name));
      const related = (edge: ParentChildRecord, relatedId: string, role: RelatedPersonReadModel["role"]): RelatedPersonReadModel | null => {
        const record = queries.getPerson(relatedId);
        return record ? { relationId: edge.id, person: listItem(record), role } : null;
      };
      const parents = edges
        .filter((edge) => edge.childId === person.id)
        .map((edge) => related(edge, edge.parentId, edge.parentRole))
        .filter((entry): entry is RelatedPersonReadModel => entry !== null);
      const children = edges
        .filter((edge) => edge.parentId === person.id)
        .map((edge) => related(edge, edge.childId, "child"))
        .filter((entry): entry is RelatedPersonReadModel => entry !== null);
      const marriageModels = marriages
        .filter((marriage) => marriage.spouseAId === person.id || marriage.spouseBId === person.id)
        .map((marriage) => this.marriageReadModel(queries, person.id, marriage))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return {
        person: {
          id: person.id,
          displayName: person.displayName,
          gender: person.gender,
          birth: person.birth,
          death: person.death,
          notes: person.notes,
          rowVersion: person.rowVersion
        },
        aliases,
        parents,
        children,
        marriages: marriageModels
      };
    });
  }

  async savePerson(input: { draft: PublicPersonDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>> {
    const result = this.withWorkspace((database, workspaceId) => {
      const service = new FactCommandService(database, workspaceId);
      return receipt(service.execute({
        type: "person.create",
        draft: {
          workspaceId,
          displayName: input.draft.displayName,
          aliases: input.draft.aliases,
          gender: input.draft.gender,
          birth: input.draft.birth,
          death: input.draft.death,
          notes: input.draft.notes
        },
        source: source(input.draft.sourceDescription, "person-create")
      }, { confirmWarnings: input.confirmWarnings }));
    });
    if (result.ok && result.value.saved) {
      try {
        await this.workspaces.synchronizeOriginPerson?.();
      } catch {
        return failure("INTERNAL", "Unable to publish workspace origin person");
      }
    }
    return result;
  }

  async updatePerson(input: { personId: string; patch: PublicPersonPatch; expectedVersion: number; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>> {
    return this.withWorkspace((database, workspaceId) => {
      const { sourceDescription, ...patch } = input.patch;
      const service = new FactCommandService(database, workspaceId);
      return receipt(service.execute({
        type: "person.update",
        personId: input.personId,
        patch,
        expectedVersion: input.expectedVersion,
        source: source(sourceDescription ?? "表单修订", "person-update")
      }, { confirmWarnings: input.confirmWarnings }));
    });
  }

  async addParentChild(input: { draft: PublicParentChildDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>> {
    return this.withWorkspace((database, workspaceId) => receipt(new FactCommandService(database, workspaceId).execute({
      type: "parentChild.add",
      draft: { workspaceId, parentId: input.draft.parentId, childId: input.draft.childId, parentRole: input.draft.parentRole },
      source: source(input.draft.sourceDescription, "parent-child")
    }, { confirmWarnings: input.confirmWarnings })));
  }

  async addMarriage(input: { draft: PublicMarriageDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>> {
    return this.withWorkspace((database, workspaceId) => receipt(new FactCommandService(database, workspaceId).execute({
      type: "marriage.add",
      draft: { workspaceId, spouseAId: input.draft.spouseAId, spouseBId: input.draft.spouseBId, start: input.draft.start },
      source: source(input.draft.sourceDescription, "marriage")
    }, { confirmWarnings: input.confirmWarnings })));
  }

  async divorce(input: { marriageId: string; endDate: PartialDate | null; expectedVersion: number }): Promise<AppResult<FactMutationReceipt>> {
    return this.withWorkspace((database, workspaceId) => receipt(new FactCommandService(database, workspaceId).execute({
      type: "marriage.divorce",
      marriageId: input.marriageId,
      endDate: input.endDate,
      expectedVersion: input.expectedVersion,
      source: source("离婚登记", "divorce")
    }, { confirmWarnings: true })));
  }

  private marriageReadModel(queries: FactQueries, personId: string, marriage: MarriageRecord): PersonDetailReadModel["marriages"][number] | null {
    const spouseId = marriage.spouseAId === personId ? marriage.spouseBId : marriage.spouseAId;
    const spouse = queries.getPerson(spouseId);
    if (!spouse) return null;
    return {
      id: marriage.id,
      spouse: toListItem(spouse, queries.listAliases(spouse.id).map((alias) => alias.name)),
      status: marriage.status,
      start: marriage.start,
      end: marriage.end,
      rowVersion: marriage.rowVersion
    };
  }

  private withWorkspace<T>(operation: (database: WorkspaceDatabase, workspaceId: string) => T): AppResult<T> {
    const context = this.workspaces.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    if (!existsSync(context.databasePath)) return failure("INTERNAL", "Unable to complete facts request");
    let database: WorkspaceDatabase | null = null;
    try {
      database = openDatabase(context.databasePath);
      applyMigrations(database);
      return { ok: true, value: operation(database, context.workspaceId) };
    } catch (error) {
      if (error instanceof GatewayError) return failure(error.code, error.message, error.details);
      if (error instanceof FactCommandError) {
        const first = error.issues[0];
        const code: AppErrorCode = first?.code === "CONFLICT" ? "CONFLICT" : first?.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION";
        return failure(code, error.message, first?.details);
      }
      return failure("INTERNAL", "Unable to complete facts request");
    } finally {
      database?.close();
    }
  }
}

class GatewayError extends Error {
  constructor(public readonly code: AppErrorCode, message: string, public readonly details?: unknown) {
    super(message);
  }
}
