import { existsSync } from "node:fs";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AppResult, MergeApi, MergeDecisionDto } from "../../shared/contracts.js";
import { DuplicateCandidateService } from "../application/merge/duplicate-candidate-service.js";
import { MergePreviewService } from "../application/merge/merge-preview-service.js";
import { PersonMergeService } from "../application/merge/person-merge-service.js";
import { UnmergeService } from "../application/merge/unmerge-service.js";
import { applyMigrations } from "../database/migrations/index.js";
import { openDatabase, type WorkspaceDatabase } from "../database/open-database.js";
import { MergeRepository } from "../database/repositories/merge-repository.js";
import type { OpenWorkspaceContextProvider } from "../application/facts/facts-gateway.js";

export const MERGE_CHANNELS = { candidates: "merges:candidates", preview: "merges:preview", merge: "merges:merge", history: "merges:history", canUnmerge: "merges:can-unmerge", unmerge: "merges:unmerge" } as const;
type IpcMainLike = Pick<IpcMain, "handle">;
const id = z.string().trim().min(1).max(200);
const decision = z.object({ primaryPersonId: id, secondaryPersonId: id, scalarChoices: z.record(z.string().max(100), z.enum(["primary", "secondary"])), expectedVersions: z.record(z.string().max(200), z.number().int().min(1)) }).strict().refine((value) => value.primaryPersonId !== value.secondaryPersonId, { message: "people" });
const failure = <T>(code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "INTERNAL", message: string): AppResult<T> => ({ ok: false, error: { code, message } });

export class WorkspaceMergeGateway implements MergeApi {
  constructor(private readonly workspaces: OpenWorkspaceContextProvider) {}
  async findDuplicateCandidates(input: { personId: string }) { return this.withWorkspace((db, workspaceId) => new DuplicateCandidateService(db, workspaceId).findDuplicateCandidates(input.personId)); }
  async preview(input: { primaryPersonId: string; secondaryPersonId: string }) { return this.withWorkspace((db, workspaceId) => new MergePreviewService(db, workspaceId).previewMerge(input.primaryPersonId, input.secondaryPersonId)); }
  async merge(input: MergeDecisionDto) { return this.withWorkspace((db, workspaceId) => { const result = new PersonMergeService(db, workspaceId).mergePeople(input); return { id: result.id, status: result.status }; }); }
  async history() { return this.withWorkspace((db, workspaceId) => new MergeRepository(db, workspaceId).list().map((record) => ({ id: record.id, primaryPersonId: record.survivorPersonId, secondaryPersonId: record.mergedPersonId, status: record.status, createdAt: record.createdAt }))); }
  async canUnmerge(input: { mergeId: string }) { return this.withWorkspace((db, workspaceId) => new UnmergeService(db, workspaceId).canUnmerge(input.mergeId)); }
  async unmerge(input: { mergeId: string }) { return this.withWorkspace((db, workspaceId) => { const result = new UnmergeService(db, workspaceId).unmerge(input.mergeId); return { id: result.id, status: result.status }; }); }
  private withWorkspace<T>(operation: (database: WorkspaceDatabase, workspaceId: string) => T): Promise<AppResult<T>> {
    const context = this.workspaces.getOpenWorkspaceContext();
    if (!context) return Promise.resolve(failure("NOT_FOUND", "No workspace is open"));
    if (!existsSync(context.databasePath)) return Promise.resolve(failure("INTERNAL", "Unable to complete merge request"));
    let database: WorkspaceDatabase | null = null;
    try { database = openDatabase(context.databasePath); applyMigrations(database); return Promise.resolve({ ok: true, value: operation(database, context.workspaceId) }); }
    catch (error) { const message = error instanceof Error ? error.message : "Unable to complete merge request"; return Promise.resolve(failure(/not found/i.test(message) ? "NOT_FOUND" : /changed|cannot|second|cycle|own|marry/i.test(message) ? "CONFLICT" : "INTERNAL", message.slice(0, 500))); }
    finally { database?.close(); }
  }
}

export function registerMergeIpc(ipc: IpcMainLike, mainWindowId: () => number | undefined, gateway: MergeApi): void {
  const trusted = (event: IpcMainInvokeEvent) => event.sender.id === mainWindowId();
  const handle = <T>(channel: string, schema: z.ZodType, work: (input: T) => Promise<AppResult<unknown>>) => ipc.handle(channel, async (event, input) => {
    if (!trusted(event)) return failure("INTERNAL", "IPC sender was denied"); const parsed = schema.safeParse(input); if (!parsed.success) return failure("VALIDATION", "Invalid request"); return work(parsed.data as T);
  });
  handle<{ personId: string }>(MERGE_CHANNELS.candidates, z.object({ personId: id }).strict(), (input) => gateway.findDuplicateCandidates(input));
  handle<{ primaryPersonId: string; secondaryPersonId: string }>(MERGE_CHANNELS.preview, z.object({ primaryPersonId: id, secondaryPersonId: id }).strict(), (input) => gateway.preview(input));
  handle<MergeDecisionDto>(MERGE_CHANNELS.merge, decision, (input) => gateway.merge(input));
  ipc.handle(MERGE_CHANNELS.history, (event) => trusted(event) ? gateway.history() : failure("INTERNAL", "IPC sender was denied"));
  handle<{ mergeId: string }>(MERGE_CHANNELS.canUnmerge, z.object({ mergeId: id }).strict(), (input) => gateway.canUnmerge(input));
  handle<{ mergeId: string }>(MERGE_CHANNELS.unmerge, z.object({ mergeId: id }).strict(), (input) => gateway.unmerge(input));
}
