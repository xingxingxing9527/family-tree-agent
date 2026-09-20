import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { calculateRelationship } from "../../../../src/main/domain/kinship/relationship-calculator";
import { loadKinshipRuleCatalog } from "../../../../src/main/domain/kinship/rule-loader";
import type {
  KinshipFactGraph,
  KinshipPerson,
  ParentChildFact,
  MarriageFact
} from "../../../../src/main/domain/kinship/types";

const solar = (year: number, month = 1, day: number | null = 1) => ({
  calendar: "solar" as const,
  year,
  month,
  day,
  leapMonth: false,
  precision: day === null ? "month" as const : "day" as const
});

const lunar = (year: number, month = 1, day: number | null = 1) => ({
  calendar: "lunar" as const,
  year,
  month,
  day,
  leapMonth: false,
  precision: day === null ? "month" as const : "day" as const
});

const person = (
  id: string,
  gender: KinshipPerson["gender"] = "unknown",
  birth: KinshipPerson["birth"] = null,
  conflictIds?: string[]
): KinshipPerson => ({ id, gender, birth, ...(conflictIds ? { conflictIds } : {}) });

const graph = (
  people: KinshipPerson[],
  parentChild: ParentChildFact[] = [],
  marriages: MarriageFact[] = []
): KinshipFactGraph => ({ people, parentChild, marriages });

describe("calculateRelationship", () => {
  it("loads the versioned catalog independently of the process working directory", () => {
    const originalDirectory = process.cwd();
    const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "kinship-catalog-cwd-"));
    try {
      process.chdir(temporaryDirectory);
      expect(loadKinshipRuleCatalog().version).toBe("mandarin-v1");
    } finally {
      process.chdir(originalDirectory);
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("uses the versioned direct-father rule and reverses it by viewpoint gender", () => {
    const result = calculateRelationship(graph(
      [person("child", "male"), person("father", "male")],
      [{ id: "father-child", parentId: "father", childId: "child", parentRole: "father" }]
    ), "child", "father");

    expect(result).toMatchObject({
      primaryTerm: "父亲",
      reverseTerm: "儿子",
      ruleVersion: "mandarin-v1",
      signature: {
        steps: ["father"],
        generationDelta: -1,
        lineageSide: "paternal",
        bloodAffinity: "blood",
        pathPersonIds: ["child", "father"],
        pathRelationIds: ["father-child"]
      }
    });
  });

  it("uses an age-neutral sibling term when birth data is missing", () => {
    const result = calculateRelationship(graph(
      [person("source", "male"), person("parent", "male"), person("brother", "male")],
      [
        { id: "parent-source", parentId: "parent", childId: "source", parentRole: "father" },
        { id: "parent-brother", parentId: "parent", childId: "brother", parentRole: "father" }
      ]
    ), "source", "brother");

    expect(result.primaryTerm).toBe("兄弟");
    expect(result.reverseTerm).toBe("兄弟");
    expect(result.signature.steps).toEqual(["brother"]);
    expect(result.signature.relativeAgeOrder).toBe("unknown");
    expect(result.uncertainty).toContain("缺少可靠出生日期，未推断长幼顺序");
    expect(result.primaryTerm).not.toBe("哥哥");
    expect(result.primaryTerm).not.toBe("弟弟");
  });

  it("derives older and reverse-younger sibling terms from non-overlapping solar ranges", () => {
    const result = calculateRelationship(graph(
      [person("source", "male", solar(2000)), person("parent"), person("brother", "male", solar(1990))],
      [
        { id: "parent-source", parentId: "parent", childId: "source", parentRole: "father" },
        { id: "parent-brother", parentId: "parent", childId: "brother", parentRole: "father" }
      ]
    ), "source", "brother");

    expect(result.primaryTerm).toBe("哥哥");
    expect(result.reverseTerm).toBe("弟弟");
    expect(result.signature.steps).toEqual(["olderBrother"]);
    expect(result.signature.relativeAgeOrder).toBe("older");
  });

  it.each([
    ["unconverted lunar dates", lunar(1990), lunar(2000)],
    ["overlapping solar month ranges", solar(2000, 3, null), solar(2000, 3, null)]
  ])("does not invent sibling age order from %s", (_label, sourceBirth, targetBirth) => {
    const result = calculateRelationship(graph(
      [person("source", "female", sourceBirth), person("parent"), person("sister", "female", targetBirth)],
      [
        { id: "parent-source", parentId: "parent", childId: "source", parentRole: "mother" },
        { id: "parent-sister", parentId: "parent", childId: "sister", parentRole: "mother" }
      ]
    ), "source", "sister");

    expect(result.primaryTerm).toBe("姐妹");
    expect(result.signature.steps).toEqual(["sister"]);
    expect(result.signature.relativeAgeOrder).toBe("unknown");
  });

  it("uses an active spouse path for direct current in-laws", () => {
    const result = calculateRelationship(graph(
      [person("source", "female"), person("husband", "male"), person("father", "male")],
      [{ id: "father-husband", parentId: "father", childId: "husband", parentRole: "father" }],
      [{ id: "marriage", spouseAId: "source", spouseBId: "husband", status: "active" }]
    ), "source", "father");

    expect(result.primaryTerm).toBe("公公");
    expect(result.signature.steps).toEqual(["husband", "father"]);
    expect(result.signature.bloodAffinity).toBe("currentAffinity");
    expect(result.signature.pathRelationIds).toEqual(["marriage", "father-husband"]);
  });

  it("describes a former spouse only at the divorced edge endpoints", () => {
    const facts = graph(
      [person("source", "female"), person("former", "male"), person("child", "male")],
      [{ id: "former-child", parentId: "former", childId: "child", parentRole: "father" }],
      [{ id: "divorce", spouseAId: "source", spouseBId: "former", status: "divorced" }]
    );

    const former = calculateRelationship(facts, "source", "former");
    const blockedTraversal = calculateRelationship(facts, "source", "child");

    expect(former.primaryTerm).toBe("前夫");
    expect(former.signature.steps).toEqual(["formerHusband"]);
    expect(former.signature.bloodAffinity).toBe("directFormerSpouse");
    expect(blockedTraversal.primaryTerm).toBeNull();
    expect(blockedTraversal.description).toBe("未找到从 source 到 child 的可用关系路径");
  });

  it("returns no term and identifies every conflict carried by the selected path", () => {
    const result = calculateRelationship(graph(
      [person("child", "unknown", null, ["conflict-person"]), person("parent", "male")],
      [{
        id: "parent-child",
        parentId: "parent",
        childId: "child",
        parentRole: "father",
        conflictIds: ["conflict-role"]
      }]
    ), "child", "parent");

    expect(result.primaryTerm).toBeNull();
    expect(result.reverseTerm).toBeNull();
    expect(result.description).toContain("conflict-person");
    expect(result.description).toContain("conflict-role");
    expect(result.uncertainty).toEqual([
      "数据冲突：conflict-person",
      "数据冲突：conflict-role"
    ]);
  });

  it("keeps all equally ranked factual paths as deterministic alternatives", () => {
    const result = calculateRelationship(graph(
      [person("source", "male"), person("father"), person("mother"), person("target", "male")],
      [
        { id: "f-source", parentId: "father", childId: "source", parentRole: "father" },
        { id: "f-target", parentId: "father", childId: "target", parentRole: "father" },
        { id: "m-source", parentId: "mother", childId: "source", parentRole: "mother" },
        { id: "m-target", parentId: "mother", childId: "target", parentRole: "mother" }
      ]
    ), "source", "target");

    expect(result.signature.pathRelationIds).toEqual(["f-source", "f-target"]);
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives[0]?.signature.pathRelationIds).toEqual(["m-source", "m-target"]);
    expect(result.alternatives[0]?.primaryTerm).toBe(result.primaryTerm);
  });

  it("withholds a term when any equally ranked factual path carries a conflict", () => {
    const result = calculateRelationship(graph(
      [person("source", "male"), person("father"), person("mother"), person("target", "male")],
      [
        { id: "f-source", parentId: "father", childId: "source", parentRole: "father" },
        { id: "f-target", parentId: "father", childId: "target", parentRole: "father" },
        { id: "m-source", parentId: "mother", childId: "source", parentRole: "mother", conflictIds: ["conflict-mother"] },
        { id: "m-target", parentId: "mother", childId: "target", parentRole: "mother" }
      ]
    ), "source", "target");

    expect(result.primaryTerm).toBeNull();
    expect(result.reverseTerm).toBeNull();
    expect(result.description).toContain("conflict-mother");
    expect(result.uncertainty).toContain("数据冲突：conflict-mother");
  });

  it("returns an exact path description and coverage marker for an unmatched signature", () => {
    const result = calculateRelationship(graph(
      [person("source"), person("parent"), person("grandparent"), person("great-grandparent")],
      [
        { id: "r1", parentId: "parent", childId: "source", parentRole: "father" },
        { id: "r2", parentId: "grandparent", childId: "parent", parentRole: "father" },
        { id: "r3", parentId: "great-grandparent", childId: "grandparent", parentRole: "father" }
      ]
    ), "source", "great-grandparent");

    expect(result.primaryTerm).toBeNull();
    expect(result.reverseTerm).toBeNull();
    expect(result.description).toBe(
      "关系路径：source -[father:r1]-> parent -[father:r2]-> grandparent -[father:r3]-> great-grandparent；称谓规则尚未覆盖"
    );
    expect(result.uncertainty).toContain("称谓规则尚未覆盖");
  });
});

