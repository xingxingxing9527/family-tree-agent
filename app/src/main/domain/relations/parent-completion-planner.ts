import type { PartialDate } from "../../../shared/domain.js";
import {
  relationToPartialDateInterval,
  type PartialDateIntervalRelation
} from "./partial-date-interval.js";

export type ParentCompletionRole = "father" | "mother";
export type ParentCompletionStatus = "suggested" | "no_candidate" | "ambiguous" | "unchanged" | "conflict";
export type ParentCompletionBasis = "unique_spouse" | "birth_interval" | "administrator_selected" | null;
export type ParentCompletionIssueCode =
  | "PARENT_COMPLETION_NO_CANDIDATE"
  | "PARENT_COMPLETION_AMBIGUOUS"
  | "PARENT_COMPLETION_INVALID_SELECTION"
  | "PARENT_ROLE_OCCUPIED"
  | "PARENT_GENDER_MISMATCH";

export interface ParentCompletionPerson {
  id: string;
  gender: "male" | "female" | "unknown";
  birth: PartialDate | null;
}

export interface ParentCompletionMarriage {
  id: string;
  spouseAId: string;
  spouseBId: string;
  status: "active" | "divorced";
  start: PartialDate | null;
  end: PartialDate | null;
  deletedAt?: string | null;
}

export interface ParentCompletionExistingParent {
  id: string;
  parentId: string;
  childId: string;
  parentRole: ParentCompletionRole;
}

export interface ParentCompletionInput {
  people: ParentCompletionPerson[];
  knownParentId: string;
  childId: string;
  parentRole: ParentCompletionRole;
  marriages: ParentCompletionMarriage[];
  existingParents: ParentCompletionExistingParent[];
  selectedSpouseId?: string;
}

export interface PlannedParentRelation {
  parentId: string;
  childId: string;
  parentRole: ParentCompletionRole;
}

export interface SuggestedParentRelation extends PlannedParentRelation {
  inferredFromMarriageId: string | null;
}

export interface ParentCompletionCandidate {
  spouseId: string;
  marriageIds: string[];
  intervalRelation: PartialDateIntervalRelation;
  evidenceIds: string[];
}

export interface ParentCompletionIssue {
  code: ParentCompletionIssueCode;
  severity: "info" | "warning" | "error";
  evidenceIds: string[];
}

export interface ParentCompletionPlan {
  status: ParentCompletionStatus;
  explicit: PlannedParentRelation;
  suggested?: SuggestedParentRelation;
  basis: ParentCompletionBasis;
  candidates: ParentCompletionCandidate[];
  issues: ParentCompletionIssue[];
  evidenceIds: string[];
}

interface CandidateWork extends ParentCompletionCandidate {
  episodes: Array<{
    marriage: ParentCompletionMarriage;
    relation: PartialDateIntervalRelation;
  }>;
}

const compareId = (left: string, right: string): number => left.localeCompare(right);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(compareId);

function complementaryRole(role: ParentCompletionRole): ParentCompletionRole {
  return role === "father" ? "mother" : "father";
}

function candidateRelation(relations: PartialDateIntervalRelation[]): PartialDateIntervalRelation {
  if (relations.includes("inside")) return "inside";
  return relations.every((relation) => relation === "outside") ? "outside" : "unknown";
}

function attributableMarriageId(candidate: CandidateWork): string | null {
  if (candidate.episodes.length === 1) return candidate.episodes[0].marriage.id;
  const inside = candidate.episodes.filter(({ relation }) => relation === "inside");
  return inside.length === 1
    && candidate.episodes.every((episode) => episode === inside[0] || episode.relation === "outside")
    ? inside[0].marriage.id
    : null;
}

