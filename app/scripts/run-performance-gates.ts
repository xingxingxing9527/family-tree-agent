import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  REQUIRED_RELATIONSHIP_DISTRIBUTION,
  classifyProductionRelationship
} from "./performance-relationship-classification.js";
export { REQUIRED_RELATIONSHIP_DISTRIBUTION, classifyProductionRelationship } from "./performance-relationship-classification.js";

export const PERFORMANCE_GATES = Object.freeze({
  defaultTreeAndLayoutMs: 2_000,
  viewpointRelabelMs: 500,
  personSearchP95Ms: 500,
  personDetailP95Ms: 500,
  relationshipP95Ms: 1_000,
  treeProjectionP95Ms: 1_000,
  importPreviewMs: 10_000
});

const PERFORMANCE_SOURCE_FILES = [
  "scripts/generate-benchmark-workspace.ts",
  "scripts/performance-relationship-classification.ts",
  "scripts/run-performance-gates-constrained.ps1",
  "scripts/run-performance-gates.ts",
  "src/main/application/import/import-planner.ts",
  "src/main/application/import/workbook-parser.ts",
  "src/main/application/query/persisted-kinship-facts.ts",
  "src/main/application/query/query-tool-registry.ts",
  "src/main/application/query/workspace-projection.ts",
  "src/main/domain/kinship/conflict-annotation.ts",
  "src/main/domain/kinship/path-search.ts",
  "src/main/domain/kinship/relationship-calculator.ts",
  "src/renderer/src/features/tree/layout-with-elk.ts"
] as const;


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

async function performanceSourceEvidence(commit: string | null): Promise<{
  commit: string | null;
  digestSha256: string;
  files: Array<{ path: string; sha256: string }>;
}> {
  const files = await Promise.all(PERFORMANCE_SOURCE_FILES.map(async (path) => ({
    path,
    sha256: createHash("sha256").update(await readFile(resolve(path))).digest("hex")
  })));
  const digestSha256 = createHash("sha256")
    .update(files.map(({ path, sha256 }) => `${path}:${sha256}\n`).join(""))
    .digest("hex");
  return { commit, digestSha256, files };
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
  const blueprint = buildBenchmarkBlueprint(BENCHMARK_SEED);
  const externalIdByPersonId = new Map(blueprint.people.map((person, index) => [person.id, rows[index]!.person_external_id]));
  const parentSheet = workbook.addWorksheet("ParentChild");
  parentSheet.addRow([...IMPORT_TEMPLATE_COLUMNS.ParentChild]);
  for (const relation of blueprint.parentChild) parentSheet.addRow([
    externalIdByPersonId.get(relation.parentId),
    externalIdByPersonId.get(relation.childId),
    relation.parentRole
  ]);
  const marriageSheet = workbook.addWorksheet("Marriages");
  marriageSheet.addRow([...IMPORT_TEMPLATE_COLUMNS.Marriages]);
  for (const marriage of blueprint.marriages) marriageSheet.addRow([
    externalIdByPersonId.get(marriage.spouseAId), externalIdByPersonId.get(marriage.spouseBId), marriage.status,
    "", "", "", "", false, "", "", "", "", false
  ]);
  await workbook.xlsx.writeFile(xlsxPath);
  return { csvPath, xlsxPath };
}

export interface PerformanceConstraints {
  logicalCores: number;
  memoryLimitMb: number | null;
  affinityMask: string | null;
  observedHeapLimitBytes: number;
  kernelJob: {
    mechanism: "windows-job-object";
    jobMemoryLimitBytes: number;
    limitFlags: string;
    configuredAndQueried: true;
  } | null;
  constrained: boolean;
}

