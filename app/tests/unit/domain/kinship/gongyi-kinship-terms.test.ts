import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RelationshipCalculator, calculateRelationship } from "../../../../src/main/domain/kinship/relationship-calculator.js";
import type { KinshipFactGraph } from "../../../../src/main/domain/kinship/types.js";

const facts = JSON.parse(readFileSync(
  resolve(process.cwd(), "tests/fixtures/gongyi-kinship-cases.v1.json"),
  "utf8"
)) as KinshipFactGraph;

describe("Gongyi kinship terms", () => {
  const calculator = new RelationshipCalculator(facts);

  it.each([
    ["older-sister", "姨祖母", "姨奶奶", "祖母的姐姐"],
    ["younger-sister", "姨祖母", "姨奶奶", "祖母的妹妹"],
    ["older-brother", "舅祖父", "舅爷", "祖母的哥哥"],
    ["younger-brother", "舅祖父", "舅爷", "祖母的弟弟"],
    ["brothers-daughter", "父亲的表姐妹", "表姑", "祖母的侄女"],
    ["sisters-daughters-husband", "父亲的表姐妹之夫", "表姑父", "祖母的外甥女的丈夫"]
  ])("uses the approved local term for %s", (targetId, formalTerm, regionalTerm, pathDescription) => {
    expect(calculator.calculateRelationship("viewpoint", targetId)).toMatchObject({
      primaryTerm: formalTerm,
      formalTerm,
      regionalTerm,
      displayTerm: regionalTerm,
      pathDescription,
      locale: "zh-CN-henan-gongyi",
      regionalRuleVersion: "zh-CN-henan-gongyi-v1"
    });
  });

  it("keeps a neutral sibling path when birth order is unavailable", () => {
    expect(calculator.calculateRelationship("viewpoint", "unknown-age-sister")).toMatchObject({
      formalTerm: "姨祖母",
      regionalTerm: "姨奶奶",
      displayTerm: "姨奶奶",
      pathDescription: "祖母的姐妹",
      signature: { steps: ["father", "mother", "sister"] }
    });
  });

  it("falls back to the formal term when the regional catalog has no override", () => {
    const result = calculator.calculateRelationship("viewpoint", "mother");
    expect(result).toMatchObject({
      primaryTerm: "母亲",
      formalTerm: "母亲",
      regionalTerm: null,
      displayTerm: "母亲",
      pathDescription: "母亲"
    });
  });

  it("returns no display label when the selected relationship path is conflicted", () => {
    const conflicted = calculateRelationship({
      people: [
        { id: "child", gender: "female", birth: null },
        { id: "father", gender: "male", birth: null }
      ],
      parentChild: [{
        id: "father-child",
        parentId: "father",
        childId: "child",
        parentRole: "father",
        conflictIds: ["conflict-1"]
      }],
      marriages: []
    }, "child", "father");

    expect(conflicted).toMatchObject({
      primaryTerm: null,
      formalTerm: null,
      regionalTerm: null,
      displayTerm: null
    });
  });

  it("keeps formal compatibility and returns the same structured batch label", () => {
    const result = calculator.calculateRelationship("viewpoint", "older-sister");

    expect(result.primaryTerm).toBe(result.formalTerm);
    expect(calculator.calculatePrimaryTerms("viewpoint", ["older-sister"]).get("older-sister")).toBe(result.formalTerm);
    expect(calculator.calculatePrimaryLabels("viewpoint", ["older-sister"]).get("older-sister")).toMatchObject({
      formalTerm: "姨祖母",
      regionalTerm: "姨奶奶",
      displayTerm: "姨奶奶",
      pathDescription: "祖母的姐姐"
    });
  });
});
