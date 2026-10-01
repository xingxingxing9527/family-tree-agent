import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { ZodType } from "zod";
import { RPC_INPUT_SCHEMAS } from "../../shared/api-schemas.js";
import type {
  AppErrorCode,
  AppResult,
  ChildrenCountStatusDto,
  FactMutationReceipt,
  MarriageDraft,
  ParentCompletionPlanDto,
  ParentCompletionScanDto,
  ParentChildDraft,
  PersonDetailReadModel,
  PersonDraft,
  PersonListItem,
  PersonPatch
} from "../../shared/contracts.js";
import type { PartialDate } from "../../shared/domain.js";
import type { WorkspaceMutationGate } from "../workspaces/workspace-mutation-gate.js";

export const FACT_CHANNELS = {
  peopleList: "people:list",
  peopleGet: "people:get",
  peopleSave: "people:save",
  peopleUpdate: "people:update",
  childrenCompletenessSet: "people:children-completeness-set",
  childrenCountStatus: "people:children-count-status",
  addParentChild: "relations:add-parent-child",
  addMarriage: "relations:add-marriage",
  divorce: "relations:divorce",
  planParentCompletion: "relations:plan-parent-completion",
  scanParentCompletions: "relations:scan-parent-completions"
} as const;

export interface FactsGateway {
  listPeople(input: { query?: string; limit: number; offset: number }): Promise<AppResult<PersonListItem[]>>;
  getPerson(input: { personId: string }): Promise<AppResult<PersonDetailReadModel>>;
  savePerson(input: { draft: PersonDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
  updatePerson(input: { personId: string; patch: PersonPatch; expectedVersion: number; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
  setChildrenCompleteness(input: { personId: string; complete: boolean; sourceDescription: string; expectedVersion: number }): Promise<AppResult<FactMutationReceipt>>;
  getChildrenCountStatus(input: { personId: string }): Promise<AppResult<ChildrenCountStatusDto>>;
  addParentChild(input: { draft: ParentChildDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
  addMarriage(input: { draft: MarriageDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
  divorce(input: { marriageId: string; endDate: PartialDate | null; expectedVersion: number }): Promise<AppResult<FactMutationReceipt>>;
  planParentCompletion(input: { knownParentId: string; childId: string; parentRole: "father" | "mother"; selectedSpouseId?: string }): Promise<AppResult<ParentCompletionPlanDto>>;
  scanParentCompletions(): Promise<AppResult<ParentCompletionScanDto>>;
}

type IpcMainLike = Pick<IpcMain, "handle">;
type Schema = ZodType;

const schemas = {
  list: RPC_INPUT_SCHEMAS.people.list,
  get: RPC_INPUT_SCHEMAS.people.get,
  save: RPC_INPUT_SCHEMAS.people.save,
  update: RPC_INPUT_SCHEMAS.people.update,
  setChildrenCompleteness: RPC_INPUT_SCHEMAS.people.setChildrenCompleteness,
  getChildrenCountStatus: RPC_INPUT_SCHEMAS.people.getChildrenCountStatus,
  parentChild: RPC_INPUT_SCHEMAS.relations.addParentChild,
  marriage: RPC_INPUT_SCHEMAS.relations.addMarriage,
  divorce: RPC_INPUT_SCHEMAS.relations.divorce,
  planParentCompletion: RPC_INPUT_SCHEMAS.relations.planParentCompletion,
  scanParentCompletions: RPC_INPUT_SCHEMAS.relations.scanParentCompletions
} as const;

const denied = (): AppResult<never> => ({ ok: false, error: { code: "PATH_DENIED", message: "IPC sender was denied" } });
const invalid = (field: string): AppResult<never> => ({ ok: false, error: { code: "VALIDATION", message: "Invalid request", details: { field } } });
const internal = (): AppResult<never> => ({ ok: false, error: { code: "INTERNAL", message: "Unable to complete facts request" } });

const allowedCodes = new Set<AppErrorCode>(["VALIDATION", "NOT_FOUND", "CONFLICT", "PATH_DENIED", "MODEL_UNAVAILABLE", "INTERNAL"]);

function sanitizeDetails(details: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const source = details as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of ["field", "entityId", "entityType", "expectedVersion", "actualVersion", "code"]) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function sanitizeResult<T>(result: AppResult<T>): AppResult<T> {
  if (result.ok) return result;
  const code = allowedCodes.has(result.error.code) ? result.error.code : "INTERNAL";
  if (code === "INTERNAL") return internal();
  const details = sanitizeDetails(result.error.details);
  return {
    ok: false,
    error: {
      code,
      message: String(result.error.message).slice(0, 500),
      ...(details ? { details } : {})
    }
  };
}

function parsedHandler(
  trusted: (event: IpcMainInvokeEvent) => boolean,
  schema: Schema,
  operation: (input: never) => Promise<AppResult<unknown>>
): (event: IpcMainInvokeEvent, input: unknown) => Promise<AppResult<unknown>> {
  return async (event, input) => {
    if (!trusted(event)) return denied();
    const parsed = schema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues[0]?.path.join(".") || "request");
    try {
      return sanitizeResult(await operation(parsed.data as never));
    } catch {
      return internal();
    }
  };
}

export function registerFactsIpc(ipc: IpcMainLike, mainWindowId: () => number | undefined, facts: FactsGateway, mutations?: WorkspaceMutationGate): void {
  const trusted = (event: IpcMainInvokeEvent) => event.sender.id === mainWindowId();
  const run = <T>(operation: () => Promise<T>): Promise<T> => mutations ? mutations.runOperation(operation) : operation();
  ipc.handle(FACT_CHANNELS.peopleList, parsedHandler(trusted, schemas.list, (input) => run(() => facts.listPeople(input))));
  ipc.handle(FACT_CHANNELS.peopleGet, parsedHandler(trusted, schemas.get, (input) => run(() => facts.getPerson(input))));
  ipc.handle(FACT_CHANNELS.peopleSave, parsedHandler(trusted, schemas.save, (input) => run(() => facts.savePerson(input))));
  ipc.handle(FACT_CHANNELS.peopleUpdate, parsedHandler(trusted, schemas.update, (input) => run(() => facts.updatePerson(input))));
  ipc.handle(FACT_CHANNELS.childrenCompletenessSet, parsedHandler(trusted, schemas.setChildrenCompleteness, (input) => run(() => facts.setChildrenCompleteness(input))));
  ipc.handle(FACT_CHANNELS.childrenCountStatus, parsedHandler(trusted, schemas.getChildrenCountStatus, (input) => run(() => facts.getChildrenCountStatus(input))));
  ipc.handle(FACT_CHANNELS.addParentChild, parsedHandler(trusted, schemas.parentChild, (input) => run(() => facts.addParentChild(input))));
  ipc.handle(FACT_CHANNELS.addMarriage, parsedHandler(trusted, schemas.marriage, (input) => run(() => facts.addMarriage(input))));
  ipc.handle(FACT_CHANNELS.divorce, parsedHandler(trusted, schemas.divorce, (input) => run(() => facts.divorce(input))));
  ipc.handle(FACT_CHANNELS.planParentCompletion, parsedHandler(trusted, schemas.planParentCompletion, (input) => run(() => facts.planParentCompletion(input))));
  ipc.handle(FACT_CHANNELS.scanParentCompletions, parsedHandler(trusted, schemas.scanParentCompletions, () => run(() => facts.scanParentCompletions())));
}
