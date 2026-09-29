import { createRelationGraph } from "./relation-graph.js";
import { findKinshipPaths, findPrimaryKinshipPaths } from "./path-search.js";
import {
  loadKinshipRuleCatalog,
  matchKinshipRule,
  reverseTerm,
  type KinshipRuleCatalog
} from "./rule-loader.js";
import { buildSignaturePair } from "./signature-builder.js";
import type {
  KinshipFactGraph,
  KinshipPath,
  KinshipSignature,
  RelationshipAlternative,
  RelationshipResult,
  RelationGraph
} from "./types.js";

const stepDescription = (path: KinshipPath): string => {
  let output = `关系路径：${path.personIds[0]}`;
  path.edges.forEach((edge, index) => {
    output += ` -[${edge.step}:${edge.relationId}]-> ${path.personIds[index + 1]}`;
  });
  return output;
};

const conflictsForPath = (graph: RelationGraph, path: KinshipPath): string[] => {
  const conflicts = new Set<string>();
  for (const personId of path.personIds) {
    for (const conflictId of graph.people.get(personId)?.conflictIds ?? []) conflicts.add(conflictId);
  }
  for (const edge of path.edges) {
    for (const conflictId of edge.conflictIds) conflicts.add(conflictId);
  }
  return [...conflicts].sort();
};

const emptySignature = (
  graph: RelationGraph,
  viewpointId: string,
  targetId: string
): KinshipSignature => ({
  steps: [],
  generationDelta: 0,
  lineageSide: "unknown",
  bloodAffinity: "blood",
  viewpointGender: graph.people.get(viewpointId)?.gender ?? "unknown",
  targetGender: graph.people.get(targetId)?.gender ?? "unknown",
  relativeAgeOrder: "unknown",
  pathPersonIds: graph.people.has(viewpointId) ? [viewpointId] : [],
  pathRelationIds: []
});

const resolvePath = (
  graph: RelationGraph,
  path: KinshipPath,
  catalog: KinshipRuleCatalog
): { alternative: RelationshipAlternative; uncertainty: string[] } => {
  const signatures = buildSignaturePair(graph, path);
  const conflicts = conflictsForPath(graph, path);
  if (conflicts.length > 0) {
    const uncertainty = conflicts.map((id) => `数据冲突：${id}`);
    return {
      alternative: {
        primaryTerm: null,
        reverseTerm: null,
        description: `${stepDescription(path)}；数据冲突：${conflicts.join("、")}`,
        signature: signatures.forward
      },
      uncertainty
    };
  }

  const rule = matchKinshipRule(catalog, signatures.forward);
  if (!rule) {
    return {
      alternative: {
        primaryTerm: null,
        reverseTerm: null,
        description: `${stepDescription(path)}；称谓规则尚未覆盖`,
        signature: signatures.forward
      },
      uncertainty: [...signatures.uncertainty, "称谓规则尚未覆盖"]
    };
  }

  return {
    alternative: {
      primaryTerm: rule.forward,
      reverseTerm: reverseTerm(rule, signatures.forward.viewpointGender),
      description: stepDescription(path),
      signature: signatures.forward
    },
    uncertainty: signatures.uncertainty
  };
};

function calculateRelationshipInGraph(
  graph: RelationGraph,
  viewpointId: string,
  targetId: string,
  catalog: KinshipRuleCatalog
): RelationshipResult {
  const paths = findKinshipPaths(graph, viewpointId, targetId);
  if (paths.length === 0) {
    return {
      primaryTerm: null,
      reverseTerm: null,
      description: `未找到从 ${viewpointId} 到 ${targetId} 的可用关系路径`,
      ruleVersion: catalog.version,
      signature: emptySignature(graph, viewpointId, targetId),
      alternatives: [],
      uncertainty: ["未找到可用关系路径"]
    };
  }

  const selectedConflictIds = [...new Set(paths.flatMap((path) => conflictsForPath(graph, path)))].sort();
  if (selectedConflictIds.length > 0) {
    const signatures = paths.map((path) => buildSignaturePair(graph, path).forward);
    return {
      primaryTerm: null,
      reverseTerm: null,
      description: `${stepDescription(paths[0]!)}；数据冲突：${selectedConflictIds.join("、")}`,
      ruleVersion: catalog.version,
      signature: signatures[0]!,
      alternatives: paths.slice(1).map((path, index) => ({
        primaryTerm: null,
        reverseTerm: null,
        description: `${stepDescription(path)}；数据冲突：${selectedConflictIds.join("、")}`,
        signature: signatures[index + 1]!
      })),
      uncertainty: selectedConflictIds.map((id) => `数据冲突：${id}`)
    };
  }

  const resolved = paths.map((path) => resolvePath(graph, path, catalog));
  const [primary, ...alternatives] = resolved;
  return {
    ...primary!.alternative,
    ruleVersion: catalog.version,
    alternatives: alternatives.map((entry) => entry.alternative),
    uncertainty: [...new Set(resolved.flatMap((entry) => entry.uncertainty))]
  };
}

export function calculateRelationship(
  facts: KinshipFactGraph,
  viewpointId: string,
  targetId: string,
  catalog: KinshipRuleCatalog = loadKinshipRuleCatalog()
): RelationshipResult {
  return calculateRelationshipInGraph(createRelationGraph(facts), viewpointId, targetId, catalog);
}

export class RelationshipCalculator {
  private readonly graph: RelationGraph;

  constructor(
    facts: KinshipFactGraph,
    private readonly catalog: KinshipRuleCatalog = loadKinshipRuleCatalog()
  ) {
    this.graph = createRelationGraph(facts);
  }

  calculateRelationship(viewpointId: string, targetId: string): RelationshipResult {
    return calculateRelationshipInGraph(this.graph, viewpointId, targetId, this.catalog);
  }

  calculatePrimaryTerms(viewpointId: string, targetIds: readonly string[]): ReadonlyMap<string, string | null> {
    const paths = findPrimaryKinshipPaths(this.graph, viewpointId, targetIds);
    return new Map(targetIds.map((targetId) => {
      const candidate = paths.get(targetId);
      if (!candidate || candidate.conflictIds.length > 0) return [targetId, null] as const;
      return [targetId, resolvePath(this.graph, candidate.path, this.catalog).alternative.primaryTerm] as const;
    }));
  }
}
