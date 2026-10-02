import { describe, expect, it } from "vitest";
import {
  TreeScopeResolutionError,
  TreeScopeResolver,
  type TreeScopeInput,
  type TreeScopeRequest,
  type TreeScopeResolution
} from "../../../src/main/domain/projection/tree-scope-resolver";

const personIds = [
  "subject",
  "father",
  "mother",
  "paternal-grandfather",
  "paternal-grandmother",
  "maternal-grandfather",
  "maternal-grandmother",
  "great-grandparent",
  "full-sibling",
  "paternal-half-sibling",
  "maternal-half-sibling",
  "other-mother",
  "other-father",
  "child",
  "grandchild",
  "current-spouse",
  "former-spouse-with-child",
  "former-spouse-without-child",
  "unmarried-coparent",
  "child-current-spouse",
  "sibling-spouse",
  "sibling-child",
  "spouse-unrelated-child",
  "associated-member",
  "married-in-member",
  "isolated"
] as const;

const fixture: TreeScopeInput = {
  people: personIds.map((id) => ({ id })),
  parentChildFacts: [
    { id: "pc-great-pgf", parentId: "great-grandparent", childId: "paternal-grandfather" },
    { id: "pc-pgf-father", parentId: "paternal-grandfather", childId: "father" },
    { id: "pc-pgm-father", parentId: "paternal-grandmother", childId: "father" },
    { id: "pc-mgf-mother", parentId: "maternal-grandfather", childId: "mother" },
    { id: "pc-mgm-mother", parentId: "maternal-grandmother", childId: "mother" },
    { id: "pc-father-subject", parentId: "father", childId: "subject" },
    { id: "pc-mother-subject", parentId: "mother", childId: "subject" },
    { id: "pc-father-full", parentId: "father", childId: "full-sibling" },
    { id: "pc-mother-full", parentId: "mother", childId: "full-sibling" },
    { id: "pc-father-half", parentId: "father", childId: "paternal-half-sibling" },
    { id: "pc-other-mother-half", parentId: "other-mother", childId: "paternal-half-sibling" },
    { id: "pc-mother-half", parentId: "mother", childId: "maternal-half-sibling" },
    { id: "pc-other-father-half", parentId: "other-father", childId: "maternal-half-sibling" },
    { id: "pc-subject-child", parentId: "subject", childId: "child" },
    { id: "pc-former-child", parentId: "former-spouse-with-child", childId: "child" },
    { id: "pc-unmarried-child", parentId: "unmarried-coparent", childId: "child" },
    { id: "pc-child-grandchild", parentId: "child", childId: "grandchild" },
    { id: "pc-child-spouse-grandchild", parentId: "child-current-spouse", childId: "grandchild" },
    { id: "pc-sibling-niece", parentId: "full-sibling", childId: "sibling-child" },
    { id: "pc-sibling-spouse-niece", parentId: "sibling-spouse", childId: "sibling-child" },
    { id: "pc-current-unrelated", parentId: "current-spouse", childId: "spouse-unrelated-child" }
  ],
  marriages: [
    { id: "m-subject-current", spouseAId: "subject", spouseBId: "current-spouse", status: "active" },
    { id: "m-subject-former-shared", spouseAId: "subject", spouseBId: "former-spouse-with-child", status: "divorced" },
    { id: "m-subject-former-no-child", spouseAId: "subject", spouseBId: "former-spouse-without-child", status: "divorced" },
    { id: "m-father-mother", spouseAId: "father", spouseBId: "mother", status: "active" },
    { id: "m-paternal-grandparents", spouseAId: "paternal-grandfather", spouseBId: "paternal-grandmother", status: "active" },
    { id: "m-maternal-grandparents", spouseAId: "maternal-grandfather", spouseBId: "maternal-grandmother", status: "active" },
    { id: "m-child-current", spouseAId: "child", spouseBId: "child-current-spouse", status: "active" },
    { id: "m-sibling-current", spouseAId: "full-sibling", spouseBId: "sibling-spouse", status: "active" }
  ],
  lineageIds: ["lineage-a", "lineage-b"],
  memberships: [
    { lineageId: "lineage-a", personId: "subject", lineageRole: "blood", isPrimary: true },
    { lineageId: "lineage-a", personId: "father", lineageRole: "blood", isPrimary: true },
    { lineageId: "lineage-a", personId: "associated-member", lineageRole: "associated", isPrimary: false },
    { lineageId: "lineage-a", personId: "full-sibling", lineageRole: "associated", isPrimary: false },
    { lineageId: "lineage-a", personId: "married-in-member", lineageRole: "married_in", isPrimary: false }
  ]
};

const resolver = new TreeScopeResolver();

const resolve = (request: TreeScopeRequest, input: TreeScopeInput = fixture): TreeScopeResolution =>
  resolver.resolve(input, request);

const sorted = (values: ReadonlySet<string>): string[] => [...values].sort();

