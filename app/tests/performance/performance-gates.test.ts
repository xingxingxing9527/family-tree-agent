import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_SEED,
  buildBenchmarkBlueprint,
  benchmarkInvariants,
  materializeBenchmarkWorkspace
} from "../../scripts/generate-benchmark-workspace";
import { parseImport } from "../../src/main/application/import/workbook-parser";
import { FactQueries } from "../../src/main/application/facts/fact-queries";
import { QueryToolRegistry } from "../../src/main/application/query/query-tool-registry";
import { ParentCompletionService } from "../../src/main/application/relations/parent-completion-service";
import {
  PERFORMANCE_GATES,
  REQUIRED_RELATIONSHIP_DISTRIBUTION,
  SCOPED_TREE_PROJECTION_WORKLOAD,
  buildFixedRelationshipPairs,
  classifyProductionRelationship,
  parsePerformanceConstraints,
  writeBenchmarkImportFiles
} from "../../scripts/run-performance-gates";

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("1000-person beta performance fixture", () => {
  it("is deterministic for the reviewed seed", () => {
    const first = buildBenchmarkBlueprint(BENCHMARK_SEED);
    const second = buildBenchmarkBlueprint(BENCHMARK_SEED);

    expect(BENCHMARK_SEED).toBe(20260916);
    expect(digest(first)).toBe(digest(second));
    expect(digest(first)).toBe("32a512d5c3a10824ffd300f73155eff8776defb3c7db9adfd0a9cdd93b23ae1d");
  });

  it("contains every required stress shape without binary payloads", () => {
    const blueprint = buildBenchmarkBlueprint(BENCHMARK_SEED);

    expect(benchmarkInvariants(blueprint)).toEqual({
      people: 1000,
      generations: 10,
      lineages: 8,
      divorces: 108,
      remarriedPeople: 100,
      singleParentGroups: 80,
      parentCompletionCandidateChildren: 80,
      repeatedParentCompletionMarriageEpisodes: 16,
      unmarriedCoParentGroups: 128,
      aliases: 250,
      wikiEntries: 80,
      mediaMetadata: 100,
      mediaPayloadBytes: 0
    });
    expect(new Set(blueprint.people.map(({ id }) => id)).size).toBe(1000);
  });

  it("keeps hard gates and a representative fixed relationship sample explicit", () => {
    const blueprint = buildBenchmarkBlueprint(BENCHMARK_SEED);

    expect(PERFORMANCE_GATES).toEqual({
      defaultTreeAndLayoutMs: 2000,
      viewpointRelabelMs: 500,
      personSearchP95Ms: 500,
      personDetailP95Ms: 500,
      relationshipP95Ms: 1000,
      treeProjectionP95Ms: 1000,
      scopedTreeProjectionP95Ms: 1000,
      parentCompletionScanP95Ms: 1000,
      importPreviewMs: 10_000
    });
    expect(SCOPED_TREE_PROJECTION_WORKLOAD).toEqual({
      views: ["core", "descendants"],
      sampleCount: 20
    });
    const pairs = buildFixedRelationshipPairs(blueprint);
    expect(pairs).toHaveLength(200);
    expect(Object.fromEntries(Object.entries(Object.groupBy(pairs, (entry) => entry.category)).map(([category, entries]) => [category, entries.length]))).toEqual({
      direct: 30,
      ancestor: 25,
      collateral: 30,
      cousin: 25,
      affinity: 30,
      multipath: 25,
      conflict: 15,
      missing: 20
    });
    expect(new Set(pairs.map(({ viewpointId, targetId }) => `${viewpointId}:${targetId}`)).size).toBe(200);
    expect(buildFixedRelationshipPairs(blueprint)).toEqual(pairs);

    const parentPairs = new Set(blueprint.parentChild.flatMap((entry) => [
      `${entry.parentId}:${entry.childId}`,
      `${entry.childId}:${entry.parentId}`
    ]));
    const activeMarriagePairs = new Set(blueprint.marriages
      .filter((entry) => entry.status === "active")
      .flatMap((entry) => [`${entry.spouseAId}:${entry.spouseBId}`, `${entry.spouseBId}:${entry.spouseAId}`]));
    const parentsByChild = new Map<string, Set<string>>();
    for (const entry of blueprint.parentChild) {
      const parents = parentsByChild.get(entry.childId) ?? new Set<string>();
      parents.add(entry.parentId);
      parentsByChild.set(entry.childId, parents);
    }
    const sharedParents = (left: string, right: string): string[] => [
      ...(parentsByChild.get(left) ?? new Set<string>())
    ].filter((parentId) => parentsByChild.get(right)?.has(parentId));
    const hasGrandparentPath = (from: string, to: string): boolean => [...(parentsByChild.get(from) ?? [])]
      .some((parentId) => parentsByChild.get(parentId)?.has(to));
    const areCousins = (left: string, right: string): boolean => {
      if (sharedParents(left, right).length > 0) return false;
      return [...(parentsByChild.get(left) ?? [])].some((leftParent) =>
        [...(parentsByChild.get(right) ?? [])].some((rightParent) => sharedParents(leftParent, rightParent).length > 0));
    };
    const hasAffinityPath = (from: string, to: string): boolean => blueprint.marriages
      .filter((entry) => entry.status === "active" && (entry.spouseAId === from || entry.spouseBId === from))
      .some((entry) => {
        const spouseId = entry.spouseAId === from ? entry.spouseBId : entry.spouseAId;
        return parentPairs.has(`${spouseId}:${to}`);
      });

    for (const pair of pairs) {
      const key = `${pair.viewpointId}:${pair.targetId}`;
      if (pair.category === "direct") expect(parentPairs.has(key) || activeMarriagePairs.has(key), key).toBe(true);
      if (pair.category === "ancestor") expect(hasGrandparentPath(pair.viewpointId, pair.targetId), key).toBe(true);
      if (pair.category === "collateral") expect(sharedParents(pair.viewpointId, pair.targetId).length, key).toBeGreaterThanOrEqual(1);
      if (pair.category === "cousin") expect(areCousins(pair.viewpointId, pair.targetId), key).toBe(true);
      if (pair.category === "affinity") expect(hasAffinityPath(pair.viewpointId, pair.targetId), key).toBe(true);
      if (pair.category === "multipath") expect(sharedParents(pair.viewpointId, pair.targetId).length, key).toBeGreaterThanOrEqual(2);
      if (pair.category === "conflict") expect(parentPairs.has(key) && activeMarriagePairs.has(key), key).toBe(true);
      if (pair.category === "missing") {
        expect(blueprint.people.find((entry) => entry.id === pair.viewpointId)?.lineageId, key).not.toBe(
          blueprint.people.find((entry) => entry.id === pair.targetId)?.lineageId
        );
      }
    }
  });

  it("writes real deterministic 1000-row CSV and XLSX inputs accepted by the production parser", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-import-performance-test-"));
    try {
      const files = await writeBenchmarkImportFiles(root);
      const csv = await parseImport(files.csvPath, "benchmark-test-csv", { csvEntityType: "People" });
      const xlsx = await parseImport(files.xlsxPath, "benchmark-test-xlsx");
      const blueprint = buildBenchmarkBlueprint(BENCHMARK_SEED);

      expect(csv.rows).toHaveLength(1000);
      expect(xlsx.rows.filter((row) => row.sheet === "People")).toHaveLength(1000);
      expect(xlsx.rows.filter((row) => row.sheet === "ParentChild")).toHaveLength(blueprint.parentChild.length);
      expect(xlsx.rows.filter((row) => row.sheet === "Marriages")).toHaveLength(blueprint.marriages.length);
      expect(csv.rows[999]?.raw.person_external_id).toBe("import-1000");
      expect(xlsx.rows[999]?.raw.person_external_id).toBe("import-1000");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only a queried Windows Job Object cap plus the explicit four-core constraint", () => {
    expect(parsePerformanceConstraints({
      FAMILY_AGENT_PERF_LOGICAL_CORES: "4",
      FAMILY_AGENT_PERF_MEMORY_LIMIT_MB: "8192",
      FAMILY_AGENT_PERF_AFFINITY_MASK: "0x0000000f",
      FAMILY_AGENT_PERF_JOB_MEMORY_LIMIT_BYTES: String(8 * 1024 * 1024 * 1024),
      FAMILY_AGENT_PERF_JOB_LIMIT_FLAGS: "0x00002200",
      FAMILY_AGENT_PERF_JOB_LIMIT_VERIFIED: "true"
    }, 6_442_450_944)).toEqual({
      logicalCores: 4,
      memoryLimitMb: 8192,
      affinityMask: "0x0000000f",
      observedHeapLimitBytes: 6_442_450_944,
      kernelJob: {
        mechanism: "windows-job-object",
        jobMemoryLimitBytes: 8 * 1024 * 1024 * 1024,
        limitFlags: "0x00002200",
        configuredAndQueried: true
      },
      constrained: true
    });
    expect(() => parsePerformanceConstraints({
      FAMILY_AGENT_PERF_LOGICAL_CORES: "8",
      FAMILY_AGENT_PERF_MEMORY_LIMIT_MB: "16384",
      FAMILY_AGENT_PERF_AFFINITY_MASK: "0xff"
    }, 12_000_000_000)).toThrow(/4 logical cores.*8192 MiB/i);
    expect(() => parsePerformanceConstraints({
      FAMILY_AGENT_PERF_LOGICAL_CORES: "4",
      FAMILY_AGENT_PERF_MEMORY_LIMIT_MB: "6144",
      FAMILY_AGENT_PERF_AFFINITY_MASK: "0x0000000f"
    }, 6_000_000_000)).toThrow(/kernel.*Job Object/i);
    expect(() => parsePerformanceConstraints({
      FAMILY_AGENT_PERF_LOGICAL_CORES: "4",
      FAMILY_AGENT_PERF_MEMORY_LIMIT_MB: "8192",
      FAMILY_AGENT_PERF_AFFINITY_MASK: "0x0000000f",
      FAMILY_AGENT_PERF_JOB_MEMORY_LIMIT_BYTES: String(8 * 1024 * 1024 * 1024),
      FAMILY_AGENT_PERF_JOB_LIMIT_FLAGS: "0x00002200",
      FAMILY_AGENT_PERF_JOB_LIMIT_VERIFIED: "true"
    }, 9 * 1024 * 1024 * 1024)).toThrow(/observed heap.*8192 MiB/i);
  });

  it("uses a kernel Job Object wrapper that queries its cap and records peak job memory", async () => {
    const wrapper = await readFile(resolve("scripts/run-performance-gates-constrained.ps1"), "utf8");

    expect(wrapper).toContain("JOB_OBJECT_LIMIT_JOB_MEMORY");
    expect(wrapper).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(wrapper).toContain("SetInformationJobObject");
    expect(wrapper).toContain("QueryInformationJobObject");
    expect(wrapper).toContain("AssignProcessToJobObject");
    expect(wrapper).toContain("PeakJobMemoryUsed");
    expect(wrapper).toContain("peakProcessCommitBytes");
  });

  it("materializes every blueprint shape in an isolated migrated database", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-benchmark-test-"));
    try {
      const workspace = await materializeBenchmarkWorkspace(join(root, "workspace"), BENCHMARK_SEED);
      try {
        const count = (table: string): number => Number((workspace.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
        expect(count("person")).toBe(1000);
        expect(count("lineage")).toBe(8);
        expect(count("wiki_entry")).toBe(80);
        expect(count("media_asset")).toBe(100);

        const registry = new QueryToolRegistry(workspace.database, workspace.blueprint.workspaceId);
        const classified = buildFixedRelationshipPairs(workspace.blueprint).map((pair) => {
          const result = registry.tools.calculate_relationship({
            viewpointId: pair.viewpointId,
            targetId: pair.targetId
          });
          const category = classifyProductionRelationship(result);
          expect(category, `${pair.category}:${pair.viewpointId}->${pair.targetId}`).toBe(pair.category);
          if (category === "affinity") expect(result.signature.bloodAffinity).toBe("currentAffinity");
          if (category === "multipath") {
            expect(result.alternatives.length).toBeGreaterThan(0);
            expect(result.alternatives.every((alternative) =>
              alternative.signature.pathRelationIds.length === result.signature.pathRelationIds.length
            )).toBe(true);
          }
          if (category === "missing") {
            expect(result.signature.pathRelationIds).toEqual([]);
            expect(result.uncertainty).toContain("未找到可用关系路径");
          }
          if (category === "conflict") {
            expect(result.primaryTerm).toBeNull();
            expect(result.uncertainty.some((entry) => entry.startsWith("数据冲突："))).toBe(true);
          }
          return category;
        });
        expect(Object.fromEntries(Object.entries(Object.groupBy(classified, (category) => category))
          .map(([category, entries]) => [category, entries.length]))).toEqual(REQUIRED_RELATIONSHIP_DISTRIBUTION);
      } finally {
        workspace.database.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("scans the fixed 1000-person fixture six times with a stable digest and zero persistent writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-parent-completion-performance-test-"));
    try {
      const workspace = await materializeBenchmarkWorkspace(join(root, "workspace"), BENCHMARK_SEED);
      try {
        const criticalTables = ["person", "parent_child", "marriage", "source", "operation_group", "audit_log"] as const;
        const snapshot = (): Record<string, { count: number; digestSha256: string }> => Object.fromEntries(
          criticalTables.map((table) => {
            const rows = workspace.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
            return [table, { count: rows.length, digestSha256: digest(rows) }];
          })
        );
        const before = snapshot();
        const service = new ParentCompletionService(new FactQueries(workspace.database, workspace.blueprint.workspaceId));
        const warm = service.scan();
        const warmDigest = digest(warm);
        const samples: number[] = [];
        const measuredDigests: string[] = [];

        for (let index = 0; index < 6; index += 1) {
          const started = performance.now();
          const scan = service.scan();
          samples.push(performance.now() - started);
          measuredDigests.push(digest(scan));
        }

        const sorted = [...samples].sort((left, right) => left - right);
        const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
        expect(warm.counts).toEqual({ total: 80, safe: 80, ambiguous: 0, noCandidate: 0, conflict: 0 });
        expect(warm.items).toHaveLength(80);
        expect(warm.items.every(({ plan }) => plan.candidates.length === 1 && plan.candidates[0]!.marriageEpisodes.length === 2)).toBe(true);
        expect(new Set(measuredDigests)).toEqual(new Set([warmDigest]));
        expect(samples).toHaveLength(6);
        expect(p95).toBeLessThan(1_000);
        expect(snapshot()).toEqual(before);
      } finally {
        workspace.database.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
