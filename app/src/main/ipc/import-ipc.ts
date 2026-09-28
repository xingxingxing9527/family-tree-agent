import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { dialog, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AppResult, ImportCommitReportDto, ImportPlanDto } from "../../shared/contracts.js";
import { ImportCommitter } from "../application/import/import-committer.js";
import { ImportPlanner, ImportPlanStore } from "../application/import/import-planner.js";
import { exportImportTemplate, parseImport } from "../application/import/workbook-parser.js";
import { applyMigrations } from "../database/migrations/index.js";
import { openDatabase } from "../database/open-database.js";
import type { OpenWorkspaceContextProvider } from "../application/facts/facts-gateway.js";
import type { WorkspaceMutationGate } from "../workspaces/workspace-mutation-gate.js";

export const IMPORT_CHANNELS = { selectFile: "imports:select-file", parse: "imports:parse", commit: "imports:commit", exportTemplate: "imports:export-template" } as const;
type ImportSheet = "People" | "ParentChild" | "Marriages";
type ParseInput = { fileToken: string; sourceKey: string; csvEntityType?: ImportSheet; fieldMapping?: Record<string, string> };
export interface ImportDialogs {
  showOpenDialog(options: { title: string; properties: string[]; filters: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(options: { title: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePath?: string }>;
}
export interface ImportGateway {
  selectImportFile(): Promise<AppResult<{ fileToken: string; fileName: string }>>;
  parseImport(input: ParseInput): Promise<AppResult<ImportPlanDto>>;
  commitImport(input: { planId: string; selectedActionIds: string[] }): Promise<AppResult<ImportCommitReportDto>>;
  exportTemplate(): Promise<AppResult<{ saved: boolean }>>;
}
const failure = <T>(code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "PATH_DENIED" | "INTERNAL", message: string): AppResult<T> => ({ ok: false, error: { code, message } });
const extensionAllowed = (path: string): boolean => [".xlsx", ".csv"].includes(extname(path).toLowerCase());
const nativeDialogs: ImportDialogs = {
  showOpenDialog: (options) => dialog.showOpenDialog(options as Parameters<typeof dialog.showOpenDialog>[0]),
  showSaveDialog: (options) => dialog.showSaveDialog(options as Parameters<typeof dialog.showSaveDialog>[0])
};

class ImportCapabilityStore {
  private readonly entries = new Map<string, { path: string; workspaceId: string; expiresAt: number }>();
  issue(path: string, workspaceId: string): string { const token = randomUUID(); this.entries.set(token, { path, workspaceId, expiresAt: Date.now() + 5 * 60_000 }); return token; }
  consume(token: string, workspaceId: string): string | null { const entry = this.entries.get(token); this.entries.delete(token); return entry && entry.workspaceId === workspaceId && entry.expiresAt >= Date.now() ? entry.path : null; }
}

export class WorkspaceImportGateway implements ImportGateway {
  private readonly plans = new ImportPlanStore();
  private readonly capabilities: ImportCapabilityStore;
  constructor(private readonly workspaces: OpenWorkspaceContextProvider, private readonly dialogs: ImportDialogs = nativeDialogs, capabilities?: ImportCapabilityStore) { this.capabilities = capabilities ?? new ImportCapabilityStore(); }

  async selectImportFile(): Promise<AppResult<{ fileToken: string; fileName: string }>> {
    const context = this.workspaces.getOpenWorkspaceContext(); if (!context) return failure("NOT_FOUND", "No workspace is open");
    const selected = await this.dialogs.showOpenDialog({ title: "选择导入表格", properties: ["openFile"], filters: [{ name: "Spreadsheet", extensions: ["xlsx", "csv"] }] });
    if (selected.canceled || selected.filePaths.length !== 1) return failure("VALIDATION", "No import file was selected");
    try {
      const path = await realpath(selected.filePaths[0]!); const metadata = await stat(path);
      if (!metadata.isFile() || !extensionAllowed(path)) return failure("VALIDATION", "Selected file is not a supported spreadsheet");
      return { ok: true, value: { fileToken: this.capabilities.issue(path, context.workspaceId), fileName: basename(path) } };
    } catch { return failure("VALIDATION", "Selected file is unavailable"); }
  }
  async parseImport(input: ParseInput): Promise<AppResult<ImportPlanDto>> {
    const context = this.workspaces.getOpenWorkspaceContext(); if (!context) return failure("NOT_FOUND", "No workspace is open"); if (!existsSync(context.databasePath)) return failure("INTERNAL", "Unable to complete import request");
    const path = this.capabilities.consume(input.fileToken, context.workspaceId); if (!path) return failure("PATH_DENIED", "Import file selection expired; select it again");
    try {
      const parsed = await parseImport(path, input.sourceKey, { csvEntityType: input.csvEntityType, fieldMapping: input.fieldMapping });
      const database = openDatabase(context.databasePath); try { applyMigrations(database); return { ok: true, value: new ImportPlanner(database, context.workspaceId, this.plans).plan(parsed) }; } finally { database.close(); }
    } catch { return failure("VALIDATION", "Import file is invalid"); }
  }
  async commitImport(input: { planId: string; selectedActionIds: string[] }): Promise<AppResult<ImportCommitReportDto>> {
    const context = this.workspaces.getOpenWorkspaceContext(); if (!context) return failure("NOT_FOUND", "No workspace is open"); if (!existsSync(context.databasePath)) return failure("INTERNAL", "Unable to complete import request"); const database = openDatabase(context.databasePath);
    try { applyMigrations(database); return { ok: true, value: new ImportCommitter(database, context.workspaceId, this.plans).commitImport(input.planId, input.selectedActionIds) }; }
    catch (error) { const stale = /changed since preview/i.test(error instanceof Error ? error.message : ""); return failure(stale ? "CONFLICT" : "VALIDATION", stale ? "Import data changed since preview; create a new preview" : "Import selection could not be committed"); }
    finally { database.close(); }
  }
  async exportTemplate(): Promise<AppResult<{ saved: boolean }>> {
    const selected = await this.dialogs.showSaveDialog({ title: "保存导入模板", defaultPath: "family-import-template.xlsx", filters: [{ name: "Excel workbook", extensions: ["xlsx"] }] });
    if (selected.canceled || !selected.filePath) return { ok: true, value: { saved: false } };
    try { await exportImportTemplate(selected.filePath); return { ok: true, value: { saved: true } }; } catch { return failure("INTERNAL", "Unable to export import template"); }
  }
}

type IpcMainLike = Pick<IpcMain, "handle">;
const sourceKeySchema = z.string().max(500).refine((entry) => entry.trim().length > 0);
const mappingSchema = z.record(z.string().min(1).max(100), z.string().min(1).max(200)).refine((mapping) => Object.keys(mapping).length <= 30);
const parseSchema = z.object({ fileToken: z.string().uuid(), sourceKey: sourceKeySchema, csvEntityType: z.enum(["People", "ParentChild", "Marriages"]).optional(), fieldMapping: mappingSchema.optional() }).strict();
const commitSchema = z.object({ planId: z.string().min(1).max(200), selectedActionIds: z.array(z.string().min(1).max(200)).max(10_000) }).strict().refine((input) => new Set(input.selectedActionIds).size === input.selectedActionIds.length);
const emptySchema = z.object({}).strict(); const denied = (): AppResult<never> => failure("PATH_DENIED", "IPC sender was denied"); const invalid = (): AppResult<never> => failure("VALIDATION", "Invalid request"); const internal = (): AppResult<never> => failure("INTERNAL", "Unable to complete import request");
export function registerImportIpc(ipc: IpcMainLike, mainWindowId: () => number | undefined, imports: ImportGateway, mutations?: WorkspaceMutationGate): void {
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => mutations ? mutations.runMutation(operation) : operation();
  const register = <T>(channel: string, schema: z.ZodType<T>, operation: (input: T) => Promise<AppResult<unknown>>): void => ipc.handle(channel, async (event: IpcMainInvokeEvent, input: unknown) => { if (event.sender.id !== mainWindowId()) return denied(); const parsed = schema.safeParse(input); if (!parsed.success) return invalid(); try { return await operation(parsed.data); } catch { return internal(); } });
  register(IMPORT_CHANNELS.selectFile, emptySchema, () => imports.selectImportFile()); register(IMPORT_CHANNELS.parse, parseSchema, (input) => imports.parseImport(input)); register(IMPORT_CHANNELS.commit, commitSchema, (input) => mutate(() => imports.commitImport(input))); register(IMPORT_CHANNELS.exportTemplate, emptySchema, () => imports.exportTemplate());
}