interface FixtureCase {
  id: string;
  people: KinshipPerson[];
  parentChild: ParentChildFact[];
  marriages: MarriageFact[];
  viewpoint: string;
  target: string;
  expectedForward: string | null;
  expectedReverse: string | null;
  expectedPathPersonIds: string[];
  expectedPathRelationIds: string[];
}

describe("kinship core cases v1", () => {
  const fixturePath = resolve(process.cwd(), "tests/fixtures/kinship-core-cases.v1.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    version: string;
    cases: FixtureCase[];
  };

  it("contains at least sixty explicit, versioned graph cases", () => {
    expect(fixture.version).toBe("kinship-core-cases.v1");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(60);
    for (const testCase of fixture.cases) {
      expect(testCase.people.length).toBeGreaterThan(0);
      expect(testCase.parentChild).toBeDefined();
      expect(testCase.marriages).toBeDefined();
    }
  });

  it.each(fixture.cases)("resolves $id with rule version and actual path evidence", (testCase) => {
    const result = calculateRelationship({
      people: testCase.people,
      parentChild: testCase.parentChild,
      marriages: testCase.marriages
    }, testCase.viewpoint, testCase.target);

    expect(result.primaryTerm).toBe(testCase.expectedForward);
    expect(result.reverseTerm).toBe(testCase.expectedReverse);
    expect(result.ruleVersion).toBe("mandarin-v1");
    expect(result.signature.pathPersonIds).toEqual(testCase.expectedPathPersonIds);
    expect(result.signature.pathRelationIds).toEqual(testCase.expectedPathRelationIds);
  });
});
