import { existsSync } from "node:fs";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { ZodError, z, type ZodType } from "zod";
import type {
  AppResult,
  LineageSummary,
  PersonCandidate,
  PersonQueryReadModel,
  RelativeKind,
  RelativeReadModel,
  RelationshipResultDto,
  TreeProjectionDto,
  TreeViewDto,
  WorkspaceSnapshotDto,
  WikiSearchHit
} from "../../shared/contracts.js";
import { openQueryDatabase } from "../database/open-query-database.js";
import type { WorkspaceDatabase } from "../database/open-database.js";
import type { OpenWorkspaceContextProvider } from "../application/facts/facts-gateway.js";
import { QUERY_TOOL_SCHEMAS, QueryNotFoundError, QueryToolRegistry } from "../application/query/query-tool-registry.js";
import type { WorkspaceMutationGate } from "../workspaces/workspace-mutation-gate.js";
import { projectWorkspaceTree, readWorkspaceSnapshot } from "../application/query/workspace-projection.js";
import { WorkspacePeopleLimitError, WORKSPACE_PEOPLE_LIMIT_MESSAGE } from "../database/workspace-people-limit.js";

export const QUERY_CHANNELS = {
  workspaceSnapshot: "query:workspace-snapshot",
  projectTree: "query:project-tree",
  searchPeople: "query:search-people",
  getPerson: "query:get-person",
  listRelatives: "query:list-relatives",
  calculateRelationship: "query:calculate-relationship",
  summarizeLineage: "query:summarize-lineage",
  searchWiki: "query:search-wiki"
} as const;

export interface QueryGateway {
  workspaceSnapshot(): Promise<AppResult<WorkspaceSnapshotDto>>;
  projectTree(input: { view: TreeViewDto; subjectId?: string; viewpointId?: string; collapseDepth?: number }): Promise<AppResult<TreeProjectionDto>>;
  searchPeople(input: { query: string; limit: number }): Promise<AppResult<PersonCandidate[]>>;
  getPerson(input: { personId: string }): Promise<AppResult<PersonQueryReadModel>>;
  listRelatives(input: { personId: string; kinds: RelativeKind[] }): Promise<AppResult<RelativeReadModel[]>>;
  calculateRelationship(input: { viewpointId: string; targetId: string }): Promise<AppResult<RelationshipResultDto>>;
  summarizeLineage(input: { lineageId: string; generation?: number }): Promise<AppResult<LineageSummary>>;
  searchWiki(input: { query: string; limit: number }): Promise<AppResult<WikiSearchHit[]>>;
}

const failure = <T>(code: "VALIDATION" | "NOT_FOUND" | "PATH_DENIED" | "INTERNAL", message: string, details?: unknown): AppResult<T> => ({
  ok: false,
  error: { code, message, ...(details === undefined ? {} : { details }) }
});

export class WorkspaceQueryGateway implements QueryGateway {
  constructor(private readonly workspaces: OpenWorkspaceContextProvider) {}

  async workspaceSnapshot(): Promise<AppResult<WorkspaceSnapshotDto>> {
    return this.readDatabase((database, workspaceId) => readWorkspaceSnapshot(database, workspaceId));
  }

  async projectTree(input: { view: TreeViewDto; subjectId?: string; viewpointId?: string; collapseDepth?: number }): Promise<AppResult<TreeProjectionDto>> {
    return this.readDatabase((database, workspaceId) => projectWorkspaceTree(database, workspaceId, input));
  }

  async searchPeople(input: { query: string; limit: number }): Promise<AppResult<PersonCandidate[]>> {
    return this.read((tools) => tools.search_people(input));
  }

  async getPerson(input: { personId: string }): Promise<AppResult<PersonQueryReadModel>> {
    return this.read((tools) => tools.get_person(input));
  }

  async listRelatives(input: { personId: string; kinds: RelativeKind[] }): Promise<AppResult<RelativeReadModel[]>> {
    return this.read((tools) => tools.list_relatives(input));
  }

  async calculateRelationship(input: { viewpointId: string; targetId: string }): Promise<AppResult<RelationshipResultDto>> {
    return this.read((tools) => tools.calculate_relationship(input));
  }

  async summarizeLineage(input: { lineageId: string; generation?: number }): Promise<AppResult<LineageSummary>> {
    return this.read((tools) => tools.summarize_lineage(input));
  }

  async searchWiki(input: { query: string; limit: number }): Promise<AppResult<WikiSearchHit[]>> {
    return this.read((tools) => tools.search_wiki(input));
  }

  private read<T>(operation: (tools: QueryToolRegistry["tools"]) => T): AppResult<T> {
    return this.readDatabase((database, workspaceId) => operation(new QueryToolRegistry(database, workspaceId).tools));
  }

