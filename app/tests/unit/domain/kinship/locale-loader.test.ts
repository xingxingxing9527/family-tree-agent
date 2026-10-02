import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadKinshipLocaleCatalog,
  matchKinshipLocaleTerm,
  parseKinshipLocaleCatalog
} from "../../../../src/main/domain/kinship/locale-loader.js";
import type { KinshipRuleCatalog } from "../../../../src/main/domain/kinship/rule-loader.js";

const formalCatalog: KinshipRuleCatalog = {
  version: "mandarin-v1",
  rules: [{ id: "direct-father", pattern: { steps: ["father"] }, forward: "父亲", reverse: "子女" }]
};

const validCatalog = {
  locale: "zh-CN-henan-gongyi",
  version: "zh-CN-henan-gongyi-v1",
  formalCatalogVersion: "mandarin-v1",
  terms: [{ ruleId: "direct-father", term: "爸" }]
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("kinship locale catalog", () => {
  it("parses a valid sparse regional override catalog", () => {
    expect(parseKinshipLocaleCatalog(validCatalog, formalCatalog)).toEqual(validCatalog);
  });

  it.each([
    ["empty locale", { ...validCatalog, locale: "" }, /locale/i],
    ["empty version", { ...validCatalog, version: "" }, /version/i],
    ["formal catalog version mismatch", { ...validCatalog, formalCatalogVersion: "mandarin-v2" }, /formal catalog version/i],
    ["duplicate rule", { ...validCatalog, terms: [...validCatalog.terms, ...validCatalog.terms] }, /duplicate/i],
    ["blank term", { ...validCatalog, terms: [{ ruleId: "direct-father", term: "  " }] }, /term/i],
    ["unknown formal rule", { ...validCatalog, terms: [{ ruleId: "missing-rule", term: "称呼" }] }, /unknown formal rule/i]
  ])("rejects %s", (_label, candidate, message) => {
    expect(() => parseKinshipLocaleCatalog(candidate, formalCatalog)).toThrow(message);
  });

  it("loads UTF-8 Chinese terms from a file and matches them without fallback guessing", () => {
    const directory = mkdtempSync(join(tmpdir(), "kinship-locale-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "gongyi.json");
    writeFileSync(path, JSON.stringify(validCatalog), "utf8");

    const catalog = loadKinshipLocaleCatalog(formalCatalog, path);

    expect(matchKinshipLocaleTerm(catalog, "direct-father")).toBe("爸");
    expect(matchKinshipLocaleTerm(catalog, "uncovered-rule")).toBeNull();
  });
});