export class ParentCompletionPlanner {
  plan(input: ParentCompletionInput): ParentCompletionPlan {
    const people = new Map(input.people.map((person) => [person.id, person]));
    const childBirth = people.get(input.childId)?.birth ?? null;
    const explicit: PlannedParentRelation = {
      parentId: input.knownParentId,
      childId: input.childId,
      parentRole: input.parentRole
    };
    const candidates = this.candidates(input, childBirth);
    const baseEvidenceIds = sortedUnique([
      `person:${input.childId}`,
      `person:${input.knownParentId}`,
      ...candidates.flatMap(({ evidenceIds }) => evidenceIds),
      ...input.existingParents
        .filter(({ childId }) => childId === input.childId)
        .map(({ id }) => `parent-child:${id}`)
    ]);

    if (input.selectedSpouseId !== undefined) {
      const selected = candidates.find(({ spouseId }) => spouseId === input.selectedSpouseId);
      if (!selected) {
        return {
          status: "ambiguous",
          explicit,
          basis: null,
          candidates: candidates.map(this.publicCandidate),
          issues: [{
            code: "PARENT_COMPLETION_INVALID_SELECTION",
            severity: "error",
            evidenceIds: [`person:${input.selectedSpouseId}`]
          }],
          evidenceIds: sortedUnique([...baseEvidenceIds, `person:${input.selectedSpouseId}`])
        };
      }
      return this.selectedPlan(input, explicit, candidates, selected, "administrator_selected", people, baseEvidenceIds);
    }

    if (candidates.length === 0) {
      return {
        status: "no_candidate",
        explicit,
        basis: null,
        candidates: [],
        issues: [{ code: "PARENT_COMPLETION_NO_CANDIDATE", severity: "info", evidenceIds: baseEvidenceIds }],
        evidenceIds: baseEvidenceIds
      };
    }

    if (candidates.length === 1) {
      return this.selectedPlan(input, explicit, candidates, candidates[0], "unique_spouse", people, baseEvidenceIds);
    }

    const inside = candidates.filter(({ intervalRelation }) => intervalRelation === "inside");
    const selected = inside.length === 1
      && candidates.every((candidate) => candidate === inside[0] || candidate.intervalRelation === "outside")
      ? inside[0]
      : null;
    if (!selected) {
      return {
        status: "ambiguous",
        explicit,
        basis: null,
        candidates: candidates.map(this.publicCandidate),
        issues: [{ code: "PARENT_COMPLETION_AMBIGUOUS", severity: "warning", evidenceIds: baseEvidenceIds }],
        evidenceIds: baseEvidenceIds
      };
    }

    return this.selectedPlan(input, explicit, candidates, selected, "birth_interval", people, baseEvidenceIds);
  }

  private candidates(input: ParentCompletionInput, childBirth: PartialDate | null): CandidateWork[] {
    const bySpouse = new Map<string, ParentCompletionMarriage[]>();
    for (const marriage of input.marriages) {
      if (marriage.deletedAt) continue;
      const spouseId = marriage.spouseAId === input.knownParentId
        ? marriage.spouseBId
        : marriage.spouseBId === input.knownParentId
          ? marriage.spouseAId
          : null;
      if (!spouseId || spouseId === input.knownParentId) continue;
      const episodes = bySpouse.get(spouseId) ?? [];
      episodes.push(marriage);
      bySpouse.set(spouseId, episodes);
    }

    return [...bySpouse.entries()]
      .sort(([left], [right]) => compareId(left, right))
      .map(([spouseId, unsortedEpisodes]) => {
        const episodes = [...unsortedEpisodes]
          .sort((left, right) => compareId(left.id, right.id))
          .map((marriage) => ({
            marriage,
            relation: relationToPartialDateInterval(childBirth, marriage.start, marriage.end)
          }));
        const marriageIds = episodes.map(({ marriage }) => marriage.id);
        return {
          spouseId,
          marriageIds,
          intervalRelation: candidateRelation(episodes.map(({ relation }) => relation)),
          evidenceIds: sortedUnique([`person:${spouseId}`, ...marriageIds.map((id) => `marriage:${id}`)]),
          episodes
        };
      });
  }

  private selectedPlan(
    input: ParentCompletionInput,
    explicit: PlannedParentRelation,
    candidates: CandidateWork[],
    selected: CandidateWork,
    basis: Exclude<ParentCompletionBasis, null>,
    people: Map<string, ParentCompletionPerson>,
    evidenceIds: string[]
  ): ParentCompletionPlan {
    const parentRole = complementaryRole(input.parentRole);
    const suggested: SuggestedParentRelation = {
      parentId: selected.spouseId,
      childId: input.childId,
      parentRole,
      inferredFromMarriageId: attributableMarriageId(selected)
    };
    const occupyingParents = input.existingParents
      .filter((parent) => parent.childId === input.childId && parent.parentRole === parentRole)
      .sort((left, right) => compareId(left.id, right.id));
    const issues: ParentCompletionIssue[] = [];
    let status: ParentCompletionStatus = "suggested";
    if (occupyingParents.length > 0) {
      if (occupyingParents.every(({ parentId }) => parentId === selected.spouseId)) {
        status = "unchanged";
      } else {
        status = "conflict";
        issues.push({
          code: "PARENT_ROLE_OCCUPIED",
          severity: "error",
          evidenceIds: occupyingParents.map(({ id }) => `parent-child:${id}`)
        });
      }
    }

    const selectedGender = people.get(selected.spouseId)?.gender ?? "unknown";
    const expectedGender = parentRole === "father" ? "male" : "female";
    if (selectedGender !== "unknown" && selectedGender !== expectedGender) {
      issues.push({
        code: "PARENT_GENDER_MISMATCH",
        severity: "warning",
        evidenceIds: [`person:${selected.spouseId}`]
      });
    }

    return {
      status,
      explicit,
      suggested,
      basis,
      candidates: candidates.map(this.publicCandidate),
      issues,
      evidenceIds
    };
  }

  private publicCandidate(candidate: CandidateWork): ParentCompletionCandidate {
    return {
      spouseId: candidate.spouseId,
      marriageIds: candidate.marriageIds,
      intervalRelation: candidate.intervalRelation,
      evidenceIds: candidate.evidenceIds
    };
  }
}
