import type { PartialDate } from "../../../shared/domain.js";
import { reversePathEdge } from "./relation-graph.js";
import type {
  KinshipGender,
  KinshipPath,
  KinshipSignature,
  KinshipSignaturePair,
  KinshipStep,
  RelationGraph
} from "./types.js";

type AgeOrder = KinshipSignature["relativeAgeOrder"];

interface DateRange {
  start: number;
  end: number;
}

const dateRange = (date: PartialDate | null): DateRange | null => {
  if (!date || date.calendar !== "solar") return null;
  if (date.day !== null) {
    const instant = Date.UTC(date.year, date.month - 1, date.day);
    return { start: instant, end: instant };
  }
  const start = Date.UTC(date.year, date.month - 1, 1);
  const end = Date.UTC(date.year, date.month, 0);
  return { start, end };
};

export const compareRelativeAge = (
  viewpointBirth: PartialDate | null,
  targetBirth: PartialDate | null
): AgeOrder => {
  const viewpoint = dateRange(viewpointBirth);
  const target = dateRange(targetBirth);
  if (!viewpoint || !target) return "unknown";
  if (target.end < viewpoint.start) return "older";
  if (target.start > viewpoint.end) return "younger";
  return "unknown";
};

const siblingStep = (gender: KinshipGender, age: AgeOrder): KinshipStep => {
  if (gender === "female") {
    if (age === "older") return "olderSister";
    if (age === "younger") return "youngerSister";
    return "sister";
  }
  if (age === "older") return "olderBrother";
  if (age === "younger") return "youngerBrother";
  return "brother";
};

const parentSteps = new Set<KinshipStep>(["father", "mother", "parent"]);
const childSteps = new Set<KinshipStep>(["son", "daughter", "child"]);
const currentSpouseSteps = new Set<KinshipStep>(["husband", "wife", "spouse"]);
const formerSpouseSteps = new Set<KinshipStep>(["formerHusband", "formerWife", "formerSpouse"]);

const normalizedSteps = (graph: RelationGraph, path: KinshipPath): KinshipStep[] => {
  const output: KinshipStep[] = [];
  let index = 0;
  while (index < path.edges.length) {
    const edge = path.edges[index]!;
    const next = path.edges[index + 1];
    if (
      next
      && edge.kind === "parentChild"
      && next.kind === "parentChild"
      && parentSteps.has(edge.step)
      && childSteps.has(next.step)
    ) {
      const siblingSource = graph.people.get(path.personIds[index]!);
      const siblingTarget = graph.people.get(path.personIds[index + 2]!);
      if (siblingSource && siblingTarget) {
        const hasDescendantStepAfterSibling = index > 0 && index + 2 < path.edges.length;
        const age = hasDescendantStepAfterSibling
          ? "unknown"
          : compareRelativeAge(siblingSource.birth, siblingTarget.birth);
        output.push(siblingStep(siblingTarget.gender, age));
        index += 2;
        continue;
      }
    }
    output.push(edge.step);
    index += 1;
  }
  return output;
};

const generationDelta = (steps: readonly KinshipStep[]): number => steps.reduce((total, step) => {
  if (parentSteps.has(step)) return total - 1;
  if (childSteps.has(step)) return total + 1;
  return total;
}, 0);

const lineageSide = (steps: readonly KinshipStep[]): KinshipSignature["lineageSide"] => {
  if (steps.some((step) => currentSpouseSteps.has(step) || formerSpouseSteps.has(step))) return "affinity";
  const firstAncestor = steps.find((step) => parentSteps.has(step));
  if (firstAncestor === "father") return "paternal";
  if (firstAncestor === "mother") return "maternal";
  if (steps.length === 0 || steps.some((step) => childSteps.has(step) || step.includes("Brother") || step.includes("Sister") || step === "brother" || step === "sister")) return "self";
  return "unknown";
};

const signature = (graph: RelationGraph, path: KinshipPath): KinshipSignature => {
  const viewpoint = graph.people.get(path.personIds[0]!)!;
  const target = graph.people.get(path.personIds[path.personIds.length - 1]!)!;
  const steps = normalizedSteps(graph, path);
  return {
    steps,
    generationDelta: generationDelta(steps),
    lineageSide: lineageSide(steps),
    bloodAffinity: path.edges.some((edge) => edge.kind === "formerMarriage")
      ? "directFormerSpouse"
      : path.edges.some((edge) => edge.kind === "marriage")
        ? "currentAffinity"
        : "blood",
    viewpointGender: viewpoint.gender,
    targetGender: target.gender,
    relativeAgeOrder: compareRelativeAge(viewpoint.birth, target.birth),
    pathPersonIds: [...path.personIds],
    pathRelationIds: [...path.relationIds]
  };
};

export function buildSignaturePair(graph: RelationGraph, path: KinshipPath): KinshipSignaturePair {
  const reversePath: KinshipPath = {
    edges: [...path.edges].reverse().map(reversePathEdge),
    personIds: [...path.personIds].reverse(),
    relationIds: [...path.relationIds].reverse(),
    rank: path.rank
  };
  const forward = signature(graph, path);
  const reverse = signature(graph, reversePath);
  const hasAgeNeutralSibling = forward.steps.some((step) => step === "brother" || step === "sister");
  return {
    forward,
    reverse,
    uncertainty: hasAgeNeutralSibling && forward.relativeAgeOrder === "unknown"
      ? ["缺少可靠出生日期，未推断长幼顺序"]
      : []
  };
}
