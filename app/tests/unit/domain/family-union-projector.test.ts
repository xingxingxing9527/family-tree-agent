import { describe, expect, it } from "vitest";
import type { PartialDate } from "../../../src/shared/domain";
import { FamilyUnionProjector } from "../../../src/main/domain/projection/family-union-projector";
import { TreeProjectionService } from "../../../src/main/domain/projection/tree-projection-service";

const solar = (year: number, month: number, day: number | null = null): PartialDate => ({
  calendar: "solar",
  year,
  month,
  day,
  leapMonth: false,
  precision: day === null ? "month" : "day"
});

const lunar = (year: number, month: number, day: number | null = null, leapMonth = false): PartialDate => ({
  calendar: "lunar",
  year,
  month,
  day,
  leapMonth,
  precision: day === null ? "month" : "day"
});

describe("FamilyUnionProjector", () => {
  it("keeps ended marriages visible and reuses one remarried person across marriage unions", () => {
    const unions = new FamilyUnionProjector().project({
      people: [
        { id: "alex", birth: solar(1960, 1) },
        { id: "blair", birth: solar(1962, 1) },
        { id: "casey", birth: solar(1964, 1) },
        { id: "child-old", birth: solar(1985, 1) },
        { id: "child-new", birth: solar(2000, 1) }
      ],
      marriages: [
        { id: "old", spouseAId: "alex", spouseBId: "blair", status: "divorced", start: solar(1980, 1), end: solar(1990, 1) },
        { id: "new", spouseAId: "alex", spouseBId: "casey", status: "active", start: solar(1995, 1), end: null }
      ],
      parentChildFacts: [
        { parentId: "alex", childId: "child-old", relationshipType: "biological" },
        { parentId: "blair", childId: "child-old", relationshipType: "biological" },
        { parentId: "alex", childId: "child-new", relationshipType: "biological" },
        { parentId: "casey", childId: "child-new", relationshipType: "biological" }
      ]
    });

    expect(unions).toEqual([
      {
        id: "marriage:new",
        kind: "marriage",
        parentIds: ["alex", "casey"],
        marriageId: "new",
        marriageStatus: "active",
        marriageStart: solar(1995, 1),
        marriageEnd: null,
        childIds: ["child-new"],
        warnings: []
      },
      {
        id: "marriage:old",
        kind: "marriage",
        parentIds: ["alex", "blair"],
        marriageId: "old",
        marriageStatus: "divorced",
        marriageStart: solar(1980, 1),
        marriageEnd: solar(1990, 1),
        childIds: ["child-old"],
        warnings: []
      }
    ]);
    expect(unions.flatMap((union) => union.parentIds).filter((id) => id === "alex")).toHaveLength(2);
  });

  it("creates a stable co-parent union for two confirmed parents without a marriage", () => {
    const unions = new FamilyUnionProjector().project({
      people: [{ id: "child", birth: null }],
      marriages: [],
      parentChildFacts: [
        { parentId: "parent-b", childId: "child", relationshipType: "biological" },
        { parentId: "parent-a", childId: "child", relationshipType: "biological" }
      ]
    });

    expect(unions).toEqual([{
      id: "parents:parent-a:parent-b",
      kind: "coParents",
      parentIds: ["parent-a", "parent-b"],
      marriageId: null,
      marriageStatus: null,
      marriageStart: null,
      marriageEnd: null,
      childIds: ["child"],
      warnings: []
    }]);
  });

  it("creates a stable single-parent union without inferring another parent", () => {
    const unions = new FamilyUnionProjector().project({
      people: [{ id: "child", birth: null }],
      marriages: [{ id: "unrelated", spouseAId: "known", spouseBId: "spouse", status: "active", start: null, end: null }],
      parentChildFacts: [{ parentId: "known", childId: "child", relationshipType: "biological" }]
    });

    expect(unions.find((union) => union.id === "single:known")).toEqual({
      id: "single:known",
      kind: "singleParent",
      parentIds: ["known"],
      marriageId: null,
      marriageStatus: null,
      marriageStart: null,
      marriageEnd: null,
      childIds: ["child"],
      warnings: []
    });
    expect(unions.find((union) => union.id === "marriage:unrelated")?.childIds).toEqual([]);
  });

  it("uses birth evidence only when one repeated marriage interval is unambiguous", () => {
    const unions = new FamilyUnionProjector().project({
      people: [
        { id: "clear-child", birth: solar(1985, 6, 10) },
        { id: "ambiguous-child", birth: null }
      ],
      marriages: [
        { id: "first", spouseAId: "parent-a", spouseBId: "parent-b", status: "divorced", start: solar(1980, 1, 1), end: solar(1990, 12, 31) },
        { id: "second", spouseAId: "parent-a", spouseBId: "parent-b", status: "divorced", start: solar(1995, 1, 1), end: solar(2010, 12, 31) }
      ],
      parentChildFacts: [
        { parentId: "parent-a", childId: "clear-child", relationshipType: "biological" },
        { parentId: "parent-b", childId: "clear-child", relationshipType: "biological" },
        { parentId: "parent-a", childId: "ambiguous-child", relationshipType: "biological" },
        { parentId: "parent-b", childId: "ambiguous-child", relationshipType: "biological" }
      ]
    });

    expect(unions.find((union) => union.id === "marriage:first")?.childIds).toEqual(["clear-child"]);
    expect(unions.find((union) => union.id === "marriage:second")?.childIds).toEqual([]);
    expect(unions.find((union) => union.id === "unassigned:parent-a:parent-b")).toEqual({
      id: "unassigned:parent-a:parent-b",
      kind: "unassigned",
      parentIds: ["parent-a", "parent-b"],
      marriageId: null,
      marriageStatus: null,
      marriageStart: null,
      marriageEnd: null,
      childIds: ["ambiguous-child"],
      warnings: [expect.stringContaining("ambiguous-child")]
    });
  });

  it("does not guess between repeated marriages when neither has date evidence", () => {
    const unions = new FamilyUnionProjector().project({
      people: [{ id: "child", birth: solar(2000, 1, 1) }],
      marriages: [
        { id: "first", spouseAId: "a", spouseBId: "b", status: "divorced", start: null, end: null },
        { id: "second", spouseAId: "b", spouseBId: "a", status: "active", start: null, end: null }
      ],
      parentChildFacts: [
        { parentId: "a", childId: "child", relationshipType: "biological" },
        { parentId: "b", childId: "child", relationshipType: "biological" }
      ]
    });

    expect(unions.find((union) => union.kind === "unassigned")?.id).toBe("unassigned:a:b");
    expect(unions.filter((union) => union.kind === "unassigned")).toHaveLength(1);
    expect(unions.filter((union) => union.kind === "marriage")).toHaveLength(2);
  });

  it("keeps December 31 before January 1 when selecting a repeated marriage", () => {
    const unions = new FamilyUnionProjector().project({
      people: [{ id: "child", birth: solar(2001, 1, 1) }],
      marriages: [
        { id: "first", spouseAId: "a", spouseBId: "b", status: "divorced", start: solar(1990, 1, 1), end: solar(2000, 12, 31) },
        { id: "second", spouseAId: "a", spouseBId: "b", status: "active", start: solar(2001, 1, 1), end: null }
      ],
      parentChildFacts: [
        { parentId: "a", childId: "child", relationshipType: "biological" },
        { parentId: "b", childId: "child", relationshipType: "biological" }
      ]
    });

    expect(unions.find((union) => union.id === "marriage:second")?.childIds).toEqual(["child"]);
    expect(unions.some((union) => union.kind === "unassigned")).toBe(false);
  });

  it("orders a lunar leap month after its regular month", () => {
    const unions = new FamilyUnionProjector().project({
      people: [{ id: "child", birth: lunar(2000, 1, 10, true) }],
      marriages: [
        { id: "regular", spouseAId: "a", spouseBId: "b", status: "divorced", start: lunar(2000, 1, 1), end: lunar(2000, 1, 30) },
        { id: "leap", spouseAId: "a", spouseBId: "b", status: "divorced", start: lunar(2000, 1, 1, true), end: lunar(2000, 1, 30, true) }
      ],
      parentChildFacts: [
        { parentId: "a", childId: "child", relationshipType: "biological" },
        { parentId: "b", childId: "child", relationshipType: "biological" }
      ]
    });

    expect(unions.find((union) => union.id === "marriage:leap")?.childIds).toEqual(["child"]);
    expect(unions.some((union) => union.kind === "unassigned")).toBe(false);
  });

  it("keeps a child unassigned when month precision overlaps another marriage", () => {
    const unions = new FamilyUnionProjector().project({
      people: [{ id: "child", birth: solar(2000, 1, 20) }],
      marriages: [
        { id: "first", spouseAId: "a", spouseBId: "b", status: "divorced", start: solar(1990, 1, 1), end: solar(2000, 1) },
        { id: "second", spouseAId: "a", spouseBId: "b", status: "active", start: solar(2000, 1, 15), end: null }
      ],
      parentChildFacts: [
        { parentId: "a", childId: "child", relationshipType: "biological" },
        { parentId: "b", childId: "child", relationshipType: "biological" }
      ]
    });

    const unassigned = unions.find((union) => union.id === "unassigned:a:b");
    expect(unassigned?.childIds).toEqual(["child"]);
    expect(unassigned?.warnings).toEqual([expect.stringContaining("child")]);
  });

  it("keeps a child unassigned when repeated marriage evidence uses different calendars", () => {
    const unions = new FamilyUnionProjector().project({
      people: [{ id: "child", birth: solar(2000, 6, 1) }],
      marriages: [
        { id: "solar", spouseAId: "a", spouseBId: "b", status: "divorced", start: solar(2000, 1, 1), end: solar(2000, 12, 31) },
        { id: "lunar", spouseAId: "a", spouseBId: "b", status: "divorced", start: lunar(1999, 1, 1), end: lunar(2001, 1, 1) }
      ],
      parentChildFacts: [
        { parentId: "a", childId: "child", relationshipType: "biological" },
        { parentId: "b", childId: "child", relationshipType: "biological" }
      ]
    });

    const unassigned = unions.find((union) => union.id === "unassigned:a:b");
    expect(unassigned?.childIds).toEqual(["child"]);
    expect(unassigned?.warnings).toHaveLength(1);
  });
});

