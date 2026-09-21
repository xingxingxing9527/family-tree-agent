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
import { getPerson } from "./get-person.js";
import { listRelatives } from "./list-relatives.js";
import { searchPeople } from "./search-people.js";
import { searchWiki } from "./search-wiki.js";
import { summarizeLineage } from "./summarize-lineage.js";

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
        return new RelationshipCalculator({
          people: this.queries.listPeople().map((person) => ({ id: person.id, gender: person.gender, birth: person.birth })),
          parentChild: this.queries.listParentChild().map((relation) => ({
            id: relation.id,
            parentId: relation.parentId,
            childId: relation.childId,
            parentRole: relation.parentRole
          })),
          marriages: this.queries.listMarriages().map((marriage) => ({
            id: marriage.id,
            spouseAId: marriage.spouseAId,
            spouseBId: marriage.spouseBId,
            status: marriage.status
          }))
        }).calculateRelationship(parsed.viewpointId, parsed.targetId);
      },
      summarize_lineage: (input) => summarizeLineage(database, workspaceId, this.queries, QUERY_TOOL_SCHEMAS.summarize_lineage.parse(input)),
      search_wiki: (input) => searchWiki(database, workspaceId, QUERY_TOOL_SCHEMAS.search_wiki.parse(input))
    };
    this.tools = Object.freeze(tools);
  }
}

export { QueryNotFoundError } from "./get-person.js";
