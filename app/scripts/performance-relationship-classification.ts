import type { RelationshipResultDto, RelationshipSignatureDto } from "../src/shared/contracts.js";
import type { BenchmarkRelationshipCategory } from "./generate-benchmark-workspace.js";

export const REQUIRED_RELATIONSHIP_DISTRIBUTION = Object.freeze({
  direct: 30,
  ancestor: 25,
  collateral: 30,
  cousin: 25,
  affinity: 30,
  multipath: 25,
  conflict: 15,
  missing: 20
});

const signatureRank = (signature: RelationshipSignatureDto): 0 | 1 | 2 =>
  signature.pathRelationIds.length <= 1 ? 0 : signature.bloodAffinity === "blood" ? 1 : 2;

export function classifyProductionRelationship(
  result: RelationshipResultDto
): BenchmarkRelationshipCategory | "unsupported" {
  if (result.primaryTerm === null && result.uncertainty.some((entry) => entry.startsWith("数据冲突："))) return "conflict";
  if (
    result.primaryTerm === null
    && result.signature.pathRelationIds.length === 0
    && result.uncertainty.includes("未找到可用关系路径")
  ) return "missing";
  if (
    result.alternatives.length > 0
    && result.alternatives.every((alternative) =>
      alternative.signature.pathRelationIds.length === result.signature.pathRelationIds.length
      && signatureRank(alternative.signature) === signatureRank(result.signature)
    )
  ) return "multipath";
  if (result.primaryTerm === null) return "unsupported";
  if (result.signature.pathRelationIds.length === 1) return "direct";
  if (result.signature.bloodAffinity === "currentAffinity") return "affinity";
  if (result.signature.bloodAffinity !== "blood") return "unsupported";
  if (Math.abs(result.signature.generationDelta) >= 2) return "ancestor";
  if (result.signature.generationDelta === 0 && result.signature.pathRelationIds.length >= 4) return "cousin";
  if (result.signature.generationDelta === 0 && result.signature.pathRelationIds.length >= 2) return "collateral";
  return "unsupported";
}
