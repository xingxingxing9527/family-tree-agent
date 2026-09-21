import type { FactQueries } from "../facts/fact-queries.js";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import { SourceRepository } from "../../database/repositories/source-repository.js";
import type { PersonQueryReadModel, SourceReadModel } from "../../../shared/contracts.js";

interface SourceIdRow { id: string }

export class QueryNotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
}

const sourceModel = (source: ReturnType<SourceRepository["get"]>): SourceReadModel | null => source ? {
  id: source.id,
  sourceKey: source.sourceKey,
  title: source.title,
  kind: source.kind,
  uri: source.uri,
  citation: source.citation
} : null;

export function getPerson(
  database: WorkspaceDatabase,
  workspaceId: string,
  queries: FactQueries,
  input: { personId: string }
): PersonQueryReadModel {
  const person = queries.getPerson(input.personId);
  if (!person) throw new QueryNotFoundError(`Person not found: ${input.personId}`);
  const sourceIds = database.prepare(`
    SELECT DISTINCT source.id
    FROM source
    JOIN audit_log source_audit
      ON source_audit.workspace_id = source.workspace_id
      AND source_audit.entity_type = 'source'
      AND source_audit.entity_id = source.id
    JOIN audit_log person_audit
      ON person_audit.workspace_id = source_audit.workspace_id
      AND person_audit.operation_group_id = source_audit.operation_group_id
    WHERE source.workspace_id = ?
      AND source.deleted_at IS NULL
      AND person_audit.entity_type = 'person'
      AND person_audit.entity_id = ?
    ORDER BY source.title, source.id
  `).all(workspaceId, person.id) as SourceIdRow[];
  const sources = new SourceRepository(database, workspaceId);
  return {
    id: person.id,
    displayName: person.displayName,
    gender: person.gender,
    birth: person.birth,
    death: person.death,
    notes: person.notes,
    rowVersion: person.rowVersion,
    aliases: queries.listAliases(person.id).map((alias) => alias.name),
    sources: sourceIds.flatMap(({ id }) => {
      const source = sourceModel(sources.get(id));
      return source ? [source] : [];
    })
  };
}