  private readDatabase<T>(operation: (database: WorkspaceDatabase, workspaceId: string) => T): AppResult<T> {
    const context = this.workspaces.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    if (!existsSync(context.databasePath)) return failure("INTERNAL", "Unable to complete query request");
    let database: WorkspaceDatabase | null = null;
    try {
      database = openQueryDatabase(context.databasePath);
      return { ok: true, value: operation(database, context.workspaceId) };
    } catch (error) {
      if (error instanceof QueryNotFoundError) return failure("NOT_FOUND", "Requested record was not found");
      if (error instanceof WorkspacePeopleLimitError) return failure("VALIDATION", WORKSPACE_PEOPLE_LIMIT_MESSAGE, { code: error.code });
      if (error instanceof ZodError) return failure("VALIDATION", "Invalid request");
      return failure("INTERNAL", "Unable to complete query request");
    } finally {
      database?.close();
    }
  }
}

const emptySchema = z.object({}).strict();
const boundedId = z.string().trim().min(1).max(200);
const projectTreeSchema = z.object({
  view: z.enum(["full", "branch", "ancestors", "descendants"]),
  subjectId: boundedId.optional(),
  viewpointId: boundedId.optional(),
  collapseDepth: z.number().int().min(0).max(20).optional()
}).strict().superRefine((input, context) => {
  if (input.view !== "full" && !input.subjectId) context.addIssue({ code: "custom", path: ["subjectId"], message: "A subject is required for this tree view" });
});

type IpcMainLike = Pick<IpcMain, "handle">;
type Operation = (input: never) => Promise<AppResult<unknown>>;

const sanitizeResult = <T>(result: AppResult<T>): AppResult<T> => {
  if (result.ok) return result;
  if (result.error.code === "INTERNAL") return failure("INTERNAL", "Unable to complete query request");
  const code = new Set(["VALIDATION", "NOT_FOUND", "PATH_DENIED"] as const).has(result.error.code as never)
    ? result.error.code as "VALIDATION" | "NOT_FOUND" | "PATH_DENIED"
    : "INTERNAL";
  if (code === "INTERNAL") return failure("INTERNAL", "Unable to complete query request");
  const details = result.error.details && typeof result.error.details === "object" && !Array.isArray(result.error.details)
    ? Object.fromEntries(Object.entries(result.error.details as Record<string, unknown>)
      .filter(([key, value]) => ["field", "entityId", "code"].includes(key)
        && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")))
    : undefined;
  return failure(code, String(result.error.message).slice(0, 500), details && Object.keys(details).length > 0 ? details : undefined);
};

const parsedHandler = (
  trusted: (event: IpcMainInvokeEvent) => boolean,
  schema: ZodType,
  operation: Operation
) => async (event: IpcMainInvokeEvent, input: unknown): Promise<AppResult<unknown>> => {
  if (!trusted(event)) return failure("PATH_DENIED", "IPC sender was denied");
  const parsed = schema.safeParse(input);
  if (!parsed.success) return failure("VALIDATION", "Invalid request", { field: parsed.error.issues[0]?.path.join(".") || "request" });
  try {
    return sanitizeResult(await operation(parsed.data as never));
  } catch {
    return failure("INTERNAL", "Unable to complete query request");
  }
};

export function registerQueryIpc(ipc: IpcMainLike, mainWindowId: () => number | undefined, query: QueryGateway, operations?: WorkspaceMutationGate): void {
  const trusted = (event: IpcMainInvokeEvent) => event.sender.id === mainWindowId();
  const run = <T>(operation: () => Promise<T>): Promise<T> => operations ? operations.runOperation(operation) : operation();
  ipc.handle(QUERY_CHANNELS.workspaceSnapshot, parsedHandler(trusted, emptySchema, () => run(() => query.workspaceSnapshot())));
  ipc.handle(QUERY_CHANNELS.projectTree, parsedHandler(trusted, projectTreeSchema, (input) => run(() => query.projectTree(input))));
  ipc.handle(QUERY_CHANNELS.searchPeople, parsedHandler(trusted, QUERY_TOOL_SCHEMAS.search_people, (input) => run(() => query.searchPeople(input))));
  ipc.handle(QUERY_CHANNELS.getPerson, parsedHandler(trusted, QUERY_TOOL_SCHEMAS.get_person, (input) => run(() => query.getPerson(input))));
  ipc.handle(QUERY_CHANNELS.listRelatives, parsedHandler(trusted, QUERY_TOOL_SCHEMAS.list_relatives, (input) => run(() => query.listRelatives(input))));
  ipc.handle(QUERY_CHANNELS.calculateRelationship, parsedHandler(trusted, QUERY_TOOL_SCHEMAS.calculate_relationship, (input) => run(() => query.calculateRelationship(input))));
  ipc.handle(QUERY_CHANNELS.summarizeLineage, parsedHandler(trusted, QUERY_TOOL_SCHEMAS.summarize_lineage, (input) => run(() => query.summarizeLineage(input))));
  ipc.handle(QUERY_CHANNELS.searchWiki, parsedHandler(trusted, QUERY_TOOL_SCHEMAS.search_wiki, (input) => run(() => query.searchWiki(input))));
}
