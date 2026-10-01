import { describe, expect, it } from "vitest";
import type { PartialDate } from "../../../src/shared/domain";
import {
  ParentCompletionPlanner,
  type ParentCompletionInput,
  type ParentCompletionMarriage,
  type ParentCompletionPerson
} from "../../../src/main/domain/relations/parent-completion-planner";

const solar = (year: number, month: number, day: number | null = null): PartialDate => ({
  calendar: "solar",
  year,
  month,
  day,
  leapMonth: false,
  precision: day === null ? "month" : "day"
});

const lunar = (year: number, month: number, day: number | null = null): PartialDate => ({
  calendar: "lunar",
  year,
  month,
  day,
  leapMonth: false,
  precision: day === null ? "month" : "day"
});

const person = (
  id: string,
  gender: ParentCompletionPerson["gender"] = "unknown",
  birth: PartialDate | null = null
): ParentCompletionPerson => ({ id, gender, birth });

const marriage = (
  id: string,
  spouseId: string,
  start: PartialDate | null = null,
  end: PartialDate | null = null,
  status: ParentCompletionMarriage["status"] = "active"
): ParentCompletionMarriage => ({
  id,
  spouseAId: "known",
  spouseBId: spouseId,
  status,
  start,
  end,
  deletedAt: null
});

const input = (overrides: Partial<ParentCompletionInput> = {}): ParentCompletionInput => ({
  people: [person("known", "male"), person("child")],
  knownParentId: "known",
  childId: "child",
  parentRole: "father",
  marriages: [],
  existingParents: [],
  ...overrides
});

const issueCodes = (plan: ReturnType<ParentCompletionPlanner["plan"]>): string[] => (
  plan.issues.map(({ code }) => code)
);

