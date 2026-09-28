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

export interface SourceReadModel {
  id: string;
  sourceKey: string;
  title: string;
  kind: string | null;
  uri: string | null;
  citation: string | null;
}

export interface PersonParentHint {
  id: string;
  displayName: string;
  role: "father" | "mother";
}

export interface PersonCandidate {
  id: string;
  displayName: string;
  aliases: string[];
  gender: Gender;
  birth: PartialDate | null;
  parentHints: PersonParentHint[];
}

export interface PersonQueryReadModel extends PersonReadModel {
  aliases: string[];
  sources: SourceReadModel[];
}

export type RelativeKind = "parent" | "spouse" | "child";

export interface RelativeReadModel {
  relationId: string;
  kind: RelativeKind;
  person: PersonCandidate;
  parentRole: "father" | "mother" | null;
  marriageStatus: "active" | "divorced" | null;
}

export interface RelationshipSignatureDto {
  steps: string[];
  generationDelta: number;
  lineageSide: "paternal" | "maternal" | "self" | "affinity" | "unknown";
  bloodAffinity: "blood" | "currentAffinity" | "directFormerSpouse";
  viewpointGender: Gender;
  targetGender: Gender;
  relativeAgeOrder: "older" | "younger" | "same" | "unknown";
  pathPersonIds: string[];
  pathRelationIds: string[];
}

export interface RelationshipAlternativeDto {
  primaryTerm: string | null;
  reverseTerm: string | null;
  description: string;
  signature: RelationshipSignatureDto;
}

export interface RelationshipResultDto extends RelationshipAlternativeDto {
  ruleVersion: string;
  alternatives: RelationshipAlternativeDto[];
  uncertainty: string[];
}

export interface LineageMemberSummary {
  personId: string;
  displayName: string;
  role: "blood" | "married_in" | "associated";
  generation: {
    declared: number | null;
    computed: number | null;
    displayed: number | null;
    source: "declared" | "computed" | "none";
    conflict: boolean;
  };
}

export interface LineageSummary {
  lineageId: string;
  name: string;
  generation: number | null;
  memberCount: number;
  bloodMemberCount: number;
  generationCounts: Record<string, number>;
  members: LineageMemberSummary[];
}

export interface WikiSearchHit {
  wikiEntryId: string;
  title: string;
  excerpt: string;
  sourceIds: string[];
}

export interface QueryApi {
  searchPeople(input: { query: string; limit: number }): Promise<AppResult<PersonCandidate[]>>;
  getPerson(input: { personId: string }): Promise<AppResult<PersonQueryReadModel>>;
  listRelatives(input: { personId: string; kinds: RelativeKind[] }): Promise<AppResult<RelativeReadModel[]>>;
  calculateRelationship(input: { viewpointId: string; targetId: string }): Promise<AppResult<RelationshipResultDto>>;
  summarizeLineage(input: { lineageId: string; generation?: number }): Promise<AppResult<LineageSummary>>;
  searchWiki(input: { query: string; limit: number }): Promise<AppResult<WikiSearchHit[]>>;
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

export type ImportSheetDto = "People" | "ParentChild" | "Marriages";
export type ImportEntityTypeDto = "person" | "parentChild" | "marriage";
export type ImportActionKindDto = "create" | "update" | "unchanged" | "blocked";
export type ImportCellValueDto = string | number | boolean | null;

export interface ImportSourceRowDto {
  sheet: ImportSheetDto;
  row: number;
  raw: Record<string, ImportCellValueDto>;
}

export interface ImportIssueDto {
  id: string;
  severity: "error" | "warning";
  code: string;
  message: string;
  actionId?: string;
  evidence: Readonly<Record<string, unknown>>;
}

export interface ImportActionDto {
  id: string;
  entityType: ImportEntityTypeDto;
  kind: ImportActionKindDto;
  sourceRow: ImportSourceRowDto;
  entityId?: string;
  expectedRowVersion?: number;
  changes: Array<{ field: string; before: unknown; after: unknown }>;
  issueIds: string[];
  dependsOnActionIds: string[];
}

export interface ImportPlanDto {
  id: string;
  sourceKey: string;
  fileName: string;
  actions: ImportActionDto[];
  issues: ImportIssueDto[];
  summary: { creates: number; updates: number; unchanged: number; blocked: number };
}

export interface ImportCommitReportDto {
  planId: string;
  sourceKey: string;
  operationGroupId: string | null;
  rows: Array<{
    actionId: string;
    sheet: ImportSheetDto;
    row: number;
    disposition: "committed" | "unchanged" | "blocked" | "excluded";
    entityId: string | null;
    operationGroupId: string | null;
    issueCodes: string[];
  }>;
}

export interface ImportApi {
  selectFile(): Promise<AppResult<{ fileToken: string; fileName: string }>>;
  parse(input: {
    fileToken: string;
    sourceKey: string;
    csvEntityType?: ImportSheetDto;
    fieldMapping?: Record<string, string>;
  }): Promise<AppResult<ImportPlanDto>>;
  commit(input: { planId: string; selectedActionIds: string[] }): Promise<AppResult<ImportCommitReportDto>>;
  exportTemplate(): Promise<AppResult<{ saved: boolean }>>;
}

export interface MergeDecisionDto {
  primaryPersonId: string;
  secondaryPersonId: string;
  scalarChoices: Record<string, "primary" | "secondary">;
  expectedVersions: Record<string, number>;
}
export interface MergePreviewDto {
  primary: PersonReadModel; secondary: PersonReadModel;
  scalarConflicts: Array<{ field: string; primary: unknown; secondary: unknown }>;
  aliases: Array<Record<string, unknown>>; parents: Array<Record<string, unknown>>; children: Array<Record<string, unknown>>;
  spouses: Array<Record<string, unknown>>; lineages: Array<Record<string, unknown>>; media: Array<Record<string, unknown>>; sources: Array<Record<string, unknown>>;
  expectedVersions: Record<string, number>;
}
export interface DuplicateCandidateDto { person: PersonReadModel; score: number; reasons: Array<{ code: string; detail: string }>; }
export interface MergeHistoryDto { id: string; primaryPersonId: string; secondaryPersonId: string; status: "active" | "reversed"; createdAt: string; }
export interface CanUnmergeDto { allowed: boolean; blockingEntityIds: string[]; reasons: Array<{ entityId: string; entityType: string; expectedVersion: number; actualVersion: number | null }>; }
export interface MergeApi {
  findDuplicateCandidates(input: { personId: string }): Promise<AppResult<DuplicateCandidateDto[]>>;
  preview(input: { primaryPersonId: string; secondaryPersonId: string }): Promise<AppResult<MergePreviewDto>>;
  merge(input: MergeDecisionDto): Promise<AppResult<{ id: string; status: "active" }>>;
  history(): Promise<AppResult<MergeHistoryDto[]>>;
  canUnmerge(input: { mergeId: string }): Promise<AppResult<CanUnmergeDto>>;
  unmerge(input: { mergeId: string }): Promise<AppResult<{ id: string; status: "reversed" }>>;
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
  imports: ImportApi;
  merges: MergeApi;
  query: QueryApi;
}
