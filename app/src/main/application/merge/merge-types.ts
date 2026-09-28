import type { PersonRecord } from "../../database/repositories/person-repository.js";

export interface MergeDecision {
  primaryPersonId: string;
  secondaryPersonId: string;
  scalarChoices: Record<string, "primary" | "secondary">;
  expectedVersions: Record<string, number>;
}

export interface MergePreview {
  primary: PersonRecord;
  secondary: PersonRecord;
  scalarConflicts: Array<{ field: "displayName" | "gender" | "birth" | "death" | "notes"; primary: unknown; secondary: unknown }>;
  aliases: Array<Record<string, unknown>>;
  parents: Array<Record<string, unknown>>;
  children: Array<Record<string, unknown>>;
  spouses: Array<Record<string, unknown>>;
  lineages: Array<Record<string, unknown> & { membershipId?: string }>;
  media: Array<Record<string, unknown> & { linkId?: string }>;
  sources: Array<Record<string, unknown>>;
  expectedVersions: Record<string, number>;
}

export interface DuplicateCandidate {
  person: PersonRecord;
  score: number;
  reasons: Array<{ code: "NAME_OVERLAP" | "BIRTH_COMPATIBLE" | "SHARED_PARENT" | "SHARED_SPOUSE" | "SHARED_CHILD"; detail: string }>;
}

export interface CanUnmergeResult {
  allowed: boolean;
  blockingEntityIds: string[];
  reasons: Array<{ entityId: string; entityType: string; expectedVersion: number; actualVersion: number | null }>;
}
