import { existsSync } from "node:fs";
import { z } from "zod";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { AppErrorCode, AppResult, WikiEntryReadModel } from "../../shared/contracts.js";
import { WikiService } from "../application/wiki/wiki-service.js";
import { openQueryDatabase } from "../database/open-query-database.js";
import { openDatabase, type WorkspaceDatabase } from "../database/open-database.js";
import type { OpenWorkspaceContextProvider } from "../application/facts/facts-gateway.js";
import type { WorkspaceMutationGate } from "../workspaces/workspace-mutation-gate.js";

export const WIKI_CHANNELS = {
  list: "wiki:list",
  create: "wiki:create",
  update: "wiki:update",
  remove: "wiki:remove",
  get: "wiki:get"
} as const;

export interface WikiGateway {
  list(input: { limit: number; offset: number }): Promise<AppResult<WikiEntryReadModel[]>>;
  create(input: { title: string; body: string; personIds: string[]; sourceIds: string[] }): Promise<AppResult<WikiEntryReadModel>>;
  update(input: { wikiEntryId: string; title: string; body: string; personIds: string[]; sourceIds: string[]; expectedVersion: number }): Promise<AppResult<WikiEntryReadModel>>;
  remove(input: { wikiEntryId: string; expectedVersion: number }): Promise<AppResult<null>>;
  get(input: { wikiEntryId: string }): Promise<AppResult<WikiEntryReadModel>>;
}

const fail = <T>(code: AppErrorCode, message: string): AppResult<T> => ({ ok: false, error: { code, message } });

export class WorkspaceWikiGateway implements WikiGateway {
  constructor(private readonly workspaces: OpenWorkspaceContextProvider) {}

  async list(input: { limit: number; offset: number }): Promise<AppResult<WikiEntryReadModel[]>> {
    return this.withDatabase(true, (database, workspaceId) => new WikiService(database, workspaceId).list(input));
  }

  async create(input: { title: string; body: string; personIds: string[]; sourceIds: string[] }): Promise<AppResult<WikiEntryReadModel>> {
    return this.withDatabase(false, (database, workspaceId) => new WikiService(database, workspaceId).create(input));
  }

  async update(input: { wikiEntryId: string; title: string; body: string; personIds: string[]; sourceIds: string[]; expectedVersion: number }): Promise<AppResult<WikiEntryReadModel>> {
    return this.withDatabase(false, (database, workspaceId) => new WikiService(database, workspaceId).update(input));
  }

  async remove(input: { wikiEntryId: string; expectedVersion: number }): Promise<AppResult<null>> {
    return this.withDatabase(false, (database, workspaceId) => {
      new WikiService(database, workspaceId).softDelete(input);
      return null;
    });
  }

  async get(input: { wikiEntryId: string }): Promise<AppResult<WikiEntryReadModel>> {
    return this.withDatabase(true, (database, workspaceId) => new WikiService(database, workspaceId).get(input.wikiEntryId));
  }

  private async withDatabase<T>(readOnly: boolean, operation: (database: WorkspaceDatabase, workspaceId: string) => T): Promise<AppResult<T>> {
    const context = this.workspaces.getOpenWorkspaceContext();
    if (!context) return fail("NOT_FOUND", "No workspace is open");
    if (!existsSync(context.databasePath)) return fail("INTERNAL", "Unable to complete wiki request");
    let database: WorkspaceDatabase | null = null;
    try {
      database = readOnly ? openQueryDatabase(context.databasePath) : openDatabase(context.databasePath);
      return { ok: true, value: operation(database, context.workspaceId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "Wiki entry not found") return fail("NOT_FOUND", "Wiki entry was not found");
      if (message === "Wiki entry changed since it was opened") return fail("CONFLICT", "Wiki entry changed since it was opened");
      if (message === "Wiki title is required" || /FOREIGN KEY constraint failed/i.test(message)) return fail("VALIDATION", "Wiki entry is invalid");
      return fail("INTERNAL", "Unable to complete wiki request");
    } finally {
      database?.close();
    }
  }
}

const id = z.string().uuid();
const listSchema = z.object({ limit: z.number().int().min(1).max(100), offset: z.number().int().min(0).max(100_000) }).strict();
const draftSchema = z.object({
  title: z.string().trim().min(1).max(500),
  body: z.string().max(200_000),
  personIds: z.array(id).max(500),
  sourceIds: z.array(id).max(500)
}).strict();
const updateSchema = draftSchema.extend({ wikiEntryId: id, expectedVersion: z.number().int().min(1) }).strict();
const removeSchema = z.object({ wikiEntryId: id, expectedVersion: z.number().int().min(1) }).strict();
const getSchema = z.object({ wikiEntryId: id }).strict();

const sanitizeResult = <T>(result: AppResult<T>): AppResult<T> => {
  if (result.ok) return result;
  if (result.error.code === "INTERNAL") return fail("INTERNAL", "Unable to complete wiki request");
  if (["VALIDATION", "NOT_FOUND", "CONFLICT", "PATH_DENIED"].includes(result.error.code)) {
    return fail(result.error.code, String(result.error.message).slice(0, 500));
  }
  return fail("INTERNAL", "Unable to complete wiki request");
};

export function registerWikiIpc(
  ipc: Pick<IpcMain, "handle">,
  mainWindowId: () => number | undefined,
  gateway: WikiGateway,
  operations?: WorkspaceMutationGate
): void {
  const run = <T>(operation: () => Promise<T>): Promise<T> => operations ? operations.runOperation(operation) : operation();
  const handle = <T>(channel: string, schema: z.ZodType<T>, operation: (input: T) => Promise<AppResult<unknown>>): void => {
    ipc.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown): Promise<AppResult<unknown>> => {
      if (event.sender.id !== mainWindowId()) return fail("PATH_DENIED", "IPC sender was denied");
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return fail("VALIDATION", "Invalid request");
      try { return sanitizeResult(await operation(parsed.data)); }
      catch { return fail("INTERNAL", "Unable to complete wiki request"); }
    });
  };
  handle(WIKI_CHANNELS.list, listSchema, (input) => run(() => gateway.list(input)));
  handle(WIKI_CHANNELS.create, draftSchema, (input) => run(() => gateway.create(input)));
  handle(WIKI_CHANNELS.update, updateSchema, (input) => run(() => gateway.update(input)));
  handle(WIKI_CHANNELS.remove, removeSchema, (input) => run(() => gateway.remove(input)));
  handle(WIKI_CHANNELS.get, getSchema, (input) => run(() => gateway.get(input)));
}
