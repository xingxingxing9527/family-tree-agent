import { z } from "zod";
import type {
  LineageSummary,
  PersonCandidate,
  PersonQueryReadModel,
  RelativeKind,
  RelativeReadModel,
  RelationshipResultDto,
  WikiSearchHit
} from "../../../shared/contracts.js";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import { RelationshipCalculator } from "../../domain/kinship/relationship-calculator.js";
import { FactQueries } from "../facts/fact-queries.js";
import { CompletenessRepository, type ChildrenCountStatus } from "../../database/repositories/completeness-repository.js";
import { SourceRepository } from "../../database/repositories/source-repository.js";
import { getPerson } from "./get-person.js";
import { listRelatives } from "./list-relatives.js";
import { personCandidate, searchPeople } from "./search-people.js";
import { searchWiki } from "./search-wiki.js";
import { summarizeLineage } from "./summarize-lineage.js";
import { loadPersistedKinshipFacts } from "./persisted-kinship-facts.js";

const id = z.string().trim().min(1).max(200);
const query = z.string().trim().min(1).max(200);

export const QUERY_TOOL_SCHEMAS = {
  search_people: z.object({ query, limit: z.number().int().min(1).max(100) }).strict(),
  get_person: z.object({ personId: id }).strict(),
  list_relatives: z.object({
    personId: id,
    kinds: z.array(z.enum(["parent", "spouse", "child"])).min(1).max(3)
  }).strict(),
  calculate_relationship: z.object({ viewpointId: id, targetId: id }).strict(),
  summarize_lineage: z.object({ lineageId: id, generation: z.number().int().min(1).optional() }).strict(),
  search_wiki: z.object({ query, limit: z.number().int().min(1).max(10_000) }).strict()
} as const;

export type QueryToolName = keyof typeof QUERY_TOOL_SCHEMAS;

export interface QueryToolMap {
  search_people(input: { query: string; limit: number }): PersonCandidate[];
  get_person(input: { personId: string }): PersonQueryReadModel;
  list_relatives(input: { personId: string; kinds: RelativeKind[] }): RelativeReadModel[];
  calculate_relationship(input: { viewpointId: string; targetId: string }): RelationshipResultDto;
  summarize_lineage(input: { lineageId: string; generation?: number }): LineageSummary;
  search_wiki(input: { query: string; limit: number }): WikiSearchHit[];
}

export class QueryToolRegistry {
  readonly tools: Readonly<QueryToolMap>;
  private readonly queries: FactQueries;

  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {
    this.queries = new FactQueries(database, workspaceId);
    const tools: QueryToolMap = {
      search_people: (input) => searchPeople(this.queries, QUERY_TOOL_SCHEMAS.search_people.parse(input)),
      get_person: (input) => getPerson(database, workspaceId, this.queries, QUERY_TOOL_SCHEMAS.get_person.parse(input)),
      list_relatives: (input) => listRelatives(this.queries, QUERY_TOOL_SCHEMAS.list_relatives.parse(input)),
      calculate_relationship: (input) => {
        const parsed = QUERY_TOOL_SCHEMAS.calculate_relationship.parse(input);
        return new RelationshipCalculator(loadPersistedKinshipFacts(this.queries))
          .calculateRelationship(parsed.viewpointId, parsed.targetId);
      },
      summarize_lineage: (input) => summarizeLineage(database, workspaceId, this.queries, QUERY_TOOL_SCHEMAS.summarize_lineage.parse(input)),
      search_wiki: (input) => searchWiki(database, workspaceId, QUERY_TOOL_SCHEMAS.search_wiki.parse(input))
    };
    this.tools = Object.freeze(tools);
  }

  findMentionedPeople(text: string): Array<{ mention: string; candidates: PersonCandidate[] }> {
    const groups = new Map<string, { mention: string; candidates: PersonCandidate[]; index: number }>();
    for (const person of this.queries.listPeople()) {
      const names = [person.displayName, ...this.queries.listAliases(person.id).map((alias) => alias.name)]
        .filter((name) => text.includes(name))
        .sort((left, right) => right.length - left.length || left.localeCompare(right));
      const mention = names[0];
      if (!mention) continue;
      const candidate = personCandidate(this.queries, person.id);
      if (!candidate) continue;
      const key = mention.toLocaleLowerCase();
      const group = groups.get(key) ?? { mention, candidates: [], index: text.indexOf(mention) };
      group.candidates.push(candidate);
      groups.set(key, group);
    }
    return [...groups.values()]
      .sort((left, right) => left.index - right.index || right.mention.length - left.mention.length)
      .map(({ mention, candidates }) => ({ mention, candidates: candidates.sort((left, right) => left.id.localeCompare(right.id)) }));
  }

  getChildrenCountStatus(personId: string): ChildrenCountStatus {
    return new CompletenessRepository(this.database, this.workspaceId).getChildrenCountStatus(personId);
  }

  resolveSources(sourceIds: readonly string[]): Array<{ id: string; title: string }> {
    const sources = new SourceRepository(this.database, this.workspaceId);
    return [...new Set(sourceIds)].flatMap((sourceId) => {
      const source = sources.get(sourceId);
      return source ? [{ id: source.id, title: source.title }] : [];
    });
  }

  sourceIdsForFacts(factIds: readonly string[]): string[] {
    const ids = [...new Set(factIds)];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.database.prepare(`
      SELECT DISTINCT source.id
      FROM source
      JOIN audit_log AS source_audit
        ON source_audit.workspace_id = source.workspace_id
        AND source_audit.entity_type = 'source'
        AND source_audit.entity_id = source.id
      JOIN audit_log AS fact_audit
        ON fact_audit.workspace_id = source_audit.workspace_id
        AND fact_audit.operation_group_id = source_audit.operation_group_id
      WHERE source.workspace_id = ?
        AND source.deleted_at IS NULL
        AND fact_audit.entity_id IN (${placeholders})
      ORDER BY source.title, source.id
    `).pluck().all(this.workspaceId, ...ids) as string[];
  }
}

export { QueryNotFoundError } from "./get-person.js";
