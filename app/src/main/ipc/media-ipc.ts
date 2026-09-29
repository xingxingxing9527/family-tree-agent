import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { dialog, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AppResult, MediaAssetReadModel } from "../../shared/contracts.js";
import { openDatabase } from "../database/open-database.js";
import { applyMigrations } from "../database/migrations/index.js";
import { closeSelectedMediaFile, ManagedMediaService, openSelectedMediaFile, type SelectedMediaFile } from "../media/media-service.js";
import type { OpenWorkspaceContextProvider } from "../application/facts/facts-gateway.js";
import type { WorkspaceMutationGate } from "../workspaces/workspace-mutation-gate.js";

export const MEDIA_CHANNELS = { select: "media:select", import: "media:import", attach: "media:attach", listForPerson: "media:list-for-person" } as const;
export interface MediaDialogs { showOpenDialog(options: { title: string; properties: string[]; filters: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePaths: string[] }>; }
export interface MediaGateway { select(): Promise<AppResult<{ fileToken: string; fileName: string }>>; import(input: { fileToken: string }): Promise<AppResult<MediaAssetReadModel>>; attach(input: { mediaAssetId: string; personId: string; caption?: string }): Promise<AppResult<null>>; listForPerson(input: { personId: string }): Promise<AppResult<MediaAssetReadModel[]>>; }
export interface MediaSelectionIo {
  open(path: string, workspaceId: string, ttlMs: number): Promise<SelectedMediaFile>;
  close(selection: SelectedMediaFile): Promise<void>;
}
const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".mp3", ".wav", ".m4a", ".mp4", ".ogg"]);
const fail = <T>(code: "VALIDATION" | "NOT_FOUND" | "PATH_DENIED" | "INTERNAL" | "CONFLICT", message: string): AppResult<T> => ({ ok: false, error: { code, message } });
const nativeDialogs: MediaDialogs = { showOpenDialog: (options) => dialog.showOpenDialog(options as Parameters<typeof dialog.showOpenDialog>[0]) };