describe("TreeProjectionService", () => {
  const people = ["a", "b", "c", "d", "e", "isolated"].map((id) => ({
    id,
    displayName: id.toUpperCase(),
    birthYear: null,
    deathYear: null,
    generation: null
  }));
  const unions = [
    {
      id: "marriage:first",
      kind: "marriage" as const,
      parentIds: ["a", "b"],
      marriageId: "first",
      marriageStatus: "divorced" as const,
      marriageStart: solar(1980, 1),
      marriageEnd: solar(1990, 1),
      childIds: ["c"],
      warnings: []
    },
    {
      id: "parents:c:d",
      kind: "coParents" as const,
      parentIds: ["c", "d"],
      marriageId: null,
      marriageStatus: null,
      marriageStart: null,
      marriageEnd: null,
      childIds: ["e"],
      warnings: []
    }
  ];

  const personIds = (projection: ReturnType<TreeProjectionService["ancestors"]>): string[] => projection.topology.nodes
    .filter((node) => node.kind === "person")
    .map((node) => node.personId)
    .sort();

  it("returns full, branch, ancestor and descendant scopes from the same family graph", () => {
    const service = new TreeProjectionService({ people, unions });

    expect(personIds(service.full("a", Number.POSITIVE_INFINITY))).toEqual(["a", "b", "c", "d", "e", "isolated"]);
    expect(personIds(service.branch("c"))).toEqual(["c", "d", "e"]);
    expect(personIds(service.ancestors("e"))).toEqual(["a", "b", "c", "d", "e"]);
    expect(personIds(service.descendants("a"))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("creates one person node for a remarried person participating in multiple unions", () => {
    const remarriageUnions = [
      { ...unions[0], parentIds: ["a", "b"], childIds: ["c"] },
      { ...unions[0], id: "marriage:second", marriageId: "second", marriageStatus: "active" as const, parentIds: ["a", "d"], childIds: ["e"] }
    ];
    const projection = new TreeProjectionService({ people, unions: remarriageUnions }).full("a", Number.POSITIVE_INFINITY);

    expect(projection.topology.nodes.filter((node) => node.kind === "person" && node.personId === "a")).toHaveLength(1);
    expect(projection.topology.edges.filter((edge) => edge.source === "person:a")).toHaveLength(2);
  });

  it("updates viewpoint labels without recomputing topology", () => {
    const service = new TreeProjectionService({ people, unions }, (viewpointId, targetId) => `${viewpointId}->${targetId}`);
    const fromA = service.full("a", Number.POSITIVE_INFINITY);
    const fromC = service.full("c", Number.POSITIVE_INFINITY);

    expect(fromC.topology).toBe(fromA.topology);
    expect(fromA.labels.c).toBe("a->c");
    expect(fromC.labels.c).toBe("c->c");
  });
});
