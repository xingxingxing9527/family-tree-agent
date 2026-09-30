import type { PartialDate } from "../../../shared/domain.js";
import type { Gender } from "../../database/repositories/person-repository.js";
import type { MarriageStatus, ParentRole } from "../../database/repositories/relation-repository.js";

export type ImportSheet = "People" | "ParentChild" | "Marriages";
export type ImportEntityType = "person" | "parentChild" | "marriage";
export type ImportActionKind = "create" | "update" | "unchanged" | "blocked";
export type ImportIssueSeverity = "error" | "warning";
export type ImportCellValue = string | number | boolean | null;

export interface ParsedImportRow {
  sheet: ImportSheet;
  row: number;
  raw: Record<string, ImportCellValue>;
}

export interface ParsedImport {
  sourceKey: string;
  fileName: string;
  rows: ParsedImportRow[];
}

export interface ImportIssue {
  id: string;
  severity: ImportIssueSeverity;
  code: string;
  message: string;
  actionId?: string;
  evidence: Readonly<Record<string, unknown>>;
}

export interface ImportFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ImportPersonPayload {
  type: "person";
  externalId: string;
  displayName: string;
  gender: Gender;
  birth: PartialDate | null;
  notes: string | null;
  newEntityId: string;
}

export interface ImportParentChildPayload {
  type: "parentChild";
  parentExternalId: string;
  childExternalId: string;
  parentRole: ParentRole;
}

export interface ImportMarriagePayload {
  type: "marriage";
  spouseAExternalId: string;
  spouseBExternalId: string;
  status: MarriageStatus;
  start: PartialDate | null;
  end: PartialDate | null;
}

export type ImportActionPayload = ImportPersonPayload | ImportParentChildPayload | ImportMarriagePayload;

export interface ImportAction {
  id: string;
  entityType: ImportEntityType;
  kind: ImportActionKind;
  sourceRow: ParsedImportRow;
  payload: ImportActionPayload;
  entityId?: string;
  expectedRowVersion?: number;
  changes: ImportFieldChange[];
  issueIds: string[];
  dependsOnActionIds: string[];
}

export interface ImportPlan {
  id: string;
  workspaceId: string;
  openContextId: string;
  sourceKey: string;
  fileName: string;
  actions: ImportAction[];
  issues: ImportIssue[];
  summary: { creates: number; updates: number; unchanged: number; blocked: number };
}

export interface ImportCommitRowReport {
  actionId: string;
  sheet: ImportSheet;
  row: number;
  disposition: "committed" | "unchanged" | "blocked" | "excluded";
  entityId: string | null;
  operationGroupId: string | null;
  issueCodes: string[];
}

export interface ImportCommitReport {
  planId: string;
  sourceKey: string;
  operationGroupId: string | null;
  rows: ImportCommitRowReport[];
}

export interface ParseImportOptions {
  csvEntityType?: ImportSheet;
  fieldMapping?: Record<string, string>;
}
