import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { calculateRelationship } from "../../../../src/main/domain/kinship/relationship-calculator";

const categoryCounts = {
  direct: 30,
  ancestorDescendant: 30,
  siblings: 24,
  paternalCollateral: 36,
  maternalCollateral: 36,
  cousins: 42,
  currentAffinity: 36,
  divorceRemarriage: 18,
  unknownAgeOrder: 18,
  unknownGender: 15,
  multiPath: 15
} as const;

const partialDateSchema = z.object({
  calendar: z.enum(["solar", "lunar"]),
  year: z.number().int(),
  month: z.number().int(),
  day: z.number().int().nullable(),
  leapMonth: z.boolean(),
  precision: z.enum(["month", "day"])
}).strict();

const personSchema = z.object({
  id: z.string().min(1),
  gender: z.enum(["male", "female", "unknown"]),
  birth: partialDateSchema.nullable(),
  conflictIds: z.array(z.string().min(1)).optional()
}).strict();

const parentChildSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1),
  childId: z.string().min(1),
  parentRole: z.enum(["father", "mother"]),
  conflictIds: z.array(z.string().min(1)).optional()
}).strict();

const marriageSchema = z.object({
  id: z.string().min(1),
  spouseAId: z.string().min(1),
  spouseBId: z.string().min(1),
  status: z.enum(["active", "divorced"]),
  conflictIds: z.array(z.string().min(1)).optional()
}).strict();

const expectedPathSchema = z.object({
  primaryTerm: z.string().nullable(),
  reverseTerm: z.string().nullable(),
  pathPersonIds: z.array(z.string().min(1)),
  pathRelationIds: z.array(z.string().min(1))
}).strict();

const expectedSchema = z.object({
  primaryTerm: z.string().nullable(),
  reverseTerm: z.string().nullable(),
  uncertainty: z.array(z.string()),
  pathPersonIds: z.array(z.string().min(1)),
  pathRelationIds: z.array(z.string().min(1)),
  alternatives: z.array(expectedPathSchema)
}).strict();

const completionFactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("personGender"),
    personId: z.string().min(1),
    value: z.enum(["male", "female"])
  }).strict(),
  z.object({
    kind: z.literal("personBirth"),
    personId: z.string().min(1),
    value: partialDateSchema
  }).strict(),
  z.object({ kind: z.literal("parentChild"), value: parentChildSchema }).strict(),
  z.object({ kind: z.literal("marriage"), value: marriageSchema }).strict()
]);

const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  category: z.enum(Object.keys(categoryCounts) as [keyof typeof categoryCounts, ...(keyof typeof categoryCounts)[]]),
  coverage: z.enum(["forward", "reverse", "missingInformation"]),
  people: z.array(personSchema).min(1),
  parentChild: z.array(parentChildSchema),
  marriages: z.array(marriageSchema),
  viewpoint: z.string().min(1),
  target: z.string().min(1),
  missingInformation: z.object({
    missingFact: z.string().min(1),
    conservativeResult: z.string().min(1),
    completion: z.object({
      fact: completionFactSchema,
      expected: expectedSchema
    }).strict()
  }).strict().optional(),
  expected: expectedSchema
}).strict().superRefine((testCase, context) => {
  if (testCase.coverage === "missingInformation" && !testCase.missingInformation) {
    context.addIssue({
      code: "custom",
      path: ["missingInformation"],
      message: "missing-information cases must name the missing fact and conservative result"
    });
  }
  if (testCase.coverage !== "missingInformation" && testCase.missingInformation) {
    context.addIssue({
      code: "custom",
      path: ["missingInformation"],
      message: "only missing-information cases may carry missing-information evidence"
    });
  }
});

const fixtureSchema = z.object({
  version: z.literal("kinship-golden-cases.v1"),
  ruleVersion: z.literal("mandarin-v1"),
  cases: z.array(caseSchema).length(300)
}).strict();

const fixturePath = resolve(process.cwd(), "tests/fixtures/kinship-golden-cases.v1.json");
const fixture = fixtureSchema.parse(JSON.parse(readFileSync(fixturePath, "utf8")));

