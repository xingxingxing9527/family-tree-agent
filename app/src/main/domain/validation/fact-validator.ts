import type { PartialDate } from "../../../shared/domain.js";
import { wouldCreateParentCycle, type ParentEdge } from "./graph-cycle-detector.js";
import type { DomainIssue, ValidationResult } from "./partial-date-validator.js";

export type { DomainIssue, ValidationResult } from "./partial-date-validator.js";

export interface PersonFact {
  id: string;
  workspaceId: string;
  birth: PartialDate | null;
}

const issue = (code: string, message: string): DomainIssue => ({ code, message });

export function validateParentChildFact(
  parent: PersonFact,
  child: PersonFact,
  existingEdges: ReadonlyArray<ParentEdge>
): ValidationResult {
  const errors: DomainIssue[] = [];
  const warnings: DomainIssue[] = [];

  if (parent.workspaceId !== child.workspaceId) {
    errors.push(issue("WORKSPACE_MISMATCH", "Parent and child must belong to the open workspace"));
  }
  if (parent.id === child.id) {
    errors.push(issue("SELF_RELATION", "A person cannot be their own parent"));
  } else if (wouldCreateParentCycle(parent.id, child.id, existingEdges)) {
    errors.push(issue("PARENT_CYCLE", "The parent-child relation would create a cycle"));
  }

  if (parent.birth && child.birth) {
    const ageByKnownYears = child.birth.year - parent.birth.year;
    if (ageByKnownYears < 0) {
      errors.push(issue("IMPOSSIBLE_DATE", "A child cannot be born before the known parent birth year"));
    } else if (ageByKnownYears < 12 || ageByKnownYears > 80) {
      warnings.push(issue("PARENT_AGE_OUTLIER", "The parent's age at the child's birth is outside 12 to 80 years"));
    }
  }

  return { errors, warnings };
}

export function validateMarriageFact(spouseA: PersonFact, spouseB: PersonFact): ValidationResult {
  const errors: DomainIssue[] = [];
  if (spouseA.workspaceId !== spouseB.workspaceId) {
    errors.push(issue("WORKSPACE_MISMATCH", "Both spouses must belong to the open workspace"));
  }
  if (spouseA.id === spouseB.id) {
    errors.push(issue("SELF_RELATION", "A person cannot marry themselves"));
  }
  return { errors, warnings: [] };
}
