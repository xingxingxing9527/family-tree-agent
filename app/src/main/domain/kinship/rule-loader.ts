import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KinshipGender, KinshipSignature, KinshipStep } from "./types.js";

export interface KinshipRulePattern {
  steps: KinshipStep[];
  viewpointGender?: KinshipGender;
  targetGender?: KinshipGender;
  relativeAgeOrder?: KinshipSignature["relativeAgeOrder"];
}

export interface KinshipRule {
  id: string;
  pattern: KinshipRulePattern;
  forward: string;
  reverse?: string;
  reverseByViewpointGender?: Partial<Record<KinshipGender, string>>;
}

export interface KinshipRuleCatalog {
  version: string;
  rules: KinshipRule[];
}

const validGenders = new Set<KinshipGender>(["male", "female", "unknown"]);

export function parseKinshipRuleCatalog(value: unknown): KinshipRuleCatalog {
  if (!value || typeof value !== "object") throw new Error("Kinship rule catalog must be an object");
  const candidate = value as Partial<KinshipRuleCatalog>;
  if (typeof candidate.version !== "string" || !candidate.version) throw new Error("Kinship rule catalog version is required");
  if (!Array.isArray(candidate.rules)) throw new Error("Kinship rule catalog rules must be an array");
  const ids = new Set<string>();
  for (const rule of candidate.rules) {
    if (!rule || typeof rule.id !== "string" || !rule.id) throw new Error("Every kinship rule needs an id");
    if (ids.has(rule.id)) throw new Error(`Duplicate kinship rule id: ${rule.id}`);
    ids.add(rule.id);
    if (!rule.pattern || !Array.isArray(rule.pattern.steps)) throw new Error(`Kinship rule ${rule.id} needs steps`);
    if (typeof rule.forward !== "string" || !rule.forward) throw new Error(`Kinship rule ${rule.id} needs a forward term`);
    if (rule.pattern.viewpointGender && !validGenders.has(rule.pattern.viewpointGender)) throw new Error(`Invalid viewpoint gender in ${rule.id}`);
    if (rule.pattern.targetGender && !validGenders.has(rule.pattern.targetGender)) throw new Error(`Invalid target gender in ${rule.id}`);
  }
  return candidate as KinshipRuleCatalog;
}

const defaultCatalogPath = (): string => {
  const candidates = [
    resolve(process.cwd(), "resources", "kinship-rules", "mandarin-v1.json"),
    fileURLToPath(new URL("../../resources/kinship-rules/mandarin-v1.json", import.meta.url)),
    fileURLToPath(new URL("../../../../resources/kinship-rules/mandarin-v1.json", import.meta.url))
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
};

export function loadKinshipRuleCatalog(filePath?: string): KinshipRuleCatalog {
  const catalogPath = filePath ?? defaultCatalogPath();
  return parseKinshipRuleCatalog(JSON.parse(readFileSync(catalogPath, "utf8")));
}

export function matchKinshipRule(
  catalog: KinshipRuleCatalog,
  signature: KinshipSignature
): KinshipRule | null {
  return catalog.rules.find((rule) => {
    if (rule.pattern.steps.length !== signature.steps.length) return false;
    if (!rule.pattern.steps.every((step, index) => step === signature.steps[index])) return false;
    if (rule.pattern.viewpointGender && rule.pattern.viewpointGender !== signature.viewpointGender) return false;
    if (rule.pattern.targetGender && rule.pattern.targetGender !== signature.targetGender) return false;
    if (rule.pattern.relativeAgeOrder && rule.pattern.relativeAgeOrder !== signature.relativeAgeOrder) return false;
    return true;
  }) ?? null;
}

export function reverseTerm(rule: KinshipRule, viewpointGender: KinshipGender): string | null {
  if (rule.reverse) return rule.reverse;
  return rule.reverseByViewpointGender?.[viewpointGender]
    ?? rule.reverseByViewpointGender?.unknown
    ?? null;
}