describe("ParentCompletionPlanner", () => {
  const planner = new ParentCompletionPlanner();

  it("returns only the explicit relation when there is no spouse candidate", () => {
    const plan = planner.plan(input());

    expect(plan).toMatchObject({
      status: "no_candidate",
      basis: null,
      explicit: { parentId: "known", childId: "child", parentRole: "father" },
      candidates: []
    });
    expect(plan.suggested).toBeUndefined();
    expect(issueCodes(plan)).toEqual(["PARENT_COMPLETION_NO_CANDIDATE"]);
    expect(plan.evidenceIds).toEqual(["person:child", "person:known"]);
  });

  it("suggests the complementary parent role for one spouse", () => {
    const plan = planner.plan(input({
      people: [person("known", "male"), person("child"), person("spouse", "female")],
      marriages: [marriage("marriage-1", "spouse")]
    }));

    expect(plan).toMatchObject({
      status: "suggested",
      basis: "unique_spouse",
      suggested: {
        parentId: "spouse",
        childId: "child",
        parentRole: "mother",
        inferredFromMarriageId: "marriage-1"
      },
      candidates: [{ spouseId: "spouse", marriageIds: ["marriage-1"] }]
    });
    expect(plan.issues).toEqual([]);
  });

  it("deduplicates repeated marriages to the same spouse without inventing an episode", () => {
    const plan = planner.plan(input({
      people: [person("known"), person("child"), person("spouse")],
      marriages: [
        marriage("later", "spouse", solar(2000, 1), null),
        marriage("earlier", "spouse", solar(1980, 1), solar(1990, 1), "divorced")
      ]
    }));

    expect(plan).toMatchObject({
      status: "suggested",
      basis: "unique_spouse",
      suggested: { parentId: "spouse", inferredFromMarriageId: null },
      candidates: [{ spouseId: "spouse", marriageIds: ["earlier", "later"] }]
    });
    expect(plan.candidates).toHaveLength(1);
  });

  it("uses birth evidence only when one spouse is inside and every alternative is outside", () => {
    const plan = planner.plan(input({
      people: [person("known"), person("child", "unknown", solar(1985, 6, 10)), person("old-spouse"), person("new-spouse")],
      marriages: [
        marriage("new-marriage", "new-spouse", solar(1995, 1, 1), null),
        marriage("old-marriage", "old-spouse", solar(1980, 1, 1), solar(1990, 12, 31), "divorced")
      ]
    }));

    expect(plan).toMatchObject({
      status: "suggested",
      basis: "birth_interval",
      suggested: { parentId: "old-spouse", inferredFromMarriageId: "old-marriage" }
    });
    expect(plan.candidates.map(({ spouseId, intervalRelation }) => ({ spouseId, intervalRelation }))).toEqual([
      { spouseId: "new-spouse", intervalRelation: "outside" },
      { spouseId: "old-spouse", intervalRelation: "inside" }
    ]);
  });

  it.each([
    {
      name: "the child birth date is missing",
      birth: null,
      marriages: [
        marriage("first", "first-spouse", solar(1980, 1), solar(1990, 1), "divorced"),
        marriage("second", "second-spouse", solar(1995, 1), null)
      ]
    },
    {
      name: "marriage intervals overlap the child birth date",
      birth: solar(2000, 6, 15),
      marriages: [
        marriage("first", "first-spouse", solar(1990, 1), solar(2000, 6), "divorced"),
        marriage("second", "second-spouse", solar(2000, 6, 1), null)
      ]
    },
    {
      name: "the child and one marriage use different calendars",
      birth: solar(2000, 6, 1),
      marriages: [
        marriage("solar", "solar-spouse", solar(1990, 1), solar(1999, 12), "divorced"),
        marriage("lunar", "lunar-spouse", lunar(1999, 1), lunar(2001, 1), "divorced")
      ]
    },
    {
      name: "an alternative candidate has unknown interval evidence",
      birth: solar(2000, 6, 1),
      marriages: [
        marriage("inside", "inside-spouse", solar(1999, 1), solar(2001, 1), "divorced"),
        marriage("unknown", "unknown-spouse")
      ]
    }
  ])("stays ambiguous when $name", ({ birth, marriages }) => {
    const plan = planner.plan(input({
      people: [person("known"), person("child", "unknown", birth), person("first-spouse"), person("second-spouse"), person("solar-spouse"), person("lunar-spouse"), person("inside-spouse"), person("unknown-spouse")],
      marriages
    }));

    expect(plan.status).toBe("ambiguous");
    expect(plan.basis).toBeNull();
    expect(plan.suggested).toBeUndefined();
    expect(issueCodes(plan)).toEqual(["PARENT_COMPLETION_AMBIGUOUS"]);
  });

  it("returns unchanged when the selected spouse already occupies the complementary role", () => {
    const plan = planner.plan(input({
      people: [person("known"), person("child"), person("spouse")],
      marriages: [marriage("marriage-1", "spouse")],
      existingParents: [{ id: "existing-mother", parentId: "spouse", childId: "child", parentRole: "mother" }]
    }));

    expect(plan).toMatchObject({
      status: "unchanged",
      basis: "unique_spouse",
      suggested: { parentId: "spouse", parentRole: "mother" }
    });
    expect(plan.evidenceIds).toContain("parent-child:existing-mother");
    expect(plan.issues).toEqual([]);
  });

  it("returns conflict instead of overwriting a different complementary parent", () => {
    const plan = planner.plan(input({
      people: [person("known"), person("child"), person("spouse"), person("recorded-mother")],
      marriages: [marriage("marriage-1", "spouse")],
      existingParents: [{ id: "existing-mother", parentId: "recorded-mother", childId: "child", parentRole: "mother" }]
    }));

    expect(plan).toMatchObject({
      status: "conflict",
      basis: "unique_spouse",
      suggested: { parentId: "spouse", parentRole: "mother" }
    });
    expect(issueCodes(plan)).toEqual(["PARENT_ROLE_OCCUPIED"]);
  });

  it("honors an administrator-selected recorded spouse", () => {
    const plan = planner.plan(input({
      people: [person("known"), person("child"), person("first-spouse"), person("second-spouse")],
      marriages: [marriage("first", "first-spouse"), marriage("second", "second-spouse")],
      selectedSpouseId: "second-spouse"
    }));

    expect(plan).toMatchObject({
      status: "suggested",
      basis: "administrator_selected",
      suggested: { parentId: "second-spouse", inferredFromMarriageId: "second" }
    });
  });

  it("rejects an administrator-selected person who is not a spouse candidate", () => {
    const plan = planner.plan(input({
      people: [person("known"), person("child"), person("spouse"), person("outsider")],
      marriages: [marriage("marriage-1", "spouse")],
      selectedSpouseId: "outsider"
    }));

    expect(plan.status).toBe("ambiguous");
    expect(plan.basis).toBeNull();
    expect(plan.suggested).toBeUndefined();
    expect(issueCodes(plan)).toEqual(["PARENT_COMPLETION_INVALID_SELECTION"]);
  });

  it("warns about a gender mismatch without blocking the suggestion", () => {
    const plan = planner.plan(input({
      people: [person("known", "male"), person("child"), person("spouse", "male")],
      marriages: [marriage("marriage-1", "spouse")]
    }));

    expect(plan).toMatchObject({
      status: "suggested",
      suggested: { parentId: "spouse", parentRole: "mother" }
    });
    expect(plan.issues).toEqual([{
      code: "PARENT_GENDER_MISMATCH",
      severity: "warning",
      evidenceIds: ["person:spouse"]
    }]);
  });

  it("computes father as the complementary role for an explicit mother", () => {
    const plan = planner.plan(input({
      parentRole: "mother",
      people: [person("known", "female"), person("child"), person("spouse", "male")],
      marriages: [marriage("marriage-1", "spouse")]
    }));

    expect(plan.suggested).toMatchObject({ parentId: "spouse", parentRole: "father" });
  });

  it("excludes deleted marriage episodes from spouse candidates", () => {
    const deleted = { ...marriage("deleted", "spouse"), deletedAt: "2026-01-01T00:00:00.000Z" };
    const plan = planner.plan(input({
      people: [person("known"), person("child"), person("spouse")],
      marriages: [deleted]
    }));

    expect(plan.status).toBe("no_candidate");
    expect(plan.candidates).toEqual([]);
  });

  it("returns candidates and evidence IDs in deterministic order", () => {
    const firstInput = input({
      people: [person("z-spouse"), person("child"), person("known"), person("a-spouse")],
      marriages: [marriage("z-marriage", "z-spouse"), marriage("a-marriage", "a-spouse")]
    });
    const secondInput = {
      ...firstInput,
      people: [...firstInput.people].reverse(),
      marriages: [...firstInput.marriages].reverse()
    };

    const first = planner.plan(firstInput);
    const second = planner.plan(secondInput);

    expect(first.candidates.map(({ spouseId }) => spouseId)).toEqual(["a-spouse", "z-spouse"]);
    expect(first.evidenceIds).toEqual([
      "marriage:a-marriage",
      "marriage:z-marriage",
      "person:a-spouse",
      "person:child",
      "person:known",
      "person:z-spouse"
    ]);
    expect(second).toEqual(first);
  });
});
