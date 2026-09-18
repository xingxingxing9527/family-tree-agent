import type { PartialDate } from "./domain.js";

export type AppErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PATH_DENIED"
  | "MODEL_UNAVAILABLE"
  | "INTERNAL";

export type AppResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: AppErrorCode; message: string; details?: unknown } };

export interface WorkspaceSummary {
  id: string;
  name: string;
  directory: string;
  originPersonId: string | null;
  lastOpenedAt: string | null;
  schemaVersion: number;
}

export interface WorkspacePaths {
  root: string;
  manifest: string;
  database: string;
  media: string;
  backups: string;
}

export type Gender = "male" | "female" | "unknown";

export interface PersonDraft {
  displayName: string;
  aliases: string[];
  gender: Gender;
  birth: PartialDate | null;
  death: PartialDate | null;
  notes: string | null;
  sourceDescription: string;
}

export type PersonPatch = Partial<PersonDraft>;

export interface PersonReadModel {
  id: string;
  displayName: string;
  gender: Gender;
  birth: PartialDate | null;
  death: PartialDate | null;
  notes: string | null;
  rowVersion: number;
}

export interface PersonListItem extends PersonReadModel {
  aliases: string[];
}

export interface RelatedPersonReadModel {
  relationId: string;
  person: PersonListItem;
  role: "father" | "mother" | "child";
}

export interface MarriageReadModel {
  id: string;
  spouse: PersonListItem;
  status: "active" | "divorced";
  start: PartialDate | null;
  end: PartialDate | null;
  rowVersion: number;
}

export interface PersonDetailReadModel {
  person: PersonReadModel;
  aliases: string[];
  parents: RelatedPersonReadModel[];
  children: RelatedPersonReadModel[];
  marriages: MarriageReadModel[];
}

export interface DomainWarningDto {
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface FactMutationReceipt {
  entityId: string | null;
  saved: boolean;
  warnings: DomainWarningDto[];
}

export interface ParentChildDraft {
  parentId: string;
  childId: string;
  parentRole: "father" | "mother";
  sourceDescription: string;
}

export interface MarriageDraft {
  spouseAId: string;
  spouseBId: string;
  start: PartialDate | null;
  sourceDescription: string;
}

export interface DesktopApi {
  app: { getVersion(): Promise<string> };
  workspaces: {
    list(): Promise<AppResult<WorkspaceSummary[]>>;
    create(input: { name: string }): Promise<AppResult<WorkspaceSummary>>;
    open(input: { id: string }): Promise<AppResult<WorkspaceSummary>>;
    close(): Promise<AppResult<null>>;
  };
  people: {
    list(input: { query?: string; limit: number; offset: number }): Promise<AppResult<PersonListItem[]>>;
    get(input: { personId: string }): Promise<AppResult<PersonDetailReadModel>>;
    save(input: { draft: PersonDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
    update(input: { personId: string; patch: PersonPatch; expectedVersion: number; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
  };
  relations: {
    addParentChild(input: { draft: ParentChildDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
    addMarriage(input: { draft: MarriageDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
    divorce(input: { marriageId: string; endDate: PartialDate | null; expectedVersion: number }): Promise<AppResult<FactMutationReceipt>>;
  };
}
