import type {
  SourceReadModel,
  TreeProjectionDto,
  TreeViewDto,
  WorkspaceLineageReadModel,
  WorkspaceSnapshotDto
} from "../../../shared/contracts.js";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import { assertWorkspacePeopleWithinLimit } from "../../database/workspace-people-limit.js";
import { GenerationService, type GenerationDisplay } from "../../domain/lineage/generation-service.js";
import { FactQueries } from "../facts/fact-queries.js";
import { FamilyUnionProjector } from "../../domain/projection/family-union-projector.js";
import { TreeProjectionService } from "../../domain/projection/tree-projection-service.js";
import { RelationshipCalculator } from "../../domain/kinship/relationship-calculator.js";
import { loadPersistedKinshipFacts } from "./persisted-kinship-facts.js";

interface AliasRow { person_id: string; name: string; }
interface SourceRow { id: string; source_key: string; title: string; kind: string | null; uri: string | null; citation: string | null; }
interface LineageRow { id: string; name: string; founder_person_id: string; description: string | null; row_version: number; member_count: number; }
interface SnapshotMembershipRow extends ProjectionMembershipRow { id: string; generation_marker: string | null; row_version: number; }
interface ProjectionLineageRow { id: string; founder_person_id: string; }
interface ProjectionMembershipRow {
  lineage_id: string;
  person_id: string;
  lineage_role: "blood" | "married_in" | "associated";
  is_primary: number;
  declared_generation: number | null;
  generation_marker: string | null;
}

export function readWorkspaceSnapshot(database: WorkspaceDatabase, workspaceId: string): WorkspaceSnapshotDto {
  assertWorkspacePeopleWithinLimit(database, workspaceId);
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
    personCode: person.personCode,
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
  const lineageRows = database.prepare(`
    SELECT l.id, l.name, l.founder_person_id, l.description, l.row_version,
      COUNT(m.id) AS member_count
    FROM lineage l
    LEFT JOIN lineage_membership m ON m.workspace_id = l.workspace_id
      AND m.lineage_id = l.id AND m.deleted_at IS NULL
    WHERE l.workspace_id = ? AND l.deleted_at IS NULL
    GROUP BY l.id, l.name, l.founder_person_id, l.description, l.row_version
    ORDER BY l.name, l.id
  `).all(workspaceId) as LineageRow[];
  const membershipRows = database.prepare(`
    SELECT id, lineage_id, person_id, lineage_role, is_primary, declared_generation, generation_marker, row_version
    FROM lineage_membership
    WHERE workspace_id = ? AND deleted_at IS NULL
    ORDER BY lineage_id, person_id, id
  `).all(workspaceId) as SnapshotMembershipRow[];
  const membershipByLineage = new Map<string, SnapshotMembershipRow[]>();
  for (const membership of membershipRows) membershipByLineage.set(membership.lineage_id, [...(membershipByLineage.get(membership.lineage_id) ?? []), membership]);
  const parentChildFacts = queries.listParentChild().map((fact) => ({ parentId: fact.parentId, childId: fact.childId, relationshipType: fact.relationshipType }));
  const generationService = new GenerationService();
  const lineages = lineageRows.map((lineage): WorkspaceLineageReadModel => {
    const lineageMemberships = membershipByLineage.get(lineage.id) ?? [];
    const generations = generationService.calculate({
      founderPersonId: lineage.founder_person_id,
      memberships: lineageMemberships.map((membership) => ({ personId: membership.person_id, lineageRole: membership.lineage_role, declaredGeneration: membership.declared_generation })),
      parentChildFacts
    });
    return {
      id: lineage.id,
      name: lineage.name,
      founderPersonId: lineage.founder_person_id,
      description: lineage.description,
      memberCount: lineage.member_count,
      rowVersion: lineage.row_version,
      memberships: lineageMemberships.map((membership) => ({
        id: membership.id,
        lineageId: membership.lineage_id,
        personId: membership.person_id,
        role: membership.lineage_role,
        isPrimary: membership.is_primary === 1,
        declaredGeneration: membership.declared_generation,
        generationMarker: membership.generation_marker,
        generation: generations[membership.person_id] ?? { declared: membership.declared_generation, computed: null, displayed: membership.declared_generation, source: membership.declared_generation === null ? "none" : "declared", conflict: false },
        rowVersion: membership.row_version
      }))
    };
  });
  return { workspaceId, people, sources, lineages };
}

