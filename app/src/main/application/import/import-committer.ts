import type { WorkspaceDatabase } from "../../database/open-database.js";
import { ImportIdentityRepository } from "../../database/repositories/import-identity-repository.js";
import { PersonRepository } from "../../database/repositories/person-repository.js";
import { createUnitOfWork, type TransactionContext } from "../../database/unit-of-work.js";
import { FactCommandService } from "../facts/fact-command-service.js";
import type { SourceDraft } from "../facts/fact-commands.js";
import { ImportPlanStore } from "./import-planner.js";
import type { ImportAction, ImportCommitReport, ImportPersonPayload } from "./import-types.js";

const priority: Readonly<Record<ImportAction["entityType"], number>> = { person: 0, parentChild: 1, marriage: 2 };

export class ImportCommitter {
  private readonly people: PersonRepository;
  private readonly identities: ImportIdentityRepository;
  private readonly facts: FactCommandService;

  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly workspaceId: string,
    private readonly store: ImportPlanStore
  ) {
    this.people = new PersonRepository(database, workspaceId);
    this.identities = new ImportIdentityRepository(database, workspaceId);
    this.facts = new FactCommandService(database, workspaceId);
  }

  commitImport(planId: string, selectedActionIds: string[]): ImportCommitReport {
    const plan = this.store.get(planId);
    if (!plan) throw new Error("Import plan was not found or expired");
    if (new Set(selectedActionIds).size !== selectedActionIds.length) throw new Error("Selected import actions must be unique");
    const selected = new Set(selectedActionIds);
    const selectedActions = plan.actions
      .filter((action) => selected.has(action.id))
      .sort((left, right) => priority[left.entityType] - priority[right.entityType] || left.sourceRow.row - right.sourceRow.row);
    if (selectedActions.length !== selected.size) throw new Error("A selected import action does not belong to this plan");
    if (selectedActions.some((action) => action.kind !== "create" && action.kind !== "update")) {
      throw new Error("Only create and update actions can be committed");
    }
    if (selectedActions.length === 0) return this.report(plan, selected, null, new Map());

    const committed = createUnitOfWork(this.database, this.workspaceId).run("spreadsheet.import", (ctx) => {
      this.revalidate(selectedActions, plan.sourceKey);
      const existingSource = ctx.sources.getByKey(plan.sourceKey);
      const source = existingSource ?? ctx.sources.create(ctx, {
        sourceKey: plan.sourceKey,
        title: plan.fileName,
        kind: "spreadsheet-import"
      });
      const commandSource: SourceDraft = {
        sourceKey: plan.sourceKey,
        title: plan.fileName,
        kind: "spreadsheet-import"
      };
      const entities = new Map<string, string>();
      for (const action of selectedActions) {
        const entityId = this.commitAction(ctx, action, source.id, commandSource, plan.sourceKey);
        entities.set(action.id, entityId);
      }
      return { operationGroupId: ctx.operationGroupId, entities };
    });

    return this.report(plan, selected, committed.operationGroupId, committed.entities);
  }

  private revalidate(actions: ImportAction[], sourceKey: string): void {
    for (const action of actions) {
      if (action.entityType !== "person") continue;
      const payload = action.payload as ImportPersonPayload;
      const identity = this.identities.get(sourceKey, payload.externalId);
      if (action.kind === "create") {
        if (identity) throw new Error(`Import identity changed since preview: ${payload.externalId}`);
        continue;
      }
      if (!identity || identity.personId !== action.entityId) throw new Error(`Import identity changed since preview: ${payload.externalId}`);
      const person = action.entityId ? this.people.get(action.entityId) : null;
      if (!person || person.rowVersion !== action.expectedRowVersion) throw new Error(`Person changed since preview: ${payload.externalId}`);
    }
  }

  private commitAction(
    ctx: TransactionContext,
    action: ImportAction,
    sourceId: string,
    commandSource: SourceDraft,
    sourceKey: string
  ): string {
    if (action.payload.type === "person") {
      const payload = action.payload;
      if (action.kind === "create") {
        const result = this.facts.executeInTransaction(ctx, {
          type: "person.create",
          draft: {
            id: payload.newEntityId,
            workspaceId: this.workspaceId,
            displayName: payload.displayName,
            gender: payload.gender,
            birth: payload.birth,
            notes: payload.notes
          },
          source: commandSource
        }, { confirmWarnings: true, recordSource: false });
        ctx.importIdentities.create(ctx, {
          sourceId,
          sourceKey,
          externalPersonId: payload.externalId,
          personId: result.changedEntityIds[0]!,
          raw: action.sourceRow.raw
        });
        return result.changedEntityIds[0]!;
      }
      const result = this.facts.executeInTransaction(ctx, {
        type: "person.update",
        personId: action.entityId!,
        expectedVersion: action.expectedRowVersion!,
        patch: {
          displayName: payload.displayName,
          gender: payload.gender,
          birth: payload.birth,
          notes: payload.notes
        },
        source: commandSource
      }, { confirmWarnings: true, recordSource: false });
      ctx.importIdentities.update(ctx, { sourceId, sourceKey, externalPersonId: payload.externalId, raw: action.sourceRow.raw });
      return result.changedEntityIds[0]!;
    }

    if (action.payload.type === "parentChild") {
      const parent = this.requireImportedPerson(sourceKey, action.payload.parentExternalId);
      const child = this.requireImportedPerson(sourceKey, action.payload.childExternalId);
      return this.facts.executeInTransaction(ctx, {
        type: "parentChild.add",
        draft: {
          workspaceId: this.workspaceId,
          parentId: parent,
          childId: child,
          parentRole: action.payload.parentRole
        },
        source: commandSource
      }, { confirmWarnings: true, recordSource: false }).changedEntityIds[0]!;
    }

    const spouseA = this.requireImportedPerson(sourceKey, action.payload.spouseAExternalId);
    const spouseB = this.requireImportedPerson(sourceKey, action.payload.spouseBExternalId);
    return this.facts.executeInTransaction(ctx, {
      type: "marriage.add",
      draft: {
        workspaceId: this.workspaceId,
        spouseAId: spouseA,
        spouseBId: spouseB,
        status: action.payload.status,
        start: action.payload.start,
        end: action.payload.end
      },
      source: commandSource
    }, { confirmWarnings: true, recordSource: false }).changedEntityIds[0]!;
  }

  private requireImportedPerson(sourceKey: string, externalId: string): string {
    const identity = this.identities.get(sourceKey, externalId);
    if (!identity || !this.people.get(identity.personId)) throw new Error(`External person reference is unavailable: ${externalId}`);
    return identity.personId;
  }

  private report(
    plan: NonNullable<ReturnType<ImportPlanStore["get"]>>,
    selected: Set<string>,
    operationGroupId: string | null,
    entities: Map<string, string>
  ): ImportCommitReport {
    const issueById = new Map(plan.issues.map((issue) => [issue.id, issue]));
    return {
      planId: plan.id,
      sourceKey: plan.sourceKey,
      operationGroupId,
      rows: plan.actions.map((action) => ({
        actionId: action.id,
        sheet: action.sourceRow.sheet,
        row: action.sourceRow.row,
        disposition: action.kind === "blocked" ? "blocked" : action.kind === "unchanged" ? "unchanged" : selected.has(action.id) ? "committed" : "excluded",
        entityId: entities.get(action.id) ?? action.entityId ?? null,
        operationGroupId: entities.has(action.id) ? operationGroupId : null,
        issueCodes: action.issueIds.map((id) => issueById.get(id)?.code).filter((code): code is string => Boolean(code))
      }))
    };
  }
}