type GoldenCase = z.infer<typeof caseSchema>;

interface CoreEdge {
  key: string;
  left: string;
  right: string;
  kind: "parentChild" | "marriage";
  parentId?: string;
  childId?: string;
  parentRole?: "father" | "mother";
  status?: "active" | "divorced";
}

function dateRange(date: GoldenCase["people"][number]["birth"]): { start: number; end: number } | null {
  if (!date || date.calendar !== "solar") return null;
  if (date.day !== null) {
    const instant = Date.UTC(date.year, date.month - 1, date.day);
    return { start: instant, end: instant };
  }
  return {
    start: Date.UTC(date.year, date.month - 1, 1),
    end: Date.UTC(date.year, date.month, 0)
  };
}

function semanticAgeOrder(
  left: GoldenCase["people"][number]["birth"],
  right: GoldenCase["people"][number]["birth"]
): "older" | "younger" | "equal" | "unknown" {
  const leftRange = dateRange(left);
  const rightRange = dateRange(right);
  if (!leftRange || !rightRange) return "unknown";
  if (leftRange.end < rightRange.start) return "older";
  if (leftRange.start > rightRange.end) return "younger";
  if (leftRange.start === rightRange.start && leftRange.end === rightRange.end) return "equal";
  return "unknown";
}

function selectedCorePaths(
  testCase: GoldenCase,
  allowBlockedFormerMarriage = false
): Array<{ people: string[]; edges: CoreEdge[] }> {
  const edges: CoreEdge[] = [
    ...testCase.parentChild.map((fact, index) => ({
      key: `p${index}`,
      left: fact.parentId,
      right: fact.childId,
      kind: "parentChild" as const,
      parentId: fact.parentId,
      childId: fact.childId,
      parentRole: fact.parentRole
    })),
    ...testCase.marriages.map((fact, index) => ({
      key: `m${index}`,
      left: fact.spouseAId,
      right: fact.spouseBId,
      kind: "marriage" as const,
      status: fact.status
    }))
  ];
  const adjacency = new Map<string, CoreEdge[]>();
  for (const edge of edges) {
    adjacency.set(edge.left, [...(adjacency.get(edge.left) ?? []), edge]);
    adjacency.set(edge.right, [...(adjacency.get(edge.right) ?? []), edge]);
  }
  const paths: Array<{ people: string[]; edges: CoreEdge[] }> = [];
  const visit = (personId: string, visitedPeople: Set<string>, path: CoreEdge[]): void => {
    if (paths.length > 10_000) throw new Error(`${testCase.id} exceeds the bounded core-path canonicalization limit`);
    if (personId === testCase.target) {
      paths.push({
        people: [...visitedPeople],
        edges: path
      });
      return;
    }
    for (const edge of adjacency.get(personId) ?? []) {
      const next = edge.left === personId ? edge.right : edge.left;
      if (visitedPeople.has(next)) continue;
      if (
        !allowBlockedFormerMarriage
        && edge.kind === "marriage"
        && edge.status === "divorced"
        && (path.length > 0 || next !== testCase.target)
      ) continue;
      visit(next, new Set([...visitedPeople, next]), [...path, edge]);
    }
  };
  visit(testCase.viewpoint, new Set([testCase.viewpoint]), []);
  if (paths.length === 0) return [];
  const shortestLength = Math.min(...paths.map((path) => path.edges.length));
  const shortest = paths.filter((path) => path.edges.length === shortestLength);
  const rank = (path: { edges: CoreEdge[] }): number => path.edges.length <= 1
    ? 0
    : path.edges.every((edge) => edge.kind === "parentChild") ? 1 : 2;
  const bestRank = Math.min(...shortest.map(rank));
  return shortest.filter((path) => rank(path) === bestRank);
}