export function projectWorkspaceTree(
  database: WorkspaceDatabase,
  workspaceId: string,
  input: { view: TreeViewDto; subjectId?: string; viewpointId?: string; collapseDepth?: number }
): TreeProjectionDto {
  assertWorkspacePeopleWithinLimit(database, workspaceId);
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
  const calculator = new RelationshipCalculator(loadPersistedKinshipFacts(queries, {
    people,
    parentChild,
    marriages
  }));
  const lineages = database.prepare(`
    SELECT id, founder_person_id FROM lineage
    WHERE workspace_id = ? AND deleted_at IS NULL
    ORDER BY id
  `).all(workspaceId) as ProjectionLineageRow[];
  const memberships = database.prepare(`
    SELECT lineage_id, person_id, lineage_role, is_primary, declared_generation, generation_marker
    FROM lineage_membership
    WHERE workspace_id = ? AND deleted_at IS NULL
    ORDER BY lineage_id, person_id, id
  `).all(workspaceId) as ProjectionMembershipRow[];
  const membershipsByLineage = new Map<string, ProjectionMembershipRow[]>();
  for (const membership of memberships) {
    const grouped = membershipsByLineage.get(membership.lineage_id) ?? [];
    grouped.push(membership);
    membershipsByLineage.set(membership.lineage_id, grouped);
  }
  const parentChildFacts = parentChild.map((fact) => ({
    parentId: fact.parentId,
    childId: fact.childId,
    relationshipType: fact.relationshipType
  }));
  const generations = new GenerationService();
  const generationByPerson = new Map<string, GenerationDisplay>();
  const generationMarkerByPerson = new Map<string, string | null>();
  for (const lineage of lineages) {
    const lineageMemberships = membershipsByLineage.get(lineage.id) ?? [];
    const displays = generations.calculate({
      founderPersonId: lineage.founder_person_id,
      memberships: lineageMemberships.map((membership) => ({
        personId: membership.person_id,
        lineageRole: membership.lineage_role,
        declaredGeneration: membership.declared_generation
      })),
      parentChildFacts
    });
    for (const membership of lineageMemberships) {
      if (membership.is_primary !== 1) continue;
      const display = displays[membership.person_id];
      if (display) {
        generationByPerson.set(membership.person_id, display);
        generationMarkerByPerson.set(membership.person_id, membership.generation_marker);
      }
    }
  }
  const primaryTerms = input.viewpointId
    ? calculator.calculatePrimaryTerms(input.viewpointId, people.map((person) => person.id))
    : null;
  const service = new TreeProjectionService({
    people: people.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      birthYear: person.birth?.year ?? null,
      deathYear: person.death?.year ?? null,
      generation: generationByPerson.get(person.id) ?? null,
      generationMarker: generationMarkerByPerson.get(person.id) ?? null
    })),
    unions
  }, (viewpointId, targetPersonId) => primaryTerms && viewpointId === input.viewpointId
    ? primaryTerms.get(targetPersonId) ?? null
    : calculator.calculateRelationship(viewpointId, targetPersonId).primaryTerm);
  const subjectId = input.subjectId ?? "";
  const topologyProjection = input.view === "branch" ? service.branch(subjectId)
    : input.view === "ancestors" ? service.ancestors(subjectId)
      : input.view === "descendants" ? service.descendants(subjectId)
        : service.full("", input.collapseDepth ?? 4);
  return input.viewpointId ? service.withViewpoint(topologyProjection, input.viewpointId) : topologyProjection;
}
