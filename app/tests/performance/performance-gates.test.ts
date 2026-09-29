import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_SEED,
  buildBenchmarkBlueprint,
  benchmarkInvariants,
  materializeBenchmarkWorkspace
} from "../../scripts/generate-benchmark-workspace";
import { parseImport } from "../../src/main/application/import/workbook-parser";
import {
  PERFORMANCE_GATES,
  buildFixedRelationshipPairs,
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
    expect(digest(first)).toBe("0464088a8ddbef8f449efb347bc402de0174ea958c075f2ce8119d11f428f953");
  });

  it("contains every required stress shape without binary payloads", () => {
    const blueprint = buildBenchmarkBlueprint(BENCHMARK_SEED);

    expect(benchmarkInvariants(blueprint)).toEqual({
      people: 1000,
      generations: 10,
      lineages: 8,
      divorces: 100,
      remarriedPeople: 100,
      singleParentGroups: 80,
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
      relationshipP95Ms: 300,
      importPreviewMs: 30_000
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

      expect(csv.rows).toHaveLength(1000);
      expect(xlsx.rows).toHaveLength(1000);
      expect(csv.rows[999]?.raw.person_external_id).toBe("import-1000");
      expect(xlsx.rows[999]?.raw.person_external_id).toBe("import-1000");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only an explicit 4-core and at-most-8GB constrained-runner declaration", () => {
    expect(parsePerformanceConstraints({
      FAMILY_AGENT_PERF_LOGICAL_CORES: "4",
      FAMILY_AGENT_PERF_MEMORY_LIMIT_MB: "6144",
      FAMILY_AGENT_PERF_AFFINITY_MASK: "0x0000000f"
    }, 6_442_450_944)).toEqual({
      logicalCores: 4,
      memoryLimitMb: 6144,
      affinityMask: "0x0000000f",
      observedHeapLimitBytes: 6_442_450_944,
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
    }, 9 * 1024 * 1024 * 1024)).toThrow(/observed heap.*8192 MiB/i);
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
      } finally {
        workspace.database.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