const expectScopeError = (callback: () => unknown, code: "NOT_FOUND" | "VALIDATION"): void => {
  try {
    callback();
    throw new Error("Expected scope resolution to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(TreeScopeResolutionError);
    expect((error as TreeScopeResolutionError).code).toBe(code);
  }
};

describe("TreeScopeResolver", () => {
  it("returns the complete graph for Full Tree", () => {
    const resolution = resolve({ view: "full" });

    expect(resolution.key).toBe("full");
    expect(sorted(resolution.personIds)).toEqual([...personIds].sort());
    expect(sorted(resolution.parentChildRelationIds)).toEqual(fixture.parentChildFacts.map(({ id }) => id).sort());
    expect(sorted(resolution.marriageIds)).toEqual(fixture.marriages.map(({ id }) => id).sort());
    expect(resolution.metadata).toEqual({ view: "full", subjectId: null, lineageId: null });
  });

  it("pins the exact Core Relatives boundary, including full and half siblings", () => {
    const resolution = resolve({ view: "core", subjectId: "subject" });

    expect(resolution.key).toBe("core:subject");
    expect(sorted(resolution.personIds)).toEqual([
      "subject",
      "father",
      "mother",
      "paternal-grandfather",
      "paternal-grandmother",
      "maternal-grandfather",
      "maternal-grandmother",
      "full-sibling",
      "paternal-half-sibling",
      "maternal-half-sibling",
      "child",
      "current-spouse",
      "former-spouse-with-child"
    ].sort());
    expect(sorted(resolution.parentChildRelationIds)).toEqual([
      "pc-pgf-father",
      "pc-pgm-father",
      "pc-mgf-mother",
      "pc-mgm-mother",
      "pc-father-subject",
      "pc-mother-subject",
      "pc-father-full",
      "pc-mother-full",
      "pc-father-half",
      "pc-mother-half",
      "pc-subject-child",
      "pc-former-child"
    ].sort());
    expect(sorted(resolution.marriageIds)).toEqual([
      "m-subject-current",
      "m-subject-former-shared",
      "m-father-mother",
      "m-paternal-grandparents",
      "m-maternal-grandparents"
    ].sort());
  });

  it("returns every descendant generation and only the spouses needed for that chain", () => {
    const resolution = resolve({ view: "descendants", subjectId: "subject" });

    expect(resolution.key).toBe("descendants:subject");
    expect(sorted(resolution.personIds)).toEqual([
      "subject",
      "child",
      "grandchild",
      "current-spouse",
      "former-spouse-with-child",
      "child-current-spouse"
    ].sort());
    expect(sorted(resolution.parentChildRelationIds)).toEqual([
      "pc-subject-child",
      "pc-former-child",
      "pc-child-grandchild",
      "pc-child-spouse-grandchild"
    ].sort());
    expect(sorted(resolution.marriageIds)).toEqual([
      "m-subject-current",
      "m-subject-former-shared",
      "m-child-current"
    ].sort());
  });

  it("uses explicit lineage roles and supplements only permitted blood-member spouses", () => {
    const resolution = resolve({ view: "lineage", subjectId: "subject", lineageId: "lineage-a" });

    expect(resolution.key).toBe("lineage:subject:lineage-a");
    expect(sorted(resolution.personIds)).toEqual([
      "subject",
      "father",
      "mother",
      "full-sibling",
      "associated-member",
      "married-in-member",
      "current-spouse",
      "former-spouse-with-child"
    ].sort());
    expect(sorted(resolution.parentChildRelationIds)).toEqual([
      "pc-father-subject",
      "pc-mother-subject",
      "pc-father-full",
      "pc-mother-full"
    ].sort());
    expect(sorted(resolution.marriageIds)).toEqual([
      "m-subject-current",
      "m-subject-former-shared",
      "m-father-mother"
    ].sort());
  });

  it("validates subject and lineage selection without guessing", () => {
    expectScopeError(() => resolve({ view: "core", subjectId: "missing" }), "NOT_FOUND");
    expectScopeError(() => resolve({ view: "descendants" }), "VALIDATION");
    expectScopeError(
      () => resolve({ view: "lineage", subjectId: "subject", lineageId: "missing-lineage" }),
      "NOT_FOUND"
    );
    expectScopeError(
      () => resolve({ view: "lineage", subjectId: "subject", lineageId: "lineage-b" }),
      "VALIDATION"
    );
  });

  it("terminates cyclic descendant data and deduplicates people and facts", () => {
    const cyclic: TreeScopeInput = {
      people: [{ id: "subject" }, { id: "child" }],
      parentChildFacts: [
        { id: "pc-forward", parentId: "subject", childId: "child" },
        { id: "pc-back", parentId: "child", childId: "subject" },
        { id: "pc-forward", parentId: "subject", childId: "child" }
      ],
      marriages: [],
      lineageIds: [],
      memberships: []
    };

    const resolution = resolve({ view: "descendants", subjectId: "subject" }, cyclic);
    expect(sorted(resolution.personIds)).toEqual(["child", "subject"]);
    expect(sorted(resolution.parentChildRelationIds)).toEqual(["pc-back", "pc-forward"]);
  });
});
