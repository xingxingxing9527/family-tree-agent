import type { PartialDate } from "./domain.js";
import type { ConversationAnswer, ConversationConfirmationReceipt, ConversationDraftPreview, ConversationMutationDraft } from "./chat.js";
import type { MutationApi } from "./mutations.js";
import type { RelativePathPlan, RelativePathPlanInput } from "./relative-templates.js";

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
  personCode: string;
  displayName: string;
  gender: Gender;
  birth: PartialDate | null;
  death: PartialDate | null;
  notes: string | null;
  rowVersion: number;
}

export interface ChildrenCountStatusDto {
  count: number;
  completeness: "partial" | "complete";
}

export interface PersonListItem extends PersonReadModel {
  aliases: string[];
}

export interface ParentChildMarriageSourceReadModel {
  spouseAName: string;
  spouseBName: string;
  status: "active" | "divorced";
  start: PartialDate | null;
  end: PartialDate | null;
}

export interface RelatedPersonReadModel {
  relationId: string;
  person: PersonListItem;
  role: "father" | "mother" | "child";
  rowVersion: number;
  originKind: "explicit" | "spouse_default";
  inferredFromMarriageId: string | null;
  /** Human-readable provenance for new clients; the id remains for older clients. */
  inferredFromMarriage?: ParentChildMarriageSourceReadModel | null;
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

export interface PersonSearchCandidate extends PersonCandidate {
  personCode: string;
}

export interface PersonQueryReadModel extends PersonReadModel {
  aliases: string[];
  sources: SourceReadModel[];
}

export type RelativeKind = "parent" | "spouse" | "child";

interface RelativeReadModelBase {
  relationId: string;
  person: PersonCandidate;
}

export type RelativeReadModel = RelativeReadModelBase & ({
  kind: "parent" | "child";
  parentRole: "father" | "mother" | null;
  marriageStatus: null;
  rowVersion: number;
  originKind: "explicit" | "spouse_default";
  inferredFromMarriageId: string | null;
} | {
  kind: "spouse";
  parentRole: null;
  marriageStatus: "active" | "divorced" | null;
});

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

export interface KinshipDisplayLabelDto {
  formalTerm: string | null;
  regionalTerm: string | null;
  displayTerm: string | null;
  pathDescription: string | null;
  formalRuleId: string | null;
  locale: string;
  regionalRuleVersion: string;
}

export interface RelationshipAlternativeDto extends KinshipDisplayLabelDto {
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
  isPrimary: boolean;
  generationMarker: string | null;
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

export interface MediaAssetReadModel {
  id: string;
  fileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "audio/mpeg" | "audio/wav" | "audio/mp4" | "audio/ogg";
  byteSize: number;
  sha256: string;
  url: string;
  caption?: string | null;
}

export interface WikiEntryReadModel {
  id: string;
  slug: string;
  title: string;
  body: string;
  personIds: string[];
  sourceIds: string[];
  rowVersion: number;
}

export interface WorkspaceLineageReadModel {
  id: string;
  name: string;
  founderPersonId: string;
  description: string | null;
  memberCount: number;
  rowVersion: number;
  memberships: WorkspaceLineageMembershipReadModel[];
}

export interface WorkspaceLineageMembershipReadModel {
  id: string;
  lineageId: string;
  personId: string;
  role: "blood" | "married_in" | "associated";
  isPrimary: boolean;
  declaredGeneration: number | null;
  generationMarker: string | null;
  generation: TreeGenerationDisplayDto;
  rowVersion: number;
}

export interface WorkspaceSnapshotDto {
  workspaceId: string;
  people: PersonListItem[];
  sources: SourceReadModel[];
  lineages: WorkspaceLineageReadModel[];
}

export interface TreeGenerationDisplayDto {
  declared: number | null;
  computed: number | null;
  displayed: number | null;
  source: "declared" | "computed" | "none";
  conflict: boolean;
}

export interface TreePersonNodeDto {
  id: string;
  kind: "person";
  personId: string;
  display: {
    displayName: string;
    gender?: Gender;
    birthYear: number | null;
    deathYear: number | null;
    generation: TreeGenerationDisplayDto | null;
    generationMarker: string | null;
    lineageRole: "blood" | "married_in" | "associated" | null;
  };
}

export interface TreeUnionNodeDto {
  id: string;
  kind: "union";
  unionId: string;
  parentIds: string[];
  childIds: string[];
  marriageId: string | null;
  display: {
    kind: "marriage" | "coParents" | "singleParent" | "unassigned";
    marriageStatus: "active" | "divorced" | null;
    marriageStart: PartialDate | null;
    marriageEnd: PartialDate | null;
    warnings: string[];
  };
}

export type TreeProjectionNodeDto = TreePersonNodeDto | TreeUnionNodeDto;
export interface TreeProjectionEdgeDto {
  id: string;
  source: string;
  target: string;
  kind: "parentUnion" | "unionChild";
  unionId: string;
  parentIds: string[];
  childId: string | null;
  marriageId: string | null;
  marriageStatus: "active" | "divorced" | null;
}
export interface TreeProjectionTopologyDto { key: string; nodes: TreeProjectionNodeDto[]; edges: TreeProjectionEdgeDto[]; }
export interface TreeProjectionDto {
  topology: TreeProjectionTopologyDto;
  viewpointId: string | null;
  labels: Readonly<Record<string, KinshipDisplayLabelDto | null>>;
  scope: {
    view: TreeViewDto;
    subjectId: string | null;
    lineageId: string | null;
    visiblePersonCount: number;
  };
}
export type TreeViewDto = "full" | "lineage" | "core" | "descendants";

export interface MediaApi {
  select(): Promise<AppResult<{ fileToken: string; fileName: string }>>;
  import(input: { fileToken: string }): Promise<AppResult<MediaAssetReadModel>>;
  attach(input: { mediaAssetId: string; personId: string; caption?: string }): Promise<AppResult<null>>;
  listForPerson(input: { personId: string }): Promise<AppResult<MediaAssetReadModel[]>>;
}

export interface WikiApi {
  list(input: { limit: number; offset: number }): Promise<AppResult<WikiEntryReadModel[]>>;
  create(input: { title: string; body: string; personIds: string[]; sourceIds: string[] }): Promise<AppResult<WikiEntryReadModel>>;
  update(input: { wikiEntryId: string; title: string; body: string; personIds: string[]; sourceIds: string[]; expectedVersion: number }): Promise<AppResult<WikiEntryReadModel>>;
  remove(input: { wikiEntryId: string; expectedVersion: number }): Promise<AppResult<null>>;
  get(input: { wikiEntryId: string }): Promise<AppResult<WikiEntryReadModel>>;
}

export interface QueryApi {
  workspaceSnapshot(): Promise<AppResult<WorkspaceSnapshotDto>>;
  projectTree(input: { view: TreeViewDto; subjectId?: string; viewpointId?: string; collapseDepth?: number; lineageId?: string }): Promise<AppResult<TreeProjectionDto>>;
  searchPeople(input: { query: string; limit: number }): Promise<AppResult<PersonSearchCandidate[]>>;
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

export type ParentCompletionStatusDto = "suggested" | "no_candidate" | "ambiguous" | "unchanged" | "conflict";
export type ParentCompletionBasisDto = "unique_spouse" | "birth_interval" | "administrator_selected" | null;
export type ParentCompletionScanClassification = "safe" | "ambiguous" | "no-candidate" | "conflict";

export interface ParentCompletionRelationDto {
  parentId: string;
  parentName: string;
  childId: string;
  childName: string;
  parentRole: "father" | "mother";
  inferredFromMarriageId?: string | null;
}

export interface ParentCompletionMarriageEpisodeDto {
  id: string;
  status: "active" | "divorced";
  start: PartialDate | null;
  end: PartialDate | null;
  rowVersion: number;
}

export interface ParentCompletionCandidateDto {
  personId: string;
  personName: string;
  intervalRelation: "inside" | "outside" | "unknown";
  marriageEpisodes: ParentCompletionMarriageEpisodeDto[];
  reason: string;
  evidenceIds: string[];
}

export interface ParentCompletionIssueDto {
  code: "PARENT_COMPLETION_NO_CANDIDATE" | "PARENT_COMPLETION_AMBIGUOUS" | "PARENT_COMPLETION_INVALID_SELECTION" | "PARENT_ROLE_OCCUPIED" | "PARENT_GENDER_MISMATCH";
  severity: "info" | "warning" | "error";
  message: string;
  evidenceIds: string[];
}

export type ParentCompletionEvidenceDto =
  | { entityType: "person"; id: string; rowVersion: number; displayName: string; birth: PartialDate | null }
  | { entityType: "parent_child"; id: string; rowVersion: number; parentId: string; childId: string; parentRole: "father" | "mother" }
  | { entityType: "marriage"; id: string; rowVersion: number; spouseAId: string; spouseBId: string; status: "active" | "divorced"; start: PartialDate | null; end: PartialDate | null };

export interface ParentCompletionPlanDto {
  status: ParentCompletionStatusDto;
  basis: ParentCompletionBasisDto;
  explicit: ParentCompletionRelationDto;
  suggested?: ParentCompletionRelationDto;
  candidates: ParentCompletionCandidateDto[];
  issues: ParentCompletionIssueDto[];
  evidence: ParentCompletionEvidenceDto[];
}

export interface ParentCompletionScanItemDto {
  childId: string;
  childName: string;
  knownParentId: string;
  knownParentName: string;
  parentRole: "father" | "mother";
  classification: ParentCompletionScanClassification;
  plan: ParentCompletionPlanDto;
}

export interface ParentCompletionScanDto {
  counts: { total: number; safe: number; ambiguous: number; noCandidate: number; conflict: number };
  items: ParentCompletionScanItemDto[];
}

export interface LineageApi {
  createLineage(input: { name: string; founderPersonId: string; description: string | null }): Promise<AppResult<FactMutationReceipt>>;
  updateLineage(input: { lineageId: string; expectedVersion: number; patch: { name?: string; founderPersonId?: string; description?: string | null } }): Promise<AppResult<FactMutationReceipt>>;
  archiveLineage(input: { lineageId: string; expectedVersion: number }): Promise<AppResult<FactMutationReceipt>>;
  addMembership(input: { lineageId: string; personId: string; lineageRole: "blood" | "married_in" | "associated"; isPrimary: boolean; declaredGeneration: number | null; generationMarker: string | null }): Promise<AppResult<FactMutationReceipt>>;
  updateMembership(input: { membershipId: string; expectedVersion: number; patch: { lineageRole?: "blood" | "married_in" | "associated"; isPrimary?: boolean; declaredGeneration?: number | null; generationMarker?: string | null } }): Promise<AppResult<FactMutationReceipt>>;
  removeMembership(input: { membershipId: string; expectedVersion: number }): Promise<AppResult<FactMutationReceipt>>;
}

export interface MarriageDraft {
  spouseAId: string;
  spouseBId: string;
  start: PartialDate | null;
  status?: "active" | "divorced";
  end?: PartialDate | null;
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
  exportTemplate(): Promise<AppResult<{ saved: boolean; download?: DownloadDescriptor }>>;
  exportCurrentWorkbook(): Promise<AppResult<{ saved: boolean; download?: DownloadDescriptor }>>;
  exportBlankWorkbook(): Promise<AppResult<{ saved: boolean; download?: DownloadDescriptor }>>;
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
  wikiLinks: Array<Record<string, unknown>>; importIdentities: Array<Record<string, unknown>>; workspaceOrigins: Array<Record<string, unknown>>;
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

export interface BackupCountsDto {
  people: number;
  parentChild: number;
  marriages: number;
  wikiEntries: number;
  auditRows: number;
  mediaAssets: number;
}

export interface BackupSummaryDto {
  formatVersion: 1;
  workspaceId: string;
  workspaceName: string;
  schemaVersion: number;
  createdAt: string;
  counts: BackupCountsDto;
}

export interface BackupInspectionDto {
  restoreToken: string;
  targetWorkspaceId: string;
  verified: true;
  expiresAt: string;
  manifest: BackupSummaryDto;
}

export interface AuditOperationGroupDto {
  id: string;
  kind: string;
  createdAt: string;
  status: "available" | "undone" | "blocked";
  affectedEntities: Array<{
    entityType: string;
    entityId: string;
    originKind?: "explicit" | "spouse_default";
    inferredFromMarriage?: ParentChildMarriageSourceReadModel | null;
  }>;
  undoable: boolean;
  reason: string | null;
  undoneAt: string | null;
}

export interface DataManagementApi {
  listAudit(): Promise<AppResult<AuditOperationGroupDto[]>>;
  undoOperationGroup(input: { operationGroupId: string }): Promise<AppResult<{ operationGroupId: string; undoneAt: string; restoredEntities: number }>>;
  createBackup(): Promise<AppResult<{ saved: boolean; verified?: true; createdAt?: string; schemaVersion?: number; counts?: BackupCountsDto; download?: DownloadDescriptor }>>;
  listRestoreTargets(): Promise<AppResult<WorkspaceSummary[]>>;
  selectRestoreFile(): Promise<AppResult<{ selected: boolean; fileToken?: string; fileName?: string }>>;
  inspectBackup(input: { fileToken: string; targetWorkspaceId: string }): Promise<AppResult<BackupInspectionDto>>;
  restoreBackup(input: { restoreToken: string; targetWorkspaceId: string; confirmReplace: true }): Promise<AppResult<{ restored: true; automaticSnapshotVerified: true; cleanupPending: boolean }>>;
  exportWorkspace(): Promise<AppResult<{ saved: boolean; files?: number; mediaAssets?: number }>>;
}

export interface FamilyAgentApi {
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
    setChildrenCompleteness(input: { personId: string; complete: boolean; sourceDescription: string; expectedVersion: number }): Promise<AppResult<FactMutationReceipt>>;
    getChildrenCountStatus(input: { personId: string }): Promise<AppResult<ChildrenCountStatusDto>>;
  };
  relations: {
    addParentChild(input: { draft: ParentChildDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
    addMarriage(input: { draft: MarriageDraft; confirmWarnings: boolean }): Promise<AppResult<FactMutationReceipt>>;
    divorce(input: { marriageId: string; endDate: PartialDate | null; expectedVersion: number }): Promise<AppResult<FactMutationReceipt>>;
    planRelativePath(input: RelativePathPlanInput): Promise<AppResult<RelativePathPlan>>;
    planParentCompletion(input: { knownParentId: string; childId: string; parentRole: "father" | "mother"; selectedSpouseId?: string }): Promise<AppResult<ParentCompletionPlanDto>>;
    scanParentCompletions(): Promise<AppResult<ParentCompletionScanDto>>;
  };
  lineages: LineageApi;
  imports: ImportApi;
  merges: MergeApi;
  media: MediaApi;
  wiki: WikiApi;
  query: QueryApi;
  mutations: MutationApi;
  chat: {
    authorize(input: { sessionId: string; operation: "extract"; payload: { text: string; candidatePeople: PersonCandidate[] } } | { sessionId: string; operation: "ask"; payload: { question: string; viewpointId: string; selectedPersonId: string | null } }): Promise<AppResult<{ authorizationToken: string; expiresAt: string }>>;
    stageMutation(input: { sessionId: string; authorizationToken: string; payload: { text: string; candidatePeople: PersonCandidate[] } }): Promise<AppResult<ConversationDraftPreview>>;
    ask(input: { sessionId: string; authorizationToken: string; payload: { question: string; viewpointId: string; selectedPersonId: string | null } }): Promise<AppResult<ConversationAnswer>>;
    confirm(input: { draftId: string; draftVersion: number; selectedChangeIds: string[]; expectedVersions: Record<string, number>; acknowledgedWarningCodes: string[] }): Promise<AppResult<ConversationConfirmationReceipt>>;
    revise(input: { draftId: string; replacement: ConversationMutationDraft }): Promise<AppResult<ConversationDraftPreview>>;
  };
  modelSettings: {
    status(): Promise<AppResult<{ configured: boolean }>>;
    saveKey(input: { key: string }): Promise<AppResult<null>>;
    clearKey(): Promise<AppResult<null>>;
  };
  dataManagement: DataManagementApi;
}

export type UploadKind = "import" | "media" | "backup";
export interface UploadedFileToken {
  fileToken: string;
  fileName: string;
  kind: UploadKind;
  expiresAt: string;
}
export interface DownloadDescriptor {
  downloadUrl: string;
  fileName: string;
  expiresAt: string;
}

export type DesktopApi = FamilyAgentApi;
