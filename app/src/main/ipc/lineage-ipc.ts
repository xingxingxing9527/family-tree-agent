import { existsSync } from "node:fs";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AppErrorCode, AppResult, FactMutationReceipt, LineageApi } from "../../shared/contracts.js";
import { LineageCommandError, LineageCommandService } from "../application/lineages/lineage-command-service.js";
import type { OpenWorkspaceContextProvider } from "../application/facts/facts-gateway.js";
import { applyMigrations } from "../database/migrations/index.js";
import { openDatabase } from "../database/open-database.js";
import type { WorkspaceMutationGate } from "../workspaces/workspace-mutation-gate.js";

export const LINEAGE_CHANNELS = {
  create: "lineages:create",
  update: "lineages:update",
  archive: "lineages:archive",
  addMembership: "lineages:add-membership",
  updateMembership: "lineages:update-membership",
  removeMembership: "lineages:remove-membership"
} as const;

export interface LineageGateway extends LineageApi {}

const failure = <T>(code: AppErrorCode, message: string, details?: unknown): AppResult<T> => ({
  ok: false,
  error: { code, message, ...(details === undefined ? {} : { details }) }
});

const receipt = (entityId: string): FactMutationReceipt => ({ entityId, saved: true, warnings: [] });

export class WorkspaceLineageGateway implements LineageGateway {
  constructor(private readonly workspaces: OpenWorkspaceContextProvider) {}

  createLineage(input: Parameters<LineageApi["createLineage"]>[0]): Promise<AppResult<FactMutationReceipt>> {
    return this.write((service) => receipt(service.createLineage(input).value.id));
  }

  updateLineage(input: Parameters<LineageApi["updateLineage"]>[0]): Promise<AppResult<FactMutationReceipt>> {
    return this.write((service) => receipt(service.updateLineage(input).value.id));
  }

  archiveLineage(input: Parameters<LineageApi["archiveLineage"]>[0]): Promise<AppResult<FactMutationReceipt>> {
    return this.write((service) => receipt(service.archiveLineage(input).value.id));
  }

  addMembership(input: Parameters<LineageApi["addMembership"]>[0]): Promise<AppResult<FactMutationReceipt>> {
    return this.write((service) => receipt(service.addMembership(input).value.id));
  }

  updateMembership(input: Parameters<LineageApi["updateMembership"]>[0]): Promise<AppResult<FactMutationReceipt>> {
    return this.write((service) => receipt(service.updateMembership(input).value.id));
  }

  removeMembership(input: Parameters<LineageApi["removeMembership"]>[0]): Promise<AppResult<FactMutationReceipt>> {
    return this.write((service) => receipt(service.removeMembership(input).value.id));
  }

  private async write(operation: (service: LineageCommandService) => FactMutationReceipt): Promise<AppResult<FactMutationReceipt>> {
    const context = this.workspaces.getOpenWorkspaceContext();
    if (!context) return failure("NOT_FOUND", "No workspace is open");
    if (!existsSync(context.databasePath)) return failure("INTERNAL", "Unable to complete lineage request");
    const database = openDatabase(context.databasePath);
    try {
      applyMigrations(database);
      return { ok: true, value: operation(new LineageCommandService(database, context.workspaceId)) };
    } catch (error) {
      if (error instanceof LineageCommandError) return failure(error.code, error.message, error.details);
      return failure("INTERNAL", "Unable to complete lineage request");
    } finally { database.close(); }
  }
}

type IpcMainLike = Pick<IpcMain, "handle">;
const id = z.string().trim().min(1).max(200);
const expectedVersion = z.number().int().min(1);
const optionalText = (maximum: number) => z.string().trim().min(1).max(maximum).nullable();
const role = z.enum(["blood", "married_in", "associated"]);
const declaredGeneration = z.number().int().min(1).max(10_000).nullable();
const generationMarker = optionalText(50);
const lineagePatch = z.object({ name: z.string().trim().min(1).max(200).optional(), founderPersonId: id.optional(), description: optionalText(10_000).optional() }).strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Patch cannot be empty" });
const membershipPatch = z.object({ lineageRole: role.optional(), isPrimary: z.boolean().optional(), declaredGeneration: declaredGeneration.optional(), generationMarker: generationMarker.optional() }).strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Patch cannot be empty" });
const schemas = {
  create: z.object({ name: z.string().trim().min(1).max(200), founderPersonId: id, description: optionalText(10_000) }).strict(),
  update: z.object({ lineageId: id, expectedVersion, patch: lineagePatch }).strict(),
  archive: z.object({ lineageId: id, expectedVersion }).strict(),
  addMembership: z.object({ lineageId: id, personId: id, lineageRole: role, isPrimary: z.boolean(), declaredGeneration, generationMarker }).strict(),
  updateMembership: z.object({ membershipId: id, expectedVersion, patch: membershipPatch }).strict(),
  removeMembership: z.object({ membershipId: id, expectedVersion }).strict()
} as const;

const denied = (): AppResult<never> => failure("PATH_DENIED", "IPC sender was denied");
const invalid = (): AppResult<never> => failure("VALIDATION", "Invalid request");
const internal = (): AppResult<never> => failure("INTERNAL", "Unable to complete lineage request");
const safeDetails = (details: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const source = details as Record<string, unknown>;
  const values = Object.fromEntries(Object.entries(source).filter(([key, value]) => ["field", "entityId", "entityType", "expectedVersion", "actualVersion"].includes(key) && ["string", "number", "boolean"].includes(typeof value)));
  return Object.keys(values).length > 0 ? values : undefined;
};
const sanitize = <T>(result: AppResult<T>): AppResult<T> => {
  if (result.ok) return result;
  if (result.error.code === "INTERNAL") return internal();
  const details = safeDetails(result.error.details);
  return failure(result.error.code, String(result.error.message).slice(0, 500), details);
};

export function registerLineageIpc(ipc: IpcMainLike, mainWindowId: () => number | undefined, lineages: LineageGateway, mutations?: WorkspaceMutationGate): void {
  const run = <T>(operation: () => Promise<T>): Promise<T> => mutations ? mutations.runOperation(operation) : operation();
  const register = <T>(channel: string, schema: z.ZodType<T>, operation: (input: T) => Promise<AppResult<FactMutationReceipt>>): void => {
    ipc.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
      if (event.sender.id !== mainWindowId()) return denied();
      const parsed = schema.safeParse(payload);
      if (!parsed.success) return invalid();
      try { return sanitize(await run(() => operation(parsed.data))); }
      catch { return internal(); }
    });
  };
  register(LINEAGE_CHANNELS.create, schemas.create, (input) => lineages.createLineage(input));
  register(LINEAGE_CHANNELS.update, schemas.update, (input) => lineages.updateLineage(input));
  register(LINEAGE_CHANNELS.archive, schemas.archive, (input) => lineages.archiveLineage(input));
  register(LINEAGE_CHANNELS.addMembership, schemas.addMembership, (input) => lineages.addMembership(input));
  register(LINEAGE_CHANNELS.updateMembership, schemas.updateMembership, (input) => lineages.updateMembership(input));
  register(LINEAGE_CHANNELS.removeMembership, schemas.removeMembership, (input) => lineages.removeMembership(input));
}