function canonicalCaseKey(testCase: GoldenCase): string {
  const byId = new Map(testCase.people.map((person) => [person.id, person]));
  const describePerson = (id: string, pathPeople: readonly string[]) => {
      const person = byId.get(id)!;
      return {
        gender: person.gender,
        marriageStatuses: testCase.marriages
          .filter((fact) => fact.spouseAId === id || fact.spouseBId === id)
          .map((fact) => fact.status)
          .sort(),
        birth: person.birth ? {
          calendar: person.birth.calendar,
          precision: person.birth.precision,
          ...(person.birth.calendar === "lunar" ? { leapMonth: person.birth.leapMonth } : {}),
          relativeTo: pathPeople.map((otherId) => semanticAgeOrder(person.birth, byId.get(otherId)!.birth))
        } : null
      };
  };
  const validPaths = selectedCorePaths(testCase);
  const selectedPaths = validPaths.length > 0 ? validPaths : selectedCorePaths(testCase, true);
  if (selectedPaths.length === 0) {
    const endpoints = [testCase.viewpoint, testCase.target];
    return JSON.stringify({ noPath: endpoints.map((id) => describePerson(id, endpoints)) });
  }
  const descriptors = selectedPaths.map((path) => ({
    people: path.people.map((id) => describePerson(id, path.people)),
    relations: path.edges.map((edge, index) => edge.kind === "parentChild" ? {
      kind: edge.kind,
      direction: path.people[index] === edge.parentId ? "parentToChild" : "childToParent",
      parentRole: edge.parentRole
    } : {
      kind: edge.kind,
      status: edge.status
    })
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify(descriptors);
}

function applyCompletion(testCase: GoldenCase): GoldenCase {
  const completion = testCase.missingInformation?.completion;
  if (!completion) throw new Error(`${testCase.id} has no completed counterpart`);
  const completed = structuredClone(testCase);
  if (completion.fact.kind === "personGender") {
    const person = completed.people.find(({ id }) => id === completion.fact.personId);
    if (!person || person.gender !== "unknown") throw new Error(`${testCase.id} gender completion does not fill an unknown fact`);
    person.gender = completion.fact.value;
  } else if (completion.fact.kind === "personBirth") {
    const person = completed.people.find(({ id }) => id === completion.fact.personId);
    if (!person || (person.birth !== null && person.birth.calendar === "solar")) {
      throw new Error(`${testCase.id} birth completion does not fill an unreliable date fact`);
    }
    person.birth = completion.fact.value;
  } else if (completion.fact.kind === "parentChild") {
    completed.parentChild.push(completion.fact.value);
  } else {
    completed.marriages.push(completion.fact.value);
  }
  completed.expected = completion.expected;
  return completed;
}

describe("kinship golden matrix v1", () => {
  it("contains exactly the approved 300-case distribution with stable explicit records", () => {
    expect(fixture.cases).toHaveLength(300);
    expect(new Set(fixture.cases.map((testCase) => testCase.id)).size).toBe(300);
    const allPersonIds = fixture.cases.flatMap((testCase) => testCase.people.map((person) => person.id));
    const allRelationIds = fixture.cases.flatMap((testCase) => [
      ...testCase.parentChild.map((fact) => fact.id),
      ...testCase.marriages.map((fact) => fact.id)
    ]);
    expect(new Set(allPersonIds).size, "person IDs are globally stable and unique").toBe(allPersonIds.length);
    expect(new Set(allRelationIds).size, "relationship IDs are globally stable and unique").toBe(allRelationIds.length);
    expect(
      new Set(fixture.cases.map(canonicalCaseKey)).size,
      "input-only relationship core uniqueness"
    ).toBe(300);
    expect(
      fixture.cases.flatMap((testCase) => [
        ...testCase.people.flatMap((person) => person.conflictIds ?? []),
        ...testCase.parentChild.flatMap((fact) => fact.conflictIds ?? []),
        ...testCase.marriages.flatMap((fact) => fact.conflictIds ?? [])
      ])
    ).toEqual([]);
    expect(
      new Set(fixture.cases.map(canonicalCaseKey)).size,
      "all input-only relationship cores remain unique after ID/order/date-marker/conflict/oracle normalization"
    ).toBe(300);

    for (const [category, count] of Object.entries(categoryCounts)) {
      const cases = fixture.cases.filter((testCase) => testCase.category === category);
      expect(cases, category).toHaveLength(count);
      expect(new Set(cases.map((testCase) => testCase.coverage)), category).toEqual(
        new Set(["forward", "reverse", "missingInformation"])
      );
    }

    for (const testCase of fixture.cases.filter((entry) => entry.coverage === "missingInformation")) {
      expect(testCase.missingInformation?.missingFact, `${testCase.id}: missing fact`).toBeTruthy();
      expect(testCase.missingInformation?.conservativeResult, `${testCase.id}: conservative result`).toBeTruthy();
      expect(testCase.missingInformation?.completion, `${testCase.id}: static one-fact completed counterpart`).toBeDefined();
    }
    for (const testCase of fixture.cases) {
      const semanticEdges = [
        ...testCase.parentChild.map((fact) => `parentChild:${fact.parentId}:${fact.childId}:${fact.parentRole}`),
        ...testCase.marriages.map((fact) => `marriage:${[fact.spouseAId, fact.spouseBId].sort().join(":")}:${fact.status}`)
      ];
      expect(new Set(semanticEdges).size, `${testCase.id}: no duplicate relationship edges`).toBe(semanticEdges.length);
    }
  });

  it("normalizes IDs, array order, conflict salt, exact marker dates, distractors and expected output", () => {
    const original = fixture.cases[0]!;
    const renamed = structuredClone(original);
    const personIds = new Map(renamed.people.map((person, index) => [person.id, `renamed-person-${index}`]));
    const relationIds = new Map([
      ...renamed.parentChild.map((fact, index) => [fact.id, `renamed-parent-${index}`] as const),
      ...renamed.marriages.map((fact, index) => [fact.id, `renamed-marriage-${index}`] as const)
    ]);
    for (const person of renamed.people) {
      const oldId = person.id;
      person.id = personIds.get(oldId)!;
      person.conflictIds = ["irrelevant-conflict-salt"];
      if (person.birth) person.birth.year += 200;
    }
    for (const fact of renamed.parentChild) {
      fact.id = relationIds.get(fact.id)!;
      fact.parentId = personIds.get(fact.parentId)!;
      fact.childId = personIds.get(fact.childId)!;
      fact.conflictIds = ["irrelevant-conflict-salt"];
    }
    for (const fact of renamed.marriages) {
      fact.id = relationIds.get(fact.id)!;
      fact.spouseAId = personIds.get(fact.spouseAId)!;
      fact.spouseBId = personIds.get(fact.spouseBId)!;
      fact.conflictIds = ["irrelevant-conflict-salt"];
    }
    renamed.viewpoint = personIds.get(renamed.viewpoint)!;
    renamed.target = personIds.get(renamed.target)!;
    renamed.people.reverse();
    renamed.parentChild.reverse();
    renamed.marriages.reverse();
    renamed.expected = { ...renamed.expected, primaryTerm: "不得参与输入唯一性" };
    renamed.people.push({ id: "disconnected-a", gender: "female", birth: null });
    renamed.people.push({ id: "disconnected-b", gender: "male", birth: null });
    renamed.parentChild.push({
      id: "disconnected-relation",
      parentId: "disconnected-a",
      childId: "disconnected-b",
      parentRole: "mother"
    });

    expect(canonicalCaseKey(renamed)).toBe(canonicalCaseKey(original));
    renamed.people.find(({ id }) => id === personIds.get(original.target))!.gender = "female";
    expect(canonicalCaseKey(renamed)).not.toBe(canonicalCaseKey(original));
  });

  it("proves every missing-information oracle with an exact one-fact completed counterpart", () => {
    for (const testCase of fixture.cases.filter((entry) => entry.coverage === "missingInformation")) {
      const completed = applyCompletion(testCase);
      const completion = testCase.missingInformation!.completion!;
      const removedDocumentedUncertainty = testCase.expected.uncertainty.some(
        (uncertainty) => !completion.expected.uncertainty.includes(uncertainty)
      );
      const moreSpecificTerm = (
        completion.expected.primaryTerm !== null
          && completion.expected.primaryTerm !== testCase.expected.primaryTerm
      ) || (
        completion.expected.reverseTerm !== null
          && completion.expected.reverseTerm !== testCase.expected.reverseTerm
      );
      expect(
        removedDocumentedUncertainty || moreSpecificTerm,
        `${testCase.id}: completion must remove uncertainty or produce a more-specific term`
      ).toBe(true);

      const actual = calculateRelationship({
        people: completed.people,
        parentChild: completed.parentChild,
        marriages: completed.marriages
      }, completed.viewpoint, completed.target);
      expect({
        primaryTerm: actual.primaryTerm,
        reverseTerm: actual.reverseTerm,
        uncertainty: actual.uncertainty,
        pathPersonIds: actual.signature.pathPersonIds,
        pathRelationIds: actual.signature.pathRelationIds,
        alternatives: actual.alternatives.map((alternative) => ({
          primaryTerm: alternative.primaryTerm,
          reverseTerm: alternative.reverseTerm,
          pathPersonIds: alternative.signature.pathPersonIds,
          pathRelationIds: alternative.signature.pathRelationIds
        }))
      }, `${testCase.id}: separately reviewed completion oracle`).toEqual(completion.expected);
    }
  });

  it("keeps all facts and expected evidence internally referential", () => {
    for (const testCase of fixture.cases) {
      const personIds = new Set(testCase.people.map((person) => person.id));
      const relationIds = new Set([
        ...testCase.parentChild.map((fact) => fact.id),
        ...testCase.marriages.map((fact) => fact.id)
      ]);
      expect(personIds.has(testCase.viewpoint), `${testCase.id}: viewpoint`).toBe(true);
      expect(personIds.has(testCase.target), `${testCase.id}: target`).toBe(true);
      expect(new Set(testCase.people.map((person) => person.id)).size, `${testCase.id}: people`).toBe(testCase.people.length);
      expect(relationIds.size, `${testCase.id}: relations`).toBe(testCase.parentChild.length + testCase.marriages.length);
      for (const fact of testCase.parentChild) {
        expect(personIds.has(fact.parentId), `${testCase.id}: parent ${fact.id}`).toBe(true);
        expect(personIds.has(fact.childId), `${testCase.id}: child ${fact.id}`).toBe(true);
      }
      for (const fact of testCase.marriages) {
        expect(personIds.has(fact.spouseAId), `${testCase.id}: spouse A ${fact.id}`).toBe(true);
        expect(personIds.has(fact.spouseBId), `${testCase.id}: spouse B ${fact.id}`).toBe(true);
      }
      expect(testCase.expected.pathPersonIds.every((id) => personIds.has(id)), `${testCase.id}: path people`).toBe(true);
      expect(testCase.expected.pathRelationIds.every((id) => relationIds.has(id)), `${testCase.id}: path relations`).toBe(true);
      for (const alternative of testCase.expected.alternatives) {
        expect(alternative.pathPersonIds.every((id) => personIds.has(id)), `${testCase.id}: alternative people`).toBe(true);
        expect(alternative.pathRelationIds.every((id) => relationIds.has(id)), `${testCase.id}: alternative relations`).toBe(true);
      }
    }
  });

  it.each(fixture.cases)("resolves $id in both directions with exact uncertainty and paths", (testCase) => {
    const result = calculateRelationship({
      people: testCase.people,
      parentChild: testCase.parentChild,
      marriages: testCase.marriages
    }, testCase.viewpoint, testCase.target);

    expect(result.ruleVersion).toBe(fixture.ruleVersion);
    expect(result.primaryTerm).toBe(testCase.expected.primaryTerm);
    expect(result.reverseTerm).toBe(testCase.expected.reverseTerm);
    expect(result.uncertainty).toEqual(testCase.expected.uncertainty);
    expect(result.signature.pathPersonIds).toEqual(testCase.expected.pathPersonIds);
    expect(result.signature.pathRelationIds).toEqual(testCase.expected.pathRelationIds);
    expect(result.alternatives.map((alternative) => ({
      primaryTerm: alternative.primaryTerm,
      reverseTerm: alternative.reverseTerm,
      pathPersonIds: alternative.signature.pathPersonIds,
      pathRelationIds: alternative.signature.pathRelationIds
    }))).toEqual(testCase.expected.alternatives);
  });
});
