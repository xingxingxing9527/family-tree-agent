import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { calculateRelationship, RelationshipCalculator } from "../../../../src/main/domain/kinship/relationship-calculator";
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

  it("loads the catalog from Electron's packaged resources path and packages only explicit kinship catalogs", () => {
    const originalResourcesPath = process.resourcesPath;
    const packagedResourcesPath = mkdtempSync(resolve(tmpdir(), "kinship-packaged-resources-"));
    const catalogPath = join(packagedResourcesPath, "kinship-rules", "mandarin-v1.json");
    try {
      mkdirSync(join(packagedResourcesPath, "kinship-rules"));
      writeFileSync(catalogPath, JSON.stringify({ version: "packaged-mandarin-v1", rules: [] }));
      Object.defineProperty(process, "resourcesPath", { configurable: true, value: packagedResourcesPath });

      expect(loadKinshipRuleCatalog().version).toBe("packaged-mandarin-v1");

      const builderConfig = readFileSync(resolve(process.cwd(), "electron-builder.yml"), "utf8");
      expect(builderConfig).toMatch(/extraResources:\s*\r?\n\s+- from: resources\/kinship-rules\/mandarin-v1\.json\r?\n\s+to: kinship-rules\/mandarin-v1\.json/);
      expect(builderConfig).toMatch(/from: resources\/kinship-locales\/zh-CN-henan-gongyi-v1\.json\r?\n\s+to: kinship-locales\/zh-CN-henan-gongyi-v1\.json/);
      expect(builderConfig).not.toMatch(/from: resources\/kinship-rules\/\*\*/);
      expect(builderConfig).not.toMatch(/from: resources\/kinship-locales\/\*\*/);
    } finally {
      Object.defineProperty(process, "resourcesPath", { configurable: true, value: originalResourcesPath });
      rmSync(packagedResourcesPath, { recursive: true, force: true });
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

  it("treats siblings born on the same exact solar date as age-uncertain", () => {
    const result = calculateRelationship(graph(
      [person("source", "female", solar(2000, 3, 1)), person("parent"), person("sister", "female", solar(2000, 3, 1))],
      [
        { id: "parent-source", parentId: "parent", childId: "source", parentRole: "mother" },
        { id: "parent-sister", parentId: "parent", childId: "sister", parentRole: "mother" }
      ]
    ), "source", "sister");

    expect(result.primaryTerm).toBe("姐妹");
    expect(result.reverseTerm).toBe("姐妹");
    expect(result.signature.steps).toEqual(["sister"]);
    expect(result.signature.relativeAgeOrder).toBe("unknown");
    expect(result.uncertainty).toContain("缺少可靠出生日期，未推断长幼顺序");
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

  it("uses precise terms for a spouse's siblings when gender and age are known", () => {
    const husbandSibling = calculateRelationship(graph(
      [
        person("wife", "female", solar(1993)),
        person("husband", "male", solar(1992)),
        person("husbands-mother", "female"),
        person("younger-sister", "female", solar(2006))
      ],
      [
        { id: "mother-husband", parentId: "husbands-mother", childId: "husband", parentRole: "mother" },
        { id: "mother-sister", parentId: "husbands-mother", childId: "younger-sister", parentRole: "mother" }
      ],
      [{ id: "wife-husband", spouseAId: "wife", spouseBId: "husband", status: "active" }]
    ), "wife", "younger-sister");
    const wifeSibling = calculateRelationship(graph(
      [
        person("husband", "male", solar(1992)),
        person("wife", "female", solar(1993)),
        person("wifes-mother", "female"),
        person("older-brother", "male", solar(1988))
      ],
      [
        { id: "mother-wife", parentId: "wifes-mother", childId: "wife", parentRole: "mother" },
        { id: "mother-brother", parentId: "wifes-mother", childId: "older-brother", parentRole: "mother" }
      ],
      [{ id: "husband-wife", spouseAId: "husband", spouseBId: "wife", status: "active" }]
    ), "husband", "older-brother");

    expect(husbandSibling).toMatchObject({
      primaryTerm: "小姑子",
      signature: { steps: ["husband", "youngerSister"] },
      uncertainty: []
    });
    expect(wifeSibling).toMatchObject({
      primaryTerm: "大舅子",
      signature: { steps: ["wife", "olderBrother"] },
      uncertainty: []
    });
  });

  it("labels the selected viewpoint as 本人", () => {
    const facts = graph([person("source", "female", solar(2010))]);
    const calculator = new RelationshipCalculator(facts);

    expect(calculateRelationship(facts, "source", "source")).toMatchObject({
      primaryTerm: "本人",
      reverseTerm: "本人",
      uncertainty: []
    });
    expect(calculator.calculatePrimaryTerms("source", ["source"]).get("source")).toBe("本人");
  });

  it("resolves common three-generation paternal kinship terms", () => {
    const facts = graph(
      [
        person("source", "female", solar(2010)),
        person("father", "male", solar(1980)),
        person("grandfather", "male", solar(1950)),
        person("great-grandfather", "male", solar(1920)),
        person("great-grandmother", "female", solar(1922)),
        person("great-uncle", "male", solar(1955)),
        person("great-uncle-wife", "female", solar(1956)),
        person("great-aunt", "female", solar(1948)),
        person("great-aunt-husband", "male", solar(1947)),
        person("fathers-cousin", "female", solar(1982))
      ],
      [
        { id: "father-source", parentId: "father", childId: "source", parentRole: "father" },
        { id: "grandfather-father", parentId: "grandfather", childId: "father", parentRole: "father" },
        { id: "great-grandfather-grandfather", parentId: "great-grandfather", childId: "grandfather", parentRole: "father" },
        { id: "great-grandmother-grandfather", parentId: "great-grandmother", childId: "grandfather", parentRole: "mother" },
        { id: "great-grandfather-uncle", parentId: "great-grandfather", childId: "great-uncle", parentRole: "father" },
        { id: "great-grandmother-uncle", parentId: "great-grandmother", childId: "great-uncle", parentRole: "mother" },
        { id: "great-grandfather-aunt", parentId: "great-grandfather", childId: "great-aunt", parentRole: "father" },
        { id: "great-grandmother-aunt", parentId: "great-grandmother", childId: "great-aunt", parentRole: "mother" },
        { id: "great-aunt-cousin", parentId: "great-aunt", childId: "fathers-cousin", parentRole: "mother" }
      ],
      [
        { id: "great-uncle-marriage", spouseAId: "great-uncle", spouseBId: "great-uncle-wife", status: "active" },
        { id: "great-aunt-marriage", spouseAId: "great-aunt", spouseBId: "great-aunt-husband", status: "active" }
      ]
    );
    const calculator = new RelationshipCalculator(facts);

    expect(Object.fromEntries(calculator.calculatePrimaryTerms("source", [
      "great-grandfather",
      "great-grandmother",
      "great-uncle",
      "great-uncle-wife",
      "great-aunt",
      "great-aunt-husband",
      "fathers-cousin"
    ]))).toEqual({
      "great-grandfather": "曾祖父",
      "great-grandmother": "曾祖母",
      "great-uncle": "叔祖父",
      "great-uncle-wife": "伯叔祖母",
      "great-aunt": "姑祖母",
      "great-aunt-husband": "姑祖父",
      "fathers-cousin": "表姑"
    });
  });

  it("composes a readable label for an otherwise uncovered spouse-relative chain", () => {
    const facts = graph(
      [
        person("source", "female", solar(1993)),
        person("husband", "male", solar(1992)),
        person("mother", "female", solar(1967)),
        person("grandmother", "female"),
        person("uncle", "male", solar(1970)),
        person("cousin", "female", solar(1993))
      ],
      [
        { id: "mother-husband", parentId: "mother", childId: "husband", parentRole: "mother" },
        { id: "grandmother-mother", parentId: "grandmother", childId: "mother", parentRole: "mother" },
        { id: "grandmother-uncle", parentId: "grandmother", childId: "uncle", parentRole: "mother" },
        { id: "uncle-cousin", parentId: "uncle", childId: "cousin", parentRole: "father" }
      ],
      [{ id: "source-husband", spouseAId: "source", spouseBId: "husband", status: "active" }]
    );

    const result = calculateRelationship(facts, "source", "cousin");
    const treeLabels = new RelationshipCalculator(facts).calculatePrimaryTerms("source", ["cousin"]);

    expect(result).toMatchObject({
      primaryTerm: "丈夫的表妹",
      signature: { steps: ["husband", "mother", "brother", "daughter"] }
    });
    expect(result.uncertainty).toContain("未匹配精确称谓，已使用组合式称谓");
    expect(result.description).toContain("未匹配精确称谓，已使用组合式称谓");
    expect(treeLabels.get("cousin")).toBe("丈夫的表妹");
  });

  it("uses a precise blood-relative spouse term inside a composed spouse-side label", () => {
    const result = calculateRelationship(graph(
      [
        person("source", "female"),
        person("husband", "male"),
        person("mother", "female"),
        person("grandmother", "female"),
        person("uncle", "male"),
        person("uncle-wife", "female")
      ],
      [
        { id: "mother-husband", parentId: "mother", childId: "husband", parentRole: "mother" },
        { id: "grandmother-mother", parentId: "grandmother", childId: "mother", parentRole: "mother" },
        { id: "grandmother-uncle", parentId: "grandmother", childId: "uncle", parentRole: "mother" }
      ],
      [
        { id: "source-husband", spouseAId: "source", spouseBId: "husband", status: "active" },
        { id: "uncle-marriage", spouseAId: "uncle", spouseBId: "uncle-wife", status: "active" }
      ]
    ), "source", "uncle-wife");

    expect(result.primaryTerm).toBe("丈夫的舅妈");
    expect(result.uncertainty).toContain("未匹配精确称谓，已使用组合式称谓");
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

  it("bulk-resolves tree labels with the same primary terms and conservative conflict handling", () => {
    const facts = graph(
      [person("source", "male"), person("father", "male"), person("mother", "female"), person("brother", "male"), person("unrelated")],
      [
        { id: "f-source", parentId: "father", childId: "source", parentRole: "father" },
        { id: "f-brother", parentId: "father", childId: "brother", parentRole: "father" },
        { id: "m-source", parentId: "mother", childId: "source", parentRole: "mother", conflictIds: ["conflicting-maternal-path"] },
        { id: "m-brother", parentId: "mother", childId: "brother", parentRole: "mother" }
      ]
    );
    const calculator = new RelationshipCalculator(facts);

    const labels = calculator.calculatePrimaryTerms("source", ["source", "father", "brother", "unrelated"]);

    expect(Object.fromEntries(labels)).toEqual({
      source: calculateRelationship(facts, "source", "source").primaryTerm,
      father: calculateRelationship(facts, "source", "father").primaryTerm,
      brother: null,
      unrelated: null
    });
  });

  it("keeps a lower-ranked prefix when a marriage suffix makes both shortest paths equally ranked", () => {
    const facts = graph(
      [
        person("s", "male", solar(2000)),
        person("a", "male"),
        person("b", "female"),
        person("v", "male", solar(1990)),
        person("t", "female")
      ],
      [
        { id: "p1", parentId: "a", childId: "s", parentRole: "father" },
        { id: "p2", parentId: "a", childId: "v", parentRole: "father" },
        { id: "p3", parentId: "b", childId: "v", parentRole: "mother" }
      ],
      [
        {
          id: "m1",
          spouseAId: "s",
          spouseBId: "b",
          status: "active",
          conflictIds: ["conflict-affinity-prefix"]
        },
        { id: "m2", spouseAId: "v", spouseBId: "t", status: "active" }
      ]
    );
    const calculator = new RelationshipCalculator(facts);

    const authoritative = calculator.calculateRelationship("s", "t");
    const bulk = calculator.calculatePrimaryTerms("s", ["t"]);

    expect(authoritative).toMatchObject({
      primaryTerm: null,
      uncertainty: ["数据冲突：conflict-affinity-prefix"],
      signature: { pathRelationIds: ["m1", "p3", "m2"] }
    });
    expect(authoritative.alternatives.map((entry) => entry.signature.pathRelationIds)).toEqual([
      ["p1", "p2", "m2"]
    ]);
    expect(bulk.get("t")).toBeNull();
  });

  it("matches authoritative per-target primary terms across generated multipath graphs and fresh snapshots", () => {
    let state = 0x20260916;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };

    for (let graphIndex = 0; graphIndex < 80; graphIndex += 1) {
      const people = Array.from({ length: 9 }, (_, personIndex) => person(
        `g${graphIndex}-p${personIndex}`,
        (["male", "female", "unknown"] as const)[Math.floor(random() * 3)]!,
        personIndex < 3 ? solar(1970 + personIndex * 12 + (graphIndex % 5)) : null,
        random() < 0.08 ? [`person-conflict-${graphIndex}-${personIndex}`] : undefined
      ));
      const parentChild: ParentChildFact[] = [];
      const marriages: MarriageFact[] = [];

      for (let childIndex = 1; childIndex < people.length; childIndex += 1) {
        const parentIndex = Math.floor(random() * childIndex);
        parentChild.push({
          id: `g${graphIndex}-tree-${childIndex}`,
          parentId: people[parentIndex]!.id,
          childId: people[childIndex]!.id,
          parentRole: random() < 0.5 ? "father" : "mother",
          ...(random() < 0.08 ? { conflictIds: [`edge-conflict-${graphIndex}-${childIndex}`] } : {})
        });
      }
      for (let extraIndex = 0; extraIndex < 5; extraIndex += 1) {
        const left = Math.floor(random() * people.length);
        let right = Math.floor(random() * people.length);
        if (right === left) right = (right + 1) % people.length;
        if (random() < 0.55) {
          parentChild.push({
            id: `g${graphIndex}-extra-parent-${extraIndex}`,
            parentId: people[Math.min(left, right)]!.id,
            childId: people[Math.max(left, right)]!.id,
            parentRole: random() < 0.5 ? "father" : "mother",
            ...(random() < 0.12 ? { conflictIds: [`extra-conflict-${graphIndex}-${extraIndex}`] } : {})
          });
        } else {
          marriages.push({
            id: `g${graphIndex}-marriage-${extraIndex}`,
            spouseAId: people[left]!.id,
            spouseBId: people[right]!.id,
            status: random() < 0.8 ? "active" : "divorced",
            ...(random() < 0.12 ? { conflictIds: [`marriage-conflict-${graphIndex}-${extraIndex}`] } : {})
          });
        }
      }

      const snapshot = graph(people, parentChild, marriages);
      const sourceId = people[Math.floor(random() * people.length)]!.id;
      const targets = people.map((entry) => entry.id);
      const calculator = new RelationshipCalculator(snapshot);
      const actual = calculator.calculatePrimaryTerms(sourceId, targets);

      for (const targetId of targets) {
        expect(actual.get(targetId), `${graphIndex}:${sourceId}->${targetId}`).toBe(
          calculator.calculateRelationship(sourceId, targetId).primaryTerm
        );
      }

      const freshSnapshot = graph(
        people.map((entry) => ({ ...entry, conflictIds: undefined })),
        parentChild.slice(0, Math.max(1, parentChild.length - 2)),
        marriages.filter((entry) => entry.status === "active")
      );
      const freshCalculator = new RelationshipCalculator(freshSnapshot);
      const freshActual = freshCalculator.calculatePrimaryTerms(sourceId, targets);
      for (const targetId of targets) {
        expect(freshActual.get(targetId), `fresh:${graphIndex}:${sourceId}->${targetId}`).toBe(
          freshCalculator.calculateRelationship(sourceId, targetId).primaryTerm
        );
      }
    }
  });

  it("keeps each cached calculator isolated from later mutations to its input fact snapshot", () => {
    const source = person("source", "male");
    const facts = graph(
      [source, person("father", "male")],
      [{ id: "father-source", parentId: "father", childId: "source", parentRole: "father" }]
    );
    const cached = new RelationshipCalculator(facts);

    source.gender = "female";
    facts.parentChild.length = 0;

    expect(cached.calculateRelationship("source", "father")).toMatchObject({
      primaryTerm: "父亲",
      reverseTerm: "儿子"
    });
    expect(new RelationshipCalculator(facts).calculateRelationship("source", "father").primaryTerm).toBeNull();
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

  it("composes a readable term for a connected blood-relative path without a precise rule", () => {
    const result = calculateRelationship(graph(
      [
        person("source", "female"),
        person("parent"),
        person("grandparent"),
        person("great-grandparent"),
        person("great-great-grandparent")
      ],
      [
        { id: "r1", parentId: "parent", childId: "source", parentRole: "father" },
        { id: "r2", parentId: "grandparent", childId: "parent", parentRole: "father" },
        { id: "r3", parentId: "great-grandparent", childId: "grandparent", parentRole: "father" },
        { id: "r4", parentId: "great-great-grandparent", childId: "great-grandparent", parentRole: "father" }
      ]
    ), "source", "great-great-grandparent");

    expect(result.primaryTerm).toBe("曾祖父的父亲");
    expect(result.description).toBe(
      "关系路径：source -[father:r1]-> parent -[father:r2]-> grandparent -[father:r3]-> great-grandparent -[father:r4]-> great-great-grandparent；未匹配精确称谓，已使用组合式称谓"
    );
    expect(result.uncertainty).toContain("未匹配精确称谓，已使用组合式称谓");
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
