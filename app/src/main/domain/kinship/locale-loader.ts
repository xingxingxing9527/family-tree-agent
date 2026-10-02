import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KinshipRuleCatalog } from "./rule-loader.js";

export interface KinshipLocaleTerm {
  ruleId: string;
  term: string;
}

export interface KinshipLocaleCatalog {
  locale: string;
  version: string;
  formalCatalogVersion: string;
  terms: KinshipLocaleTerm[];
}

const termIndexes = new WeakMap<KinshipLocaleCatalog, ReadonlyMap<string, string>>();

export function parseKinshipLocaleCatalog(
  value: unknown,
  formalCatalog: KinshipRuleCatalog
): KinshipLocaleCatalog {
  if (!value || typeof value !== "object") throw new Error("Kinship locale catalog must be an object");
  const candidate = value as Partial<KinshipLocaleCatalog>;
  if (typeof candidate.locale !== "string" || !candidate.locale.trim()) throw new Error("Kinship locale is required");
  if (typeof candidate.version !== "string" || !candidate.version.trim()) throw new Error("Kinship locale version is required");
  if (typeof candidate.formalCatalogVersion !== "string" || !candidate.formalCatalogVersion.trim()) {
    throw new Error("Formal catalog version is required");
  }
  if (candidate.formalCatalogVersion !== formalCatalog.version) {
    throw new Error(`Formal catalog version mismatch: expected ${formalCatalog.version}`);
  }
  if (!Array.isArray(candidate.terms)) throw new Error("Kinship locale terms must be an array");

  const knownRules = new Set(formalCatalog.rules.map((rule) => rule.id));
  const seenRules = new Set<string>();
  const terms = candidate.terms.map((entry): KinshipLocaleTerm => {
    if (!entry || typeof entry !== "object") throw new Error("Every kinship locale term must be an object");
    const term = entry as Partial<KinshipLocaleTerm>;
    if (typeof term.ruleId !== "string" || !term.ruleId.trim()) throw new Error("Every kinship locale term needs a ruleId");
    if (seenRules.has(term.ruleId)) throw new Error(`Duplicate kinship locale rule id: ${term.ruleId}`);
    if (!knownRules.has(term.ruleId)) throw new Error(`Unknown formal rule: ${term.ruleId}`);
    if (typeof term.term !== "string" || !term.term.trim()) throw new Error(`Kinship locale term is required for ${term.ruleId}`);
    seenRules.add(term.ruleId);
    return { ruleId: term.ruleId, term: term.term.trim() };
  });

  const catalog: KinshipLocaleCatalog = {
    locale: candidate.locale.trim(),
    version: candidate.version.trim(),
    formalCatalogVersion: candidate.formalCatalogVersion,
    terms
  };
  termIndexes.set(catalog, new Map(terms.map((term) => [term.ruleId, term.term])));
  return catalog;
}

const defaultCatalogPath = (): string => {
  const electronResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const fileName = "zh-CN-henan-gongyi-v1.json";
  const candidates = [
    ...(typeof electronResourcesPath === "string"
      ? [resolve(electronResourcesPath, "kinship-locales", fileName)]
      : []),
    resolve(process.cwd(), "resources", "kinship-locales", fileName),
    fileURLToPath(new URL(`../../resources/kinship-locales/${fileName}`, import.meta.url)),
    fileURLToPath(new URL(`../../../../resources/kinship-locales/${fileName}`, import.meta.url))
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
};

export function loadKinshipLocaleCatalog(
  formalCatalog: KinshipRuleCatalog,
  filePath?: string
): KinshipLocaleCatalog {
  const catalogPath = filePath ?? defaultCatalogPath();
  return parseKinshipLocaleCatalog(JSON.parse(readFileSync(catalogPath, "utf8")), formalCatalog);
}

export function matchKinshipLocaleTerm(
  catalog: KinshipLocaleCatalog,
  ruleId: string
): string | null {
  let index = termIndexes.get(catalog);
  if (!index) {
    index = new Map(catalog.terms.map((term) => [term.ruleId, term.term]));
    termIndexes.set(catalog, index);
  }
  return index.get(ruleId) ?? null;
}
