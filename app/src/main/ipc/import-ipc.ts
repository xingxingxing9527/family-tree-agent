import { existsSync } from "node:fs";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AppResult, ImportCommitReportDto, ImportPlanDto } from "../../shared/contracts.js";
import { ImportCommitter } from "../application/import/import-committer.js";
import { ImportPlanner, ImportPlanStore } from "../application/import/import-planner.js";
import { exportImportTemplate, parseImport } from "../application/import/workbook-parser.js";
import { applyMigrations } from "../database/migrations/index.js";
import { openDatabase } from "../database/open-database.js";
import type { OpenWorkspaceContextProvider } from "../application/facts/facts-gateway.js";

export const IMPORT_CHANNELS = {
  parse: "imports:parse",
  commit: "imports:commit",
  exportTemplate: "imports:export-template"
} as const;

export interface ImportGateway {
  parseImport(input: { filePath: string; sourceKey: string; csvEntityType?: "People" | "ParentChild" | "Marriages"; fieldMapping?: Record<string, string> }): Promise<AppResult<ImportPlanDto>>;
  commitImport(input: { planId: string; selectedActionIds: string[] }): Promise<AppResult<ImportCommitReportDto>>;
  exportTemplate(input: { targetFile: string }): Promise<AppResult<{ filePath: string }>>;
}

const failure = <T>(code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "PATH_DENIED" | "INTERNAL", message: string, details?: unknown): AppResult<T> => ({
  ok: false,
  error: { code, message, ...(details === undefined ? {} : { details }) }
});

export class WorkspaceImportGateway implements ImportGateway {
  private readonly plans = new ImportPlanStore();

  constructor(private readonly workspaces: OpenWorkspaceContextProvider) {}

  async parseImport(input: { filePath: string; sourceKey: string; csvEntityType?: "People" | "ParentChild" | "Marriages"; fieldMapping?: Record<string, string> }): Promise<AppResult<ImportPlanDto>> {
    const context = this.workspaces.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    if (!existsSync(context.databasePath)) return failure("INTERNAL", "Unable to complete import request");
    try {
      const parsed = await parseImport(input.filePath, input.sourceKey, { csvEntityType: input.csvEntityType, fieldMapping: input.fieldMapping });
      const database = openDatabase(context.databasePath);
      try {
        applyMigrations(database);
        return { ok: true, value: new ImportPlanner(database, context.workspaceId, this.plans).plan(parsed) };
      } finally {
        database.close();
      }
    } catch {
      return failure("VALIDATION", "Import file is invalid");
    }
  }

  async commitImport(input: { planId: string; selectedActionIds: string[] }): Promise<AppResult<ImportCommitReportDto>> {
    const context = this.workspaces.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    if (!existsSync(context.databasePath)) return failure("INTERNAL", "Unable to complete import request");
    const database = openDatabase(context.databasePath);
    try {
      applyMigrations(database);
      return { ok: true, value: new ImportCommitter(database, context.workspaceId, this.plans).commitImport(input.planId, input.selectedActionIds) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/changed since preview/i.test(message)) return failure("CONFLICT", "Import data changed since preview; create a new preview");
      return failure("VALIDATION", "Import selection could not be committed");
    } finally {
      database.close();
    }
  }

  async exportTemplate(input: { targetFile: string }): Promise<AppResult<{ filePath: string }>> {
    try {
      return { ok: true, value: { filePath: await exportImportTemplate(input.targetFile) } };
    } catch {
      return failure("INTERNAL", "Unable to export import template");
    }
  }
}

type IpcMainLike = Pick<IpcMain, "handle">;
const pathSchema = z.string().min(1).max(4096);
const sourceKeySchema = z.string().max(500).refine((entry) => entry.trim().length > 0);
const mappingSchema = z.record(z.string().min(1).max(100), z.string().min(1).max(200)).refine((mapping) => Object.keys(mapping).length <= 30);
const parseSchema = z.object({
  filePath: pathSchema.refine((entry) => /\.(xlsx|csv)$/i.test(entry)),
  sourceKey: sourceKeySchema,
  csvEntityType: z.enum(["People", "ParentChild", "Marriages"]).optional(),
  fieldMapping: mappingSchema.optional()
}).strict().superRefine((input, context) => {
  if (/\.csv$/i.test(input.filePath) && !input.csvEntityType) context.addIssue({ code: "custom", message: "CSV entity type is required", path: ["csvEntityType"] });
});
const commitSchema = z.object({
  planId: z.string().min(1).max(200),
  selectedActionIds: z.array(z.string().min(1).max(200)).max(10_000)
}).strict().refine((input) => new Set(input.selectedActionIds).size === input.selectedActionIds.length, { message: "Action IDs must be unique" });
const exportSchema = z.object({ targetFile: pathSchema.refine((entry) => /\.xlsx$/i.test(entry)) }).strict();
const denied = (): AppResult<never> => ({ ok: false, error: { code: "PATH_DENIED", message: "IPC sender was denied" } });
const invalid = (): AppResult<never> => ({ ok: false, error: { code: "VALIDATION", message: "Invalid request" } });
const internal = (): AppResult<never> => ({ ok: false, error: { code: "INTERNAL", message: "Unable to complete import request" } });

export function registerImportIpc(ipc: IpcMainLike, mainWindowId: () => number | undefined, imports: ImportGateway): void {
  const trusted = (event: IpcMainInvokeEvent): boolean => event.sender.id === mainWindowId();
  const register = <T>(channel: string, schema: z.ZodType<T>, operation: (input: T) => Promise<AppResult<unknown>>): void => {
    ipc.handle(channel, async (event, input: unknown) => {
      if (!trusted(event)) return denied();
      const parsed = schema.safeParse(input);
      if (!parsed.success) return invalid();
      try {
        return await operation(parsed.data);
      } catch {
        return internal();
      }
    });
  };
  register(IMPORT_CHANNELS.parse, parseSchema, (input) => imports.parseImport(input));
  register(IMPORT_CHANNELS.commit, commitSchema, (input) => imports.commitImport(input));
  register(IMPORT_CHANNELS.exportTemplate, exportSchema, (input) => imports.exportTemplate(input));
}
