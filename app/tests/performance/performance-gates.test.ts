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
import { PERFORMANCE_GATES, buildFixedRelationshipPairs } from "../../scripts/run-performance-gates";

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("1000-person beta performance fixture", () => {
  it("is deterministic for the reviewed seed", () => {
    const first = buildBenchmarkBlueprint(BENCHMARK_SEED);
    const second = buildBenchmarkBlueprint(BENCHMARK_SEED);

    expect(BENCHMARK_SEED).toBe(20260916);
    expect(digest(first)).toBe(digest(second));
    expect(digest(first)).toBe("62b2a9726f28833163cffb616bb280e7393e3deecc4e9f687b0a074f3b72cc04");
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

  it("keeps hard gates and the fixed relationship sample explicit", () => {
    const blueprint = buildBenchmarkBlueprint(BENCHMARK_SEED);

    expect(PERFORMANCE_GATES).toEqual({
      defaultTreeAndLayoutMs: 2000,
      viewpointRelabelMs: 500,
      relationshipP95Ms: 300,
      importPreviewMs: 30_000
    });
    const pairs = buildFixedRelationshipPairs(blueprint);
    expect(pairs).toHaveLength(200);
    expect(new Set(pairs.map(([from, to]) => `${from}:${to}`)).size).toBe(200);
    expect(buildFixedRelationshipPairs(blueprint)).toEqual(pairs);
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
