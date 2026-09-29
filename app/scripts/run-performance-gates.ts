import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";
import ExcelJS from "exceljs";
import { ImportPlanner, ImportPlanStore } from "../src/main/application/import/import-planner.js";
import { IMPORT_TEMPLATE_COLUMNS, parseImport } from "../src/main/application/import/workbook-parser.js";
import { QueryToolRegistry } from "../src/main/application/query/query-tool-registry.js";
import { projectWorkspaceTree } from "../src/main/application/query/workspace-projection.js";
import { layoutWithElk } from "../src/renderer/src/features/tree/layout-with-elk.js";
import {
  BENCHMARK_SEED,
  benchmarkInvariants,
  buildBenchmarkBlueprint,
  materializeBenchmarkWorkspace,
  type BenchmarkBlueprint,
  type BenchmarkRelationshipPair
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

export function buildFixedRelationshipPairs(blueprint: BenchmarkBlueprint): BenchmarkRelationshipPair[] {
  return blueprint.relationshipPairs.map((entry) => ({ ...entry }));
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

export async function writeBenchmarkImportFiles(root: string): Promise<{ csvPath: string; xlsxPath: string }> {
  await mkdir(root, { recursive: true });
  const csvPath = resolve(root, "benchmark-1000.csv");
  const xlsxPath = resolve(root, "benchmark-1000.xlsx");
  const headers = IMPORT_TEMPLATE_COLUMNS.People;
  const rows = Array.from({ length: 1_000 }, (_, index) => ({
    person_external_id: `import-${(index + 1).toString().padStart(4, "0")}`,
    name: `导入基准-${(index + 1).toString().padStart(4, "0")}`,
    gender: index % 2 === 0 ? "male" : "female",
    birth_calendar: "solar",
    birth_year: 1900 + index % 100,
    birth_month: index % 12 + 1,
    birth_day: "",
    birth_leap_month: "false",
    notes: `seed=${BENCHMARK_SEED}`
  }));
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => row[header as keyof typeof row]).join(","))
  ].join("\r\n");
  await writeFile(csvPath, `${csv}\r\n`, "utf8");

  const workbook = new ExcelJS.Workbook();
  const peopleSheet = workbook.addWorksheet("People");
  peopleSheet.addRow([...headers]);
  for (const row of rows) peopleSheet.addRow(headers.map((header) => row[header as keyof typeof row]));
  workbook.addWorksheet("ParentChild").addRow([...IMPORT_TEMPLATE_COLUMNS.ParentChild]);
  workbook.addWorksheet("Marriages").addRow([...IMPORT_TEMPLATE_COLUMNS.Marriages]);
  await workbook.xlsx.writeFile(xlsxPath);
  return { csvPath, xlsxPath };
}

export interface PerformanceConstraints {
  logicalCores: number;
  memoryLimitMb: number | null;
  affinityMask: string | null;
  observedHeapLimitBytes: number;
  constrained: boolean;
}

export function parsePerformanceConstraints(
  environment: NodeJS.ProcessEnv,
  observedHeapLimitBytes: number
): PerformanceConstraints {
  const logicalCoresText = environment.FAMILY_AGENT_PERF_LOGICAL_CORES;
  const memoryLimitText = environment.FAMILY_AGENT_PERF_MEMORY_LIMIT_MB;
  const affinityMask = environment.FAMILY_AGENT_PERF_AFFINITY_MASK;
  if (!logicalCoresText && !memoryLimitText && !affinityMask) {
    return {
      logicalCores: cpus().length,
      memoryLimitMb: null,
      affinityMask: null,
      observedHeapLimitBytes,
      constrained: false
    };
  }
  const logicalCores = Number(logicalCoresText);
  const memoryLimitMb = Number(memoryLimitText);
  let maskBits = 0;
  try {
    let mask = BigInt(affinityMask ?? "");
    while (mask > 0n) {
      maskBits += Number(mask & 1n);
      mask >>= 1n;
    }
  } catch {
    maskBits = 0;
  }
  if (logicalCores !== 4 || !Number.isInteger(memoryLimitMb) || memoryLimitMb <= 0 || memoryLimitMb > 8_192 || maskBits !== 4) {
    throw new Error("Constrained performance evidence requires exactly 4 logical cores and at most 8192 MiB");
  }
  if (observedHeapLimitBytes > 8_192 * 1024 * 1024) {
    throw new Error("Constrained performance evidence observed heap exceeds 8192 MiB");
  }
  return {
    logicalCores,
    memoryLimitMb,
    affinityMask: affinityMask!,
    observedHeapLimitBytes,
    constrained: true
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

    const registry = new QueryToolRegistry(database, workspaceId);
    const relationshipPairs = buildFixedRelationshipPairs(blueprint);
    registry.tools.calculate_relationship({
      viewpointId: relationshipPairs[0]!.viewpointId,
      targetId: relationshipPairs[0]!.targetId
    });
    const relationshipSamples = measureSync(relationshipPairs, ({ viewpointId, targetId }) =>
      registry.tools.calculate_relationship({ viewpointId, targetId }));
    process.stdout.write("[performance] 200 categorized production relationship queries measured\n");

    const planner = new ImportPlanner(database, workspaceId, new ImportPlanStore());
    const importFiles = await writeBenchmarkImportFiles(join(temporaryRoot, "imports"));
    const importFormats = ["csv", "xlsx", "csv"] as const;
    let importSamplesCursor = 0;
    const importSamples = await measureAsync(importFormats.length, async () => {
      const sampleIndex = importSamplesCursor++;
      const format = importFormats[sampleIndex]!;
      const parsed = await parseImport(
        format === "csv" ? importFiles.csvPath : importFiles.xlsxPath,
        `benchmark-import-${format}-${sampleIndex}`,
        format === "csv" ? { csvEntityType: "People" } : {}
      );
      planner.plan(parsed);
    });
    process.stdout.write("[performance] real 1000-row CSV/XLSX parse and plan preview measured\n");

    const gates = {
      defaultTreeAndLayout: gate(treeSamples, PERFORMANCE_GATES.defaultTreeAndLayoutMs),
      viewpointRelabel: gate(viewpointSamples, PERFORMANCE_GATES.viewpointRelabelMs),
      relationshipP95: gate(relationshipSamples, PERFORMANCE_GATES.relationshipP95Ms),
      importPreview: gate(importSamples, PERFORMANCE_GATES.importPreviewMs)
    };
    const cpuInfo = cpus();
    const constraints = parsePerformanceConstraints(process.env, getHeapStatistics().heap_size_limit);
    const relationshipDistribution = Object.fromEntries(
      Object.entries(Object.groupBy(relationshipPairs, (entry) => entry.category))
        .map(([category, entries]) => [category, entries.length])
    );
    const report = {
      schemaVersion: 2,
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
        freeMemoryBytesAtReport: freemem(),
        constraints
      },
      workloads: {
        relationships: { executionPath: "QueryToolRegistry.calculate_relationship", ...relationshipDistribution },
        importPreview: { executionPath: "parseImport + ImportPlanner.plan", rowsPerFile: 1_000, formats: importFormats }
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
