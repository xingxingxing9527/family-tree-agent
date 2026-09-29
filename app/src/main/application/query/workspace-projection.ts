import type {
  SourceReadModel,
  TreeProjectionDto,
  TreeViewDto,
  WorkspaceLineageReadModel,
  WorkspaceSnapshotDto
} from "../../../shared/contracts.js";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import { LineageService } from "../lineages/lineage-service.js";
import { FactQueries } from "../facts/fact-queries.js";
import { FamilyUnionProjector } from "../../domain/projection/family-union-projector.js";
import { TreeProjectionService } from "../../domain/projection/tree-projection-service.js";
import { RelationshipCalculator } from "../../domain/kinship/relationship-calculator.js";

interface AliasRow { person_id: string; name: string; }
interface SourceRow { id: string; source_key: string; title: string; kind: string | null; uri: string | null; citation: string | null; }
interface LineageRow { id: string; name: string; founder_person_id: string; description: string | null; row_version: number; member_count: number; }
interface PrimaryMembershipRow { person_id: string; lineage_id: string; }

export function readWorkspaceSnapshot(database: WorkspaceDatabase, workspaceId: string): WorkspaceSnapshotDto {
  const queries = new FactQueries(database, workspaceId);
  const aliases = database.prepare(`
    SELECT person_id, name FROM person_alias
    WHERE workspace_id = ? AND deleted_at IS NULL
    ORDER BY person_id, name, id
  `).all(workspaceId) as AliasRow[];
  const aliasesByPerson = new Map<string, string[]>();
  for (const alias of aliases) {
    const current = aliasesByPerson.get(alias.person_id) ?? [];
    current.push(alias.name);
    aliasesByPerson.set(alias.person_id, current);
  }
  const people = queries.listPeople().map((person) => ({
    id: person.id,
    displayName: person.displayName,
    aliases: aliasesByPerson.get(person.id) ?? [],
    gender: person.gender,
    birth: person.birth,
    death: person.death,
    notes: person.notes,
    rowVersion: person.rowVersion
  }));
  const sources = (database.prepare(`
    SELECT id, source_key, title, kind, uri, citation FROM source
    WHERE workspace_id = ? AND deleted_at IS NULL
    ORDER BY title, id
  `).all(workspaceId) as SourceRow[]).map((source): SourceReadModel => ({
    id: source.id,
    sourceKey: source.source_key,
    title: source.title,
    kind: source.kind,
    uri: source.uri,
    citation: source.citation
  }));
  const lineages = (database.prepare(`
    SELECT l.id, l.name, l.founder_person_id, l.description, l.row_version,
      COUNT(m.id) AS member_count
    FROM lineage l
    LEFT JOIN lineage_membership m ON m.workspace_id = l.workspace_id
      AND m.lineage_id = l.id AND m.deleted_at IS NULL
    WHERE l.workspace_id = ? AND l.deleted_at IS NULL
    GROUP BY l.id, l.name, l.founder_person_id, l.description, l.row_version
    ORDER BY l.name, l.id
  `).all(workspaceId) as LineageRow[]).map((lineage): WorkspaceLineageReadModel => ({
    id: lineage.id,
    name: lineage.name,
    founderPersonId: lineage.founder_person_id,
    description: lineage.description,
    memberCount: lineage.member_count,
    rowVersion: lineage.row_version
  }));
  return { workspaceId, people, sources, lineages };
}

export function projectWorkspaceTree(
  database: WorkspaceDatabase,
  workspaceId: string,
  input: { view: TreeViewDto; subjectId?: string; viewpointId?: string; collapseDepth?: number }
): TreeProjectionDto {
  const queries = new FactQueries(database, workspaceId);
  const people = queries.listPeople();
  const parentChild = queries.listParentChild();
  const marriages = queries.listMarriages();
  const unions = new FamilyUnionProjector().project({
    people: people.map((person) => ({ id: person.id, birth: person.birth })),
    marriages: marriages.map((marriage) => ({
      id: marriage.id,
      spouseAId: marriage.spouseAId,
      spouseBId: marriage.spouseBId,
      status: marriage.status,
      start: marriage.start,
      end: marriage.end
    })),
    parentChildFacts: parentChild.map((fact) => ({
      parentId: fact.parentId,
      childId: fact.childId,
      relationshipType: fact.relationshipType
    }))
  });
  const calculator = new RelationshipCalculator({
    people: people.map((person) => ({ id: person.id, gender: person.gender, birth: person.birth })),
    parentChild: parentChild.map((fact) => ({ id: fact.id, parentId: fact.parentId, childId: fact.childId, parentRole: fact.parentRole })),
    marriages: marriages.map((marriage) => ({ id: marriage.id, spouseAId: marriage.spouseAId, spouseBId: marriage.spouseBId, status: marriage.status }))
  });
  const primaryMemberships = database.prepare(`
    SELECT person_id, lineage_id FROM lineage_membership
    WHERE workspace_id = ? AND deleted_at IS NULL AND is_primary = 1
    ORDER BY person_id, id
  `).all(workspaceId) as PrimaryMembershipRow[];
  const generationByPerson = new Map<string, ReturnType<LineageService["generationDisplays"]>[string]>();
  const lineageIds = [...new Set(primaryMemberships.map((membership) => membership.lineage_id))];
  const lineageService = new LineageService(database, workspaceId);
  for (const lineageId of lineageIds) {
    const displays = lineageService.generationDisplays(lineageId);
    for (const membership of primaryMemberships.filter((candidate) => candidate.lineage_id === lineageId)) {
      const display = displays[membership.person_id];
      if (display) generationByPerson.set(membership.person_id, display);
    }
  }
  const service = new TreeProjectionService({
    people: people.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      birthYear: person.birth?.year ?? null,
      deathYear: person.death?.year ?? null,
      generation: generationByPerson.get(person.id) ?? null
    })),
    unions
  }, (viewpointId, targetPersonId) => calculator.calculateRelationship(viewpointId, targetPersonId).primaryTerm);
  const subjectId = input.subjectId ?? "";
  const topologyProjection = input.view === "branch" ? service.branch(subjectId)
    : input.view === "ancestors" ? service.ancestors(subjectId)
      : input.view === "descendants" ? service.descendants(subjectId)
        : service.full("", input.collapseDepth ?? 4);
  return input.viewpointId ? service.withViewpoint(topologyProjection, input.viewpointId) : topologyProjection;
}