export function parsePerformanceConstraints(
  environment: NodeJS.ProcessEnv,
  observedHeapLimitBytes: number
): PerformanceConstraints {
  const logicalCoresText = environment.FAMILY_AGENT_PERF_LOGICAL_CORES;
  const memoryLimitText = environment.FAMILY_AGENT_PERF_MEMORY_LIMIT_MB;
  const affinityMask = environment.FAMILY_AGENT_PERF_AFFINITY_MASK;
  const jobMemoryLimitText = environment.FAMILY_AGENT_PERF_JOB_MEMORY_LIMIT_BYTES;
  const jobLimitFlagsText = environment.FAMILY_AGENT_PERF_JOB_LIMIT_FLAGS;
  const jobLimitVerified = environment.FAMILY_AGENT_PERF_JOB_LIMIT_VERIFIED;
  if (!logicalCoresText && !memoryLimitText && !affinityMask && !jobMemoryLimitText && !jobLimitFlagsText && !jobLimitVerified) {
    return {
      logicalCores: cpus().length,
      memoryLimitMb: null,
      affinityMask: null,
      observedHeapLimitBytes,
      kernelJob: null,
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
  let jobMemoryLimitBytes = 0;
  let jobLimitFlags = 0n;
  try {
    jobMemoryLimitBytes = Number(BigInt(jobMemoryLimitText ?? ""));
    jobLimitFlags = BigInt(jobLimitFlagsText ?? "");
  } catch {
    jobMemoryLimitBytes = 0;
    jobLimitFlags = 0n;
  }
  const requiredJobFlags = 0x0000_0200n | 0x0000_2000n;
  if (
    jobLimitVerified !== "true"
    || !Number.isSafeInteger(jobMemoryLimitBytes)
    || jobMemoryLimitBytes <= 0
    || jobMemoryLimitBytes > 8_192 * 1024 * 1024
    || jobMemoryLimitBytes !== memoryLimitMb * 1024 * 1024
    || (jobLimitFlags & requiredJobFlags) !== requiredJobFlags
  ) {
    throw new Error("Constrained performance evidence requires a queried kernel Windows Job Object memory cap with JOB_MEMORY and KILL_ON_JOB_CLOSE flags");
  }
  if (observedHeapLimitBytes > jobMemoryLimitBytes) {
    throw new Error("Constrained performance evidence observed heap exceeds 8192 MiB");
  }
  return {
    logicalCores,
    memoryLimitMb,
    affinityMask: affinityMask!,
    observedHeapLimitBytes,
    kernelJob: {
      mechanism: "windows-job-object",
      jobMemoryLimitBytes,
      limitFlags: jobLimitFlagsText!,
      configuredAndQueried: true
    },
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
    const treeProjectionSamples = measureSync(Array.from({ length: 20 }, (_, index) => index), () => {
      projectWorkspaceTree(database, workspaceId, { view: "full", collapseDepth: 4 });
    });
    process.stdout.write("[performance] 20 tree projections measured\n");

    const viewpointId = blueprint.people[0]!.id;
    projectWorkspaceTree(database, workspaceId, { view: "full", collapseDepth: 4, viewpointId });
    const viewpointSamples = measureSync(Array.from({ length: 5 }, (_, index) => index), () => {
      projectWorkspaceTree(database, workspaceId, { view: "full", collapseDepth: 4, viewpointId });
    });
    process.stdout.write("[performance] viewpoint relabel measured\n");

    const registry = new QueryToolRegistry(database, workspaceId);
    const searchQueries = blueprint.people.slice(0, 200).map((person) => person.displayName);
    registry.tools.search_people({ query: searchQueries[0]!, limit: 20 });
    const personSearchSamples = measureSync(searchQueries, (query) => registry.tools.search_people({ query, limit: 20 }));
    process.stdout.write("[performance] 200 person searches measured\n");
    const personIds = blueprint.people.slice(0, 200).map((person) => person.id);
    registry.tools.get_person({ personId: personIds[0]! });
    const personDetailSamples = measureSync(personIds, (personId) => registry.tools.get_person({ personId }));
    process.stdout.write("[performance] 200 person details measured\n");

    const relationshipPairs = buildFixedRelationshipPairs(blueprint);
    registry.tools.calculate_relationship({
      viewpointId: relationshipPairs[0]!.viewpointId,
      targetId: relationshipPairs[0]!.targetId
    });
    const timedRelationshipResults: Array<{
      declared: BenchmarkRelationshipPair["category"];
      result: ReturnType<typeof registry.tools.calculate_relationship>;
    }> = [];
    const relationshipSamples = measureSync(relationshipPairs, ({ category, viewpointId, targetId }) => {
      const result = registry.tools.calculate_relationship({ viewpointId, targetId });
      timedRelationshipResults.push({ declared: category, result });
      return result;
    });
    const observedRelationshipCategories = timedRelationshipResults.map(({ declared, result }) => {
      const observed = classifyProductionRelationship(result);
      if (observed !== declared) {
        throw new Error(`Timed relationship workload changed class: declared=${declared}, observed=${observed}`);
      }
      return observed;
    });
    const relationshipDistribution = Object.fromEntries(
      Object.entries(Object.groupBy(observedRelationshipCategories, (category) => category))
        .map(([category, entries]) => [category, entries.length])
    );
    for (const [category, expected] of Object.entries(REQUIRED_RELATIONSHIP_DISTRIBUTION)) {
      if (relationshipDistribution[category] !== expected) {
        throw new Error(`Timed production relationship distribution changed for ${category}`);
      }
    }
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
      personSearchP95: gate(personSearchSamples, PERFORMANCE_GATES.personSearchP95Ms),
      personDetailP95: gate(personDetailSamples, PERFORMANCE_GATES.personDetailP95Ms),
      relationshipP95: gate(relationshipSamples, PERFORMANCE_GATES.relationshipP95Ms),
      treeProjectionP95: gate(treeProjectionSamples, PERFORMANCE_GATES.treeProjectionP95Ms),
      importPreview: gate(importSamples, PERFORMANCE_GATES.importPreviewMs)
    };
    const cpuInfo = cpus();
    const constraints = parsePerformanceConstraints(process.env, getHeapStatistics().heap_size_limit);
    const sourceCommit = process.env.FAMILY_AGENT_PERF_SOURCE_COMMIT ?? null;
    if (constraints.constrained && !sourceCommit?.match(/^[0-9a-f]{40}$/)) {
      throw new Error("Constrained performance evidence requires the exact source commit");
    }
    const source = await performanceSourceEvidence(sourceCommit);
    const report = {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      seed: BENCHMARK_SEED,
      source,
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
        personSearch: { executionPath: "QueryToolRegistry.search_people", sampleCount: searchQueries.length, limit: 20 },
        personDetail: { executionPath: "QueryToolRegistry.get_person", sampleCount: personIds.length },
        treeProjection: { executionPath: "projectWorkspaceTree", sampleCount: treeProjectionSamples.length, view: "full", collapseDepth: 4 },
        relationships: {
          executionPath: "QueryToolRegistry.calculate_relationship",
          classification: "selected production result after SQLite materialization",
          blueprintDigestSha256: createHash("sha256").update(JSON.stringify(blueprint)).digest("hex"),
          ...relationshipDistribution
        },
        importPreview: {
          executionPath: "parseImport + ImportPlanner.plan",
          peopleRows: blueprint.people.length,
          parentChildRows: blueprint.parentChild.length,
          marriageRows: blueprint.marriages.length,
          formats: importFormats
        }
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
