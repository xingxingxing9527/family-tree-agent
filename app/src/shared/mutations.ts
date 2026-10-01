import type { AppResult, MarriageDraft, ParentChildDraft, PersonDraft, PersonPatch } from "./contracts.js";
import type { PartialDate } from "./domain.js";

type MembershipValues = {
  lineageRole: "blood" | "married_in" | "associated";
  isPrimary: boolean;
  declaredGeneration: number | null;
  generationMarker: string | null;
};

export type MutationIntent =
  | { type: "person.create"; draft: PersonDraft }
  | { type: "person.update"; personId: string; expectedVersion: number; patch: PersonPatch }
  | { type: "parentChild.add"; draft: ParentChildDraft }
  | { type: "marriage.add"; draft: MarriageDraft }
  | { type: "marriage.divorce"; marriageId: string; endDate: PartialDate | null; expectedVersion: number }
  | { type: "person.childrenCompleteness.set"; personId: string; complete: boolean; sourceDescription: string; expectedVersion: number }
  | { type: "lineage.create"; name: string; founderPersonId: string; description: string | null }
  | { type: "lineage.update"; lineageId: string; expectedVersion: number; patch: { name?: string; founderPersonId?: string; description?: string | null } }
  | { type: "lineage.archive"; lineageId: string; expectedVersion: number }
  | ({ type: "lineageMembership.add"; lineageId: string; personId: string } & MembershipValues)
  | { type: "lineageMembership.update"; membershipId: string; expectedVersion: number; patch: Partial<MembershipValues> }
  | { type: "lineageMembership.remove"; membershipId: string; expectedVersion: number };

export type MutationDisposition = "create" | "update" | "unchanged" | "blocked";

export interface MutationChange {
  id: string;
  disposition: MutationDisposition;
  entityType: string;
  entityId: string | null;
  summary: string;
  fieldChanges: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface MutationIssue {
  changeId: string;
  severity: "warning" | "error";
  code: string;
  message: string;
}

export interface MutationPreview {
  id: string;
  workspaceId: string;
  version: number;
  expiresAt: string;
  expectedVersions: Record<string, number>;
  changes: MutationChange[];
  issues: MutationIssue[];
  canConfirm: boolean;
}

export interface MutationReceipt {
  draftId: string;
  operationGroupId: string;
  changedEntityIds: string[];
}

export interface MutationApi {
  stage(input: { intents: MutationIntent[] }): Promise<AppResult<MutationPreview>>;
  confirm(input: { draftId: string; draftVersion: number; selectedChangeIds: string[]; acknowledgedWarningCodes: string[] }): Promise<AppResult<MutationReceipt>>;
  revise(input: { draftId: string; intents: MutationIntent[] }): Promise<AppResult<MutationPreview>>;
}
