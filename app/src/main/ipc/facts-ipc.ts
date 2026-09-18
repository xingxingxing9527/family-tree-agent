import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type {
  AppErrorCode,
  AppResult,
  FactMutationReceipt,
  MarriageDraft,
  ParentChildDraft,
  PersonDetailReadModel,
  PersonDraft,
  PersonListItem,
  PersonPatch
} from "../../shared/contracts.js";
import { parsePartialDate, type PartialDate } from "../../shared/domain.js";
import { validatePartialDate } from "../domain/validation/partial-date-validator.js";

export const FACT_CHANNELS = {
  peopleList: "people:list",
  peopleGet: "people:get",
  peopleSave: "people:save",
  peopleUpdate: "people:update",
  addParentChild: "relations:add-parent-child",
  addMarriage: "relations:add-marriage",
  divorce: "relations:divorce"
} as const;

export interface FactsGateway {
  listPeople(input: { query?: string; limit: number; offset: number }): Promise<AppResult<PersonListItem[]>>;
  getPerson(input: { personId: string }): Promise<AppResult<PersonDetailReadModel>>;
  savePerson(input: { draft: PersonDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
  updatePerson(input: { personId: string; patch: PersonPatch; expectedVersion: number; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
  addParentChild(input: { draft: ParentChildDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
  addMarriage(input: { draft: MarriageDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
  divorce(input: { marriageId: string; endDate: PartialDate | null; expectedVersion: number }): Promise<AppResult<FactMutationReceipt>>;
}

type IpcMainLike = Pick<IpcMain, "handle">;
type Schema = z.ZodType;

const idSchema = z.string().trim().min(1).max(200);
const sourceDescriptionSchema = z.string().trim().min(1).max(500);
const partialDateSchema = z.object({
  calendar: z.enum(["solar", "lunar"]),
  year: z.number().int().min(1),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31).nullable(),
  leapMonth: z.boolean(),
  precision: z.enum(["month", "day"])
}).strict().superRefine((value, context) => {
  try {
    const parsed = parsePartialDate(value);
    if (parsed.precision !== value.precision) {
      context.addIssue({ code: "custom", message: "Date precision does not match day", path: ["precision"] });
    }
    for (const issue of validatePartialDate(parsed).errors) {
      context.addIssue({ code: "custom", message: issue.message });
    }
  } catch {
    context.addIssue({ code: "custom", message: "Invalid partial date" });
  }
});

const nullableDateSchema = partialDateSchema.nullable();
const personDraftSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100),
  gender: z.enum(["male", "female", "unknown"]),
  birth: nullableDateSchema,
  death: nullableDateSchema,
  notes: z.string().max(10_000).nullable(),
  sourceDescription: sourceDescriptionSchema
}).strict();
const personPatchSchema = personDraftSchema.partial().refine((patch) => Object.keys(patch).length > 0, { message: "Patch cannot be empty" });

const schemas = {
  list: z.object({ query: z.string().trim().max(200).optional(), limit: z.number().int().min(1).max(100), offset: z.number().int().min(0) }).strict(),
  get: z.object({ personId: idSchema }).strict(),
  save: z.object({ draft: personDraftSchema, confirmWarnings: z.boolean() }).strict(),
  update: z.object({ personId: idSchema, patch: personPatchSchema, expectedVersion: z.number().int().min(1), confirmWarnings: z.boolean() }).strict(),
  parentChild: z.object({
    draft: z.object({ parentId: idSchema, childId: idSchema, parentRole: z.enum(["father", "mother"]), sourceDescription: sourceDescriptionSchema }).strict()
      .refine((draft) => draft.parentId !== draft.childId, { message: "People must be different" }),
    confirmWarnings: z.boolean()
  }).strict(),
  marriage: z.object({
    draft: z.object({ spouseAId: idSchema, spouseBId: idSchema, start: nullableDateSchema, sourceDescription: sourceDescriptionSchema }).strict()
      .refine((draft) => draft.spouseAId !== draft.spouseBId, { message: "People must be different" }),
    confirmWarnings: z.boolean()
  }).strict(),
  divorce: z.object({ marriageId: idSchema, endDate: nullableDateSchema, expectedVersion: z.number().int().min(1) }).strict()
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

export function registerFactsIpc(ipc: IpcMainLike, mainWindowId: () => number | undefined, facts: FactsGateway): void {
  const trusted = (event: IpcMainInvokeEvent) => event.sender.id === mainWindowId();
  ipc.handle(FACT_CHANNELS.peopleList, parsedHandler(trusted, schemas.list, (input) => facts.listPeople(input)));
  ipc.handle(FACT_CHANNELS.peopleGet, parsedHandler(trusted, schemas.get, (input) => facts.getPerson(input)));
  ipc.handle(FACT_CHANNELS.peopleSave, parsedHandler(trusted, schemas.save, (input) => facts.savePerson(input)));
  ipc.handle(FACT_CHANNELS.peopleUpdate, parsedHandler(trusted, schemas.update, (input) => facts.updatePerson(input)));
  ipc.handle(FACT_CHANNELS.addParentChild, parsedHandler(trusted, schemas.parentChild, (input) => facts.addParentChild(input)));
  ipc.handle(FACT_CHANNELS.addMarriage, parsedHandler(trusted, schemas.marriage, (input) => facts.addMarriage(input)));
  ipc.handle(FACT_CHANNELS.divorce, parsedHandler(trusted, schemas.divorce, (input) => facts.divorce(input)));
}