export class WorkspaceMediaGateway implements MediaGateway {
  private readonly tokens = new Map<string, { selection: SelectedMediaFile; timer: ReturnType<typeof setTimeout> }>();
  private readonly pendingCloses = new Set<Promise<void>>();
  private activeWorkspaceId: string | null = null;
  private generation = 0;
  constructor(
    private readonly workspaces: OpenWorkspaceContextProvider,
    private readonly dialogs: MediaDialogs = nativeDialogs,
    private readonly selectionTtlMs = 300_000,
    private readonly selectionIo: MediaSelectionIo = { open: openSelectedMediaFile, close: closeSelectedMediaFile }
  ) {}
  pendingSelectionCount(): number { return this.tokens.size; }
  async select(): Promise<AppResult<{ fileToken: string; fileName: string }>> {
    const context = await this.context(); if (!context) return fail("NOT_FOUND", "No workspace is open");
    const generation = this.generation;
    const selected = await this.dialogs.showOpenDialog({ title: "选择媒体文件", properties: ["openFile"], filters: [{ name: "Media", extensions: [...allowedExtensions].map((item) => item.slice(1)) }] });
    if (selected.canceled || selected.filePaths.length !== 1) return fail("VALIDATION", "No media file was selected");
    try { if (!allowedExtensions.has(extname(selected.filePaths[0]!).toLowerCase())) return fail("VALIDATION", "Selected media type is not supported"); const capability = await this.selectionIo.open(selected.filePaths[0]!, context.workspaceId, this.selectionTtlMs); const current = this.workspaces.getOpenWorkspaceContext(); if (generation !== this.generation || current?.workspaceId !== context.workspaceId) { await this.selectionIo.close(capability); return fail("PATH_DENIED", "Workspace changed while selecting media"); } const fileToken = randomUUID(); const timer = setTimeout(() => { void this.release(fileToken).catch(() => undefined); }, Math.max(0, capability.expiresAt - Date.now())); timer.unref(); this.tokens.set(fileToken, { selection: capability, timer }); return { ok: true, value: { fileToken, fileName: basename(capability.fileName) } }; }
    catch { return fail("VALIDATION", "Selected media file is unavailable"); }
  }
  async import(input: { fileToken: string }): Promise<AppResult<MediaAssetReadModel>> { return this.withService(async (service, context) => { const token = this.tokens.get(input.fileToken); if (token) { this.tokens.delete(input.fileToken); clearTimeout(token.timer); } const selection = token?.selection; if (!selection || selection.workspaceId !== context.workspaceId || selection.expiresAt < Date.now()) { if (selection) await closeSelectedMediaFile(selection); return fail("PATH_DENIED", "Media file selection expired; select it again"); } return service.importMedia({ selection }); }); }
  async attach(input: { mediaAssetId: string; personId: string; caption?: string }): Promise<AppResult<null>> { return this.withService((service) => service.attachMedia(input)); }
  async listForPerson(input: { personId: string }): Promise<AppResult<MediaAssetReadModel[]>> { return this.withService((service) => ({ ok: true, value: service.listForPerson(input.personId) })); }
  async dispose(): Promise<void> {
    this.generation += 1;
    this.activeWorkspaceId = null;
    const retained = [...this.pendingCloses, ...[...this.tokens.keys()].map((token) => this.release(token))];
    const results = await Promise.allSettled([...new Set(retained)]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), "Unable to close every selected media file");
  }
  private async context() { const context = this.workspaces.getOpenWorkspaceContext(); if (!context || (this.activeWorkspaceId && this.activeWorkspaceId !== context.workspaceId)) await this.dispose(); this.activeWorkspaceId = context?.workspaceId ?? null; return context; }
  private async release(token: string): Promise<void> { const value = this.tokens.get(token); if (!value) return; this.tokens.delete(token); clearTimeout(value.timer); const closing = this.selectionIo.close(value.selection); this.pendingCloses.add(closing); try { await closing; } finally { this.pendingCloses.delete(closing); } }
  private async withService<T>(work: (service: ManagedMediaService, context: { workspaceId: string; databasePath: string; mediaPath?: string }) => Promise<AppResult<T>> | AppResult<T>): Promise<AppResult<T>> { const context = await this.context(); if (!context) return fail("NOT_FOUND", "No workspace is open"); let database; try { database = openDatabase(context.databasePath); applyMigrations(database); return await work(new ManagedMediaService(database, context.workspaceId, context.mediaPath ?? join(context.databasePath, "..", "media")), context); } catch { return fail("INTERNAL", "Unable to complete media request"); } finally { database?.close(); } }
}

type Ipc = Pick<IpcMain, "handle">;
const inputId = z.string().uuid(); const empty = z.object({}).strict(); const importSchema = z.object({ fileToken: inputId }).strict(); const attachSchema = z.object({ mediaAssetId: inputId, personId: inputId, caption: z.string().max(500).optional() }).strict(); const listSchema = z.object({ personId: inputId }).strict();
export function registerMediaIpc(ipc: Ipc, mainWindowId: () => number | undefined, gateway: MediaGateway, mutations?: WorkspaceMutationGate): void { const run = <T>(operation: () => Promise<T>): Promise<T> => mutations ? mutations.runOperation(operation) : operation(); const handle = <T>(channel: string, schema: z.ZodType<T>, work: (input: T) => Promise<AppResult<unknown>>) => ipc.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown) => { if (event.sender.id !== mainWindowId()) return fail("PATH_DENIED", "IPC sender was denied"); const parsed = schema.safeParse(raw); if (!parsed.success) return fail("VALIDATION", "Invalid request"); try { return await work(parsed.data); } catch { return fail("INTERNAL", "Unable to complete media request"); } }); handle(MEDIA_CHANNELS.select, empty, () => run(() => gateway.select())); handle(MEDIA_CHANNELS.import, importSchema, (input) => run(() => gateway.import(input))); handle(MEDIA_CHANNELS.attach, attachSchema, (input) => run(() => gateway.attach(input))); handle(MEDIA_CHANNELS.listForPerson, listSchema, (input) => run(() => gateway.listForPerson(input))); }
