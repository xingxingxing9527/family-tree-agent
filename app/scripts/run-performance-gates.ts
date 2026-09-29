import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { ImportPlanner, ImportPlanStore } from "../src/main/application/import/import-planner.js";
import type { ParsedImport } from "../src/main/application/import/import-types.js";
import { FactQueries } from "../src/main/application/facts/fact-queries.js";
import { projectWorkspaceTree } from "../src/main/application/query/workspace-projection.js";
import { RelationshipCalculator } from "../src/main/domain/kinship/relationship-calculator.js";
import { layoutWithElk } from "../src/renderer/src/features/tree/layout-with-elk.js";
import {
  BENCHMARK_SEED,
  benchmarkInvariants,
  buildBenchmarkBlueprint,
  materializeBenchmarkWorkspace,
  type BenchmarkBlueprint
} from "./generate-benchmark-workspace.js";

export const PERFORMANCE_GATES = Object.freeze({
  defaultTreeAndLayoutMs: 2_000,
  viewpointRelabelMs: 500,
  relationshipP95Ms: 300,
  importPreviewMs: 30_000
});

interface Distribution {
  sampleCount: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

interface GateResult extends Distribution {
  thresholdMs: number;
  measuredBy: "p95";
  passed: boolean;
}

const round = (value: number): number => Number(value.toFixed(3));

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]!;
}

export function distribution(samples: readonly number[]): Distribution {
  if (samples.length === 0) throw new Error("At least one timing sample is required");
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    sampleCount: sorted.length,
    medianMs: round(median),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1)!)
  };
}

export function buildFixedRelationshipPairs(blueprint: BenchmarkBlueprint): Array<readonly [string, string]> {
  return Array.from({ length: 200 }, (_, index) => {
    const fromIndex = (index * 37) % blueprint.people.length;
    let toIndex = (index * 83 + 17) % blueprint.people.length;
    if (toIndex === fromIndex) toIndex = (toIndex + 1) % blueprint.people.length;
    return [blueprint.people[fromIndex]!.id, blueprint.people[toIndex]!.id] as const;
  });
}

async function measureAsync(samples: number, operation: () => Promise<unknown>): Promise<number[]> {
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await operation();
    durations.push(performance.now() - started);
  }
  return durations;
}

function measureSync<T>(items: readonly T[], operation: (item: T) => unknown): number[] {
  return items.map((item) => {
    const started = performance.now();
    operation(item);
    return performance.now() - started;
  });
}

function gate(samples: readonly number[], thresholdMs: number): GateResult {
  const stats = distribution(samples);
  return { ...stats, thresholdMs, measuredBy: "p95", passed: stats.p95Ms <= thresholdMs };
}

function importFixture(): ParsedImport {
  return {
    sourceKey: "benchmark-import-20260916",
    fileName: "benchmark-1000.csv",
    rows: Array.from({ length: 1_000 }, (_, index) => ({
      sheet: "People" as const,
      row: index + 2,
      raw: {
        person_external_id: `import-${(index + 1).toString().padStart(4, "0")}`,
        name: `导入基准-${(index + 1).toString().padStart(4, "0")}`,
        gender: index % 2 === 0 ? "male" : "female",
        birth_calendar: "solar",
        birth_year: 1900 + index % 100,
        birth_month: index % 12 + 1,
        birth_precision: "month",
        notes: `seed=${BENCHMARK_SEED}`
      }
    }))
  };
}

export async function runPerformanceGates(): Promise<{ passed: boolean; reportPath: string; gates: Record<string, GateResult> }> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "family-agent-performance-"));
  let workspace: Awaited<ReturnType<typeof materializeBenchmarkWorkspace>> | undefined;
  try {
    workspace = await materializeBenchmarkWorkspace(join(temporaryRoot, "workspace"), BENCHMARK_SEED);
    const { database, blueprint } = workspace;
    const workspaceId = blueprint.workspaceId;
    process.stdout.write(`[performance] materialized ${blueprint.people.length} people\n`);

    const initialProjection = projectWorkspaceTree(database, workspaceId, { view: "full", collapseDepth: 4 });
    process.stdout.write(`[performance] warm-up tree has ${initialProjection.topology.nodes.length} nodes and ${initialProjection.topology.edges.length} edges\n`);
    await layoutWithElk(initialProjection.topology);
    const treeSamples = await measureAsync(5, async () => {
      const projection = projectWorkspaceTree(database, workspaceId, { view: "full", collapseDepth: 4 });
      await layoutWithElk(projection.topology);
    });
    process.stdout.write("[performance] default tree/layout measured\n");

    const viewpointId = blueprint.people[0]!.id;
    projectWorkspaceTree(database, workspaceId, { view: "full", collapseDepth: 4, viewpointId });
    const viewpointSamples = measureSync(Array.from({ length: 5 }, (_, index) => index), () => {
      projectWorkspaceTree(database, workspaceId, { view: "full", collapseDepth: 4, viewpointId });
    });
    process.stdout.write("[performance] viewpoint relabel measured\n");

    const queries = new FactQueries(database, workspaceId);
    const people = queries.listPeople();
    const parentChild = queries.listParentChild();
    const marriages = queries.listMarriages();
    const calculator = new RelationshipCalculator({
      people: people.map((person) => ({ id: person.id, gender: person.gender, birth: person.birth })),
      parentChild: parentChild.map((relation) => ({
        id: relation.id,
        parentId: relation.parentId,
        childId: relation.childId,
        parentRole: relation.parentRole
      })),
      marriages: marriages.map((marriage) => ({
        id: marriage.id,
        spouseAId: marriage.spouseAId,
        spouseBId: marriage.spouseBId,
        status: marriage.status
      }))
    });
    const relationshipPairs = buildFixedRelationshipPairs(blueprint);
    calculator.calculateRelationship(...relationshipPairs[0]!);
    const relationshipSamples = measureSync(relationshipPairs, ([from, to]) => calculator.calculateRelationship(from, to));
    process.stdout.write("[performance] 200 relationships measured\n");

    const planner = new ImportPlanner(database, workspaceId, new ImportPlanStore());
    const importInput = importFixture();
    planner.plan(importInput);
    const importSamples = measureSync(Array.from({ length: 3 }, (_, index) => index), () => planner.plan(importInput));
    process.stdout.write("[performance] 1000-row import preview measured\n");

    const gates = {
      defaultTreeAndLayout: gate(treeSamples, PERFORMANCE_GATES.defaultTreeAndLayoutMs),
      viewpointRelabel: gate(viewpointSamples, PERFORMANCE_GATES.viewpointRelabelMs),
      relationshipP95: gate(relationshipSamples, PERFORMANCE_GATES.relationshipP95Ms),
      importPreview: gate(importSamples, PERFORMANCE_GATES.importPreviewMs)
    };
    const cpuInfo = cpus();
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      seed: BENCHMARK_SEED,
      invariants: benchmarkInvariants(blueprint),
      runtime: {
        node: process.version,
        electron: process.versions.electron ?? null,
        platform: platform(),
        osRelease: release(),
        architecture: process.arch,
        cpuCount: cpuInfo.length,
        cpuModel: cpuInfo[0]?.model ?? "unknown",
        totalMemoryBytes: totalmem(),
        freeMemoryBytesAtReport: freemem()
      },
      gates,
      passed: Object.values(gates).every(({ passed }) => passed)
    };
    const reportDirectory = resolve("release", "reports");
    await mkdir(reportDirectory, { recursive: true });
    const reportPath = resolve(reportDirectory, "performance-report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return { passed: report.passed, reportPath, gates };
  } finally {
    workspace?.database.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const result = await runPerformanceGates();
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
