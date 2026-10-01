import type { TransactionContext } from "../unit-of-work.js";
import type { WorkspaceDatabase } from "../open-database.js";

export interface ChildrenCountStatus {
  count: number;
  completeness: "partial" | "complete";
}

export interface ChildrenCompletenessRecord {
  id: string;
  workspaceId: string;
  complete: boolean;
  updatedAt: string;
  rowVersion: number;
}

interface CompletenessRow {
  id: string;
  children_complete: number;
  updated_at: string;
  row_version: number;
}

export class CompletenessRepository {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}

  getChildrenCountStatus(personId: string): ChildrenCountStatus {
    const person = this.require(personId);
    const count = Number(this.database.prepare(`
      SELECT COUNT(*)
      FROM parent_child
      WHERE workspace_id = ? AND parent_id = ? AND deleted_at IS NULL
    `).pluck().get(this.workspaceId, personId));
    return { count, completeness: person.children_complete === 1 ? "complete" : "partial" };
  }

  setChildrenCompleteness(ctx: TransactionContext, input: { personId: string; complete: boolean; expectedVersion: number }): ChildrenCompletenessRecord {
    const beforePerson = this.require(input.personId);
    if (beforePerson.row_version !== input.expectedVersion) throw new Error("Person version changed");
    const before: ChildrenCompletenessRecord = {
      id: beforePerson.id,
      workspaceId: this.workspaceId,
      complete: beforePerson.children_complete === 1,
      updatedAt: beforePerson.updated_at,
      rowVersion: beforePerson.row_version
    };
    const now = new Date().toISOString();
    const changed = this.database.prepare(`
      UPDATE person
      SET children_complete = ?, updated_at = ?, row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL AND row_version = ?
    `).run(input.complete ? 1 : 0, now, this.workspaceId, input.personId, input.expectedVersion).changes;
    if (changed !== 1) throw new Error("Person version changed");
    const afterPerson = this.require(input.personId);
    const after: ChildrenCompletenessRecord = {
      id: afterPerson.id,
      workspaceId: this.workspaceId,
      complete: afterPerson.children_complete === 1,
      updatedAt: afterPerson.updated_at,
      rowVersion: afterPerson.row_version
    };
    ctx.audit.append({ entityType: "person_completeness", entityId: input.personId, action: "update", before, after });
    return after;
  }

  private require(personId: string): CompletenessRow {
    const person = this.database.prepare(`
      SELECT id, children_complete, updated_at, row_version
      FROM person
      WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL
    `).get(this.workspaceId, personId) as CompletenessRow | undefined;
    if (!person) throw new Error(`Person not found: ${personId}`);
    return person;
  }
}
