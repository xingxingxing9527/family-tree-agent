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

const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  category: z.enum(Object.keys(categoryCounts) as [keyof typeof categoryCounts, ...(keyof typeof categoryCounts)[]]),
  coverage: z.enum(["forward", "reverse", "missingInformation"]),
  people: z.array(personSchema).min(1),
  parentChild: z.array(parentChildSchema),
  marriages: z.array(marriageSchema),
  viewpoint: z.string().min(1),
  target: z.string().min(1),
  expected: z.object({
    primaryTerm: z.string().nullable(),
    reverseTerm: z.string().nullable(),
    uncertainty: z.array(z.string()),
    pathPersonIds: z.array(z.string().min(1)),
    pathRelationIds: z.array(z.string().min(1)),
    alternatives: z.array(expectedPathSchema)
  }).strict()
}).strict();

const fixtureSchema = z.object({
  version: z.literal("kinship-golden-cases.v1"),
  ruleVersion: z.literal("mandarin-v1"),
  cases: z.array(caseSchema).length(300)
}).strict();

const fixturePath = resolve(process.cwd(), "tests/fixtures/kinship-golden-cases.v1.json");
const fixture = fixtureSchema.parse(JSON.parse(readFileSync(fixturePath, "utf8")));

function canonicalCaseKey(testCase: z.infer<typeof caseSchema>): string {
  const people = new Map(testCase.people.map((entry, index) => [entry.id, `person-${index}`]));
  const relations = new Map([
    ...testCase.parentChild.map((entry, index) => [entry.id, `parent-child-${index}`] as const),
    ...testCase.marriages.map((entry, index) => [entry.id, `marriage-${index}`] as const)
  ]);
  return JSON.stringify({
    people: testCase.people.map(({ id: _id, ...entry }) => entry),
    parentChild: testCase.parentChild.map(({ id: _id, parentId, childId, ...entry }) => ({
      ...entry,
      parentId: people.get(parentId),
      childId: people.get(childId)
    })),
    marriages: testCase.marriages.map(({ id: _id, spouseAId, spouseBId, ...entry }) => ({
      ...entry,
      spouseAId: people.get(spouseAId),
      spouseBId: people.get(spouseBId)
    })),
    viewpoint: people.get(testCase.viewpoint),
    target: people.get(testCase.target),
    expected: {
      ...testCase.expected,
      pathPersonIds: testCase.expected.pathPersonIds.map((id) => people.get(id)),
      pathRelationIds: testCase.expected.pathRelationIds.map((id) => relations.get(id)),
      alternatives: testCase.expected.alternatives.map((alternative) => ({
        ...alternative,
        pathPersonIds: alternative.pathPersonIds.map((id) => people.get(id)),
        pathRelationIds: alternative.pathRelationIds.map((id) => relations.get(id))
      }))
    }
  });
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
    expect(new Set(fixture.cases.map(canonicalCaseKey)).size, "the matrix contains no cloned records").toBe(300);

    for (const [category, count] of Object.entries(categoryCounts)) {
      const cases = fixture.cases.filter((testCase) => testCase.category === category);
      expect(cases, category).toHaveLength(count);
      expect(new Set(cases.map((testCase) => testCase.coverage)), category).toEqual(
        new Set(["forward", "reverse", "missingInformation"])
      );
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
