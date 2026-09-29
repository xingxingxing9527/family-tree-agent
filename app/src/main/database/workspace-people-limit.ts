import type { WorkspaceDatabase } from "./open-database.js";

export const MAX_WORKSPACE_PEOPLE = 1_000;
export const WORKSPACE_PEOPLE_LIMIT_MESSAGE = `A workspace cannot contain more than ${MAX_WORKSPACE_PEOPLE.toLocaleString("en-US")} active people`;

export class WorkspacePeopleLimitError extends Error {
  readonly code = "WORKSPACE_PERSON_LIMIT";

  constructor(public readonly count: number, public readonly maximum = MAX_WORKSPACE_PEOPLE) {
    super(WORKSPACE_PEOPLE_LIMIT_MESSAGE);
    this.name = "WorkspacePeopleLimitError";
  }
}

export function countActiveWorkspacePeople(database: WorkspaceDatabase, workspaceId: string): number {
  return Number(database.prepare("SELECT COUNT(*) FROM person WHERE workspace_id = ? AND deleted_at IS NULL").pluck().get(workspaceId));
}

export function assertWorkspacePeopleWithinLimit(database: WorkspaceDatabase, workspaceId: string): number {
  const count = countActiveWorkspacePeople(database, workspaceId);
  if (count > MAX_WORKSPACE_PEOPLE) throw new WorkspacePeopleLimitError(count);
  return count;
}

export function assertCanActivateWorkspacePeople(database: WorkspaceDatabase, workspaceId: string, additional = 1): void {
  const count = countActiveWorkspacePeople(database, workspaceId);
  if (count + additional > MAX_WORKSPACE_PEOPLE) throw new WorkspacePeopleLimitError(count + additional);
}
