import { createRelationGraph, reversePathEdge } from "./relation-graph.js";
import { findKinshipPaths, findPrimaryKinshipPaths } from "./path-search.js";
import {
  loadKinshipRuleCatalog,
  matchKinshipRule,
  reverseTerm,
  type KinshipRule,
  type KinshipRuleCatalog
} from "./rule-loader.js";
import {
  loadKinshipLocaleCatalog,
  matchKinshipLocaleTerm,
  type KinshipLocaleCatalog
} from "./locale-loader.js";
import { buildSignaturePair } from "./signature-builder.js";
import type {
  KinshipDisplayLabel,
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

const composedTermNotice = "未匹配精确称谓，已使用组合式称谓";

const slicePath = (path: KinshipPath, startEdge: number, endEdge: number): KinshipPath => ({
  edges: path.edges.slice(startEdge, endEdge),
  personIds: path.personIds.slice(startEdge, endEdge + 1),
  relationIds: path.relationIds.slice(startEdge, endEdge),
  rank: path.rank
});

const exactTermForPath = (
  graph: RelationGraph,
  path: KinshipPath,
  catalog: KinshipRuleCatalog
): string | null => matchKinshipRule(catalog, buildSignaturePair(graph, path).forward)?.forward ?? null;

const composedTermForPath = (
  graph: RelationGraph,
  path: KinshipPath,
  catalog: KinshipRuleCatalog
): string | null => {
  if (path.edges.length === 0) return null;
  const exact = exactTermForPath(graph, path, catalog);
  if (exact) return exact;

  // For a spouse-side path, keep the spouse as the grammatical anchor so
  // `husband -> maternal cousin` reads as `丈夫的表妹`, not `婆婆的侄女`.
  if (path.edges[0]?.kind === "marriage" && path.edges.length > 1) {
    const spouse = exactTermForPath(graph, slicePath(path, 0, 1), catalog);
    const relative = composedTermForPath(graph, slicePath(path, 1, path.edges.length), catalog);
    if (spouse && relative) return `${spouse}的${relative}`;
  }

  for (let split = path.edges.length - 1; split >= 1; split -= 1) {
    const prefix = exactTermForPath(graph, slicePath(path, 0, split), catalog);
    if (!prefix) continue;
    const suffix = composedTermForPath(graph, slicePath(path, split, path.edges.length), catalog);
    if (suffix) return `${prefix}的${suffix}`;
  }
  return null;
};

const exactTermForSignatureSteps = (
  signature: KinshipSignature,
  steps: KinshipSignature["steps"],
  catalog: KinshipRuleCatalog
): string | null => matchKinshipRule(catalog, { ...signature, steps })?.forward ?? null;

const composedTermForSignatureSteps = (
  signature: KinshipSignature,
  steps: KinshipSignature["steps"],
  catalog: KinshipRuleCatalog
): string | null => {
  if (steps.length === 0) return null;
  const exact = exactTermForSignatureSteps(signature, steps, catalog);
  if (exact) return exact;
  for (let split = steps.length - 1; split >= 1; split -= 1) {
    const prefix = exactTermForSignatureSteps(signature, steps.slice(0, split), catalog);
    if (!prefix) continue;
    const suffix = composedTermForSignatureSteps(signature, steps.slice(split), catalog);
    if (suffix) return `${prefix}的${suffix}`;
  }
  return null;
};

const pathDescriptionForPath = (
  graph: RelationGraph,
  path: KinshipPath,
  catalog: KinshipRuleCatalog
): string | null => {
  const signature = buildSignaturePair(graph, path).forward;
  const steps = signature.steps;
  let parentPrefixLength = 0;
  while (
    parentPrefixLength < steps.length
    && ["father", "mother", "parent"].includes(steps[parentPrefixLength]!)
  ) {
    parentPrefixLength += 1;
  }

  if (parentPrefixLength > 0 && parentPrefixLength < steps.length) {
    const ancestor = composedTermForSignatureSteps(signature, steps.slice(0, parentPrefixLength), catalog);
    const relative = composedTermForSignatureSteps(signature, steps.slice(parentPrefixLength), catalog);
    if (ancestor && relative) return `${ancestor}的${relative}`;
  }
  return composedTermForSignatureSteps(signature, steps, catalog);
};

const reversedPath = (path: KinshipPath): KinshipPath => ({
  edges: [...path.edges].reverse().map(reversePathEdge),
  personIds: [...path.personIds].reverse(),
  relationIds: [...path.relationIds].reverse(),
  rank: path.rank
});

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

const emptyLocaleCatalog = (formalCatalog: KinshipRuleCatalog): KinshipLocaleCatalog => ({
  locale: "zh-CN-henan-gongyi",
  version: "zh-CN-henan-gongyi-v1",
  formalCatalogVersion: formalCatalog.version,
  terms: []
});

const emptyDisplayLabel = (
  localeCatalog: KinshipLocaleCatalog,
  pathDescription: string | null = null
): KinshipDisplayLabel => ({
  formalTerm: null,
  regionalTerm: null,
  displayTerm: null,
  pathDescription,
  formalRuleId: null,
  locale: localeCatalog.locale,
  regionalRuleVersion: localeCatalog.version
});

const displayLabelForPath = (
  graph: RelationGraph,
  path: KinshipPath,
  formalCatalog: KinshipRuleCatalog,
  localeCatalog: KinshipLocaleCatalog,
  rule: KinshipRule | null
): KinshipDisplayLabel => {
  const formalTerm = rule?.forward ?? composedTermForPath(graph, path, formalCatalog);
  const matchedRegionalTerm = rule ? matchKinshipLocaleTerm(localeCatalog, rule.id) : null;
  const regionalTerm = matchedRegionalTerm && matchedRegionalTerm !== formalTerm
    ? matchedRegionalTerm
    : null;
  return {
    formalTerm,
    regionalTerm,
    displayTerm: regionalTerm ?? formalTerm,
    pathDescription: pathDescriptionForPath(graph, path, formalCatalog),
    formalRuleId: rule?.id ?? null,
    locale: localeCatalog.locale,
    regionalRuleVersion: localeCatalog.version
  };
};

const resolvePath = (
  graph: RelationGraph,
  path: KinshipPath,
  catalog: KinshipRuleCatalog,
  localeCatalog: KinshipLocaleCatalog
): { alternative: RelationshipAlternative; uncertainty: string[] } => {
  const signatures = buildSignaturePair(graph, path);
  const conflicts = conflictsForPath(graph, path);
  if (conflicts.length > 0) {
    const uncertainty = conflicts.map((id) => `数据冲突：${id}`);
    return {
      alternative: {
        ...emptyDisplayLabel(localeCatalog, pathDescriptionForPath(graph, path, catalog)),
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
    const composedPrimaryTerm = composedTermForPath(graph, path, catalog);
    if (composedPrimaryTerm) {
      const label = displayLabelForPath(graph, path, catalog, localeCatalog, null);
      return {
        alternative: {
          ...label,
          primaryTerm: composedPrimaryTerm,
          reverseTerm: composedTermForPath(graph, reversedPath(path), catalog),
          description: `${stepDescription(path)}；${composedTermNotice}`,
          signature: signatures.forward
        },
        uncertainty: [...signatures.uncertainty, composedTermNotice]
      };
    }
    return {
      alternative: {
        ...emptyDisplayLabel(localeCatalog, pathDescriptionForPath(graph, path, catalog)),
        primaryTerm: null,
        reverseTerm: null,
        description: `${stepDescription(path)}；称谓规则尚未覆盖`,
        signature: signatures.forward
      },
      uncertainty: [...signatures.uncertainty, "称谓规则尚未覆盖"]
    };
  }

  const label = displayLabelForPath(graph, path, catalog, localeCatalog, rule);
  return {
    alternative: {
      ...label,
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
  catalog: KinshipRuleCatalog,
  localeCatalog: KinshipLocaleCatalog
): RelationshipResult {
  const paths = findKinshipPaths(graph, viewpointId, targetId);
  if (paths.length === 0) {
    return {
      ...emptyDisplayLabel(localeCatalog),
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
      ...emptyDisplayLabel(localeCatalog, pathDescriptionForPath(graph, paths[0]!, catalog)),
      primaryTerm: null,
      reverseTerm: null,
      description: `${stepDescription(paths[0]!)}；数据冲突：${selectedConflictIds.join("、")}`,
      ruleVersion: catalog.version,
      signature: signatures[0]!,
      alternatives: paths.slice(1).map((path, index) => ({
        ...emptyDisplayLabel(localeCatalog, pathDescriptionForPath(graph, path, catalog)),
        primaryTerm: null,
        reverseTerm: null,
        description: `${stepDescription(path)}；数据冲突：${selectedConflictIds.join("、")}`,
        signature: signatures[index + 1]!
      })),
      uncertainty: selectedConflictIds.map((id) => `数据冲突：${id}`)
    };
  }

  const resolved = paths.map((path) => resolvePath(graph, path, catalog, localeCatalog));
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
  catalog?: KinshipRuleCatalog,
  localeCatalog?: KinshipLocaleCatalog
): RelationshipResult {
  const formalCatalog = catalog ?? loadKinshipRuleCatalog();
  const regionalCatalog = localeCatalog
    ?? (catalog ? emptyLocaleCatalog(formalCatalog) : loadKinshipLocaleCatalog(formalCatalog));
  return calculateRelationshipInGraph(
    createRelationGraph(facts),
    viewpointId,
    targetId,
    formalCatalog,
    regionalCatalog
  );
}

export class RelationshipCalculator {
  private readonly graph: RelationGraph;
  private readonly catalog: KinshipRuleCatalog;
  private readonly localeCatalog: KinshipLocaleCatalog;

  constructor(
    facts: KinshipFactGraph,
    catalog?: KinshipRuleCatalog,
    localeCatalog?: KinshipLocaleCatalog
  ) {
    this.graph = createRelationGraph(facts);
    this.catalog = catalog ?? loadKinshipRuleCatalog();
    this.localeCatalog = localeCatalog
      ?? (catalog ? emptyLocaleCatalog(this.catalog) : loadKinshipLocaleCatalog(this.catalog));
  }

  calculateRelationship(viewpointId: string, targetId: string): RelationshipResult {
    return calculateRelationshipInGraph(
      this.graph,
      viewpointId,
      targetId,
      this.catalog,
      this.localeCatalog
    );
  }

  calculatePrimaryTerms(viewpointId: string, targetIds: readonly string[]): ReadonlyMap<string, string | null> {
    const labels = this.calculatePrimaryLabels(viewpointId, targetIds);
    return new Map(targetIds.map((targetId) => [targetId, labels.get(targetId)?.formalTerm ?? null] as const));
  }

  calculatePrimaryLabels(
    viewpointId: string,
    targetIds: readonly string[]
  ): ReadonlyMap<string, KinshipDisplayLabel | null> {
    const paths = findPrimaryKinshipPaths(this.graph, viewpointId, targetIds);
    return new Map(targetIds.map((targetId) => {
      const candidate = paths.get(targetId);
      if (!candidate || candidate.conflictIds.length > 0) return [targetId, null] as const;
      const alternative = resolvePath(
        this.graph,
        candidate.path,
        this.catalog,
        this.localeCatalog
      ).alternative;
      if (!alternative.formalTerm) return [targetId, null] as const;
      const {
        formalTerm,
        regionalTerm,
        displayTerm,
        pathDescription,
        formalRuleId,
        locale,
        regionalRuleVersion
      } = alternative;
      return [targetId, {
        formalTerm,
        regionalTerm,
        displayTerm,
        pathDescription,
        formalRuleId,
        locale,
        regionalRuleVersion
      }] as const;
    }));
  }
}
