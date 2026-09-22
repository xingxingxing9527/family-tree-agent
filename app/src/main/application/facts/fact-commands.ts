import type { PartialDate } from "../../../shared/domain.js";
import type { Gender, UpdatePersonInput } from "../../database/repositories/person-repository.js";
import type { ParentRole } from "../../database/repositories/relation-repository.js";
import type { CreateSourceInput } from "../../database/repositories/source-repository.js";
import type { DomainIssue } from "../../domain/validation/partial-date-validator.js";

export interface PersonDraft {
  id?: string;
  workspaceId: string;
  displayName: string;
  gender: Gender;
  birth?: PartialDate | null;
  death?: PartialDate | null;
  notes?: string | null;
  aliases?: string[];
}

export type PersonPatch = UpdatePersonInput & { aliases?: string[] };

export interface ParentChildDraft {
  id?: string;
  workspaceId: string;
  parentId: string;
  childId: string;
  parentRole: ParentRole;
}

export interface MarriageDraft {
  id?: string;
  workspaceId: string;
  spouseAId: string;
  spouseBId: string;
  start?: PartialDate | null;
  status?: "active" | "divorced";
  end?: PartialDate | null;
}

export type SourceDraft = CreateSourceInput;

export type FactCommand =
  | { type: "person.create"; draft: PersonDraft; source: SourceDraft }
  | { type: "person.update"; personId: string; patch: PersonPatch; expectedVersion: number; source: SourceDraft }
  | { type: "parentChild.add"; draft: ParentChildDraft; source: SourceDraft }
  | { type: "marriage.add"; draft: MarriageDraft; source: SourceDraft }
  | { type: "marriage.divorce"; marriageId: string; endDate: PartialDate | null; expectedVersion: number; source: SourceDraft }
  | { type: "fact.softDelete"; entityType: string; entityId: string; expectedVersion: number };

export type DomainWarning = DomainIssue;

export interface MutationResult {
  operationGroupId: string;
  changedEntityIds: string[];
  warnings: DomainWarning[];
}

export interface ExecuteFactCommandOptions {
  confirmWarnings?: boolean;
  recordSource?: boolean;
}
