import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyMigrations } from "../src/main/database/migrations/index.js";
import { openDatabase, type WorkspaceDatabase } from "../src/main/database/open-database.js";

export const BENCHMARK_SEED = 20260916;
export const BENCHMARK_WORKSPACE_ID = "b0000000-0000-4000-8000-000020260916";

interface BenchmarkPerson {
  id: string;
  displayName: string;
  gender: "male" | "female" | "unknown";
  birthYear: number;
  birthMonth: number;
  lineageId: string;
  generation: number;
}

interface BenchmarkParentChild {
  id: string;
  parentId: string;
  childId: string;
  parentRole: "father" | "mother";
  familyShape: "singleParent" | "unmarriedCoParents" | "marriedParents";
}

interface BenchmarkMarriage {
  id: string;
  spouseAId: string;
  spouseBId: string;
  status: "active" | "divorced";
  remarriageAnchorId: string | null;
}

interface BenchmarkLineage {
  id: string;
  name: string;
  founderPersonId: string;
}

export type BenchmarkRelationshipCategory =
  | "direct"
  | "ancestor"
  | "collateral"
  | "cousin"
  | "affinity"
  | "multipath"
  | "conflict"
  | "missing";

export interface BenchmarkRelationshipPair {
  category: BenchmarkRelationshipCategory;
  viewpointId: string;
  targetId: string;
}

export interface BenchmarkBlueprint {
  seed: number;
  workspaceId: string;
  people: BenchmarkPerson[];
  aliases: Array<{ id: string; personId: string; name: string }>;
  parentChild: BenchmarkParentChild[];
  marriages: BenchmarkMarriage[];
  lineages: BenchmarkLineage[];
  wikiEntries: Array<{ id: string; personId: string; slug: string; title: string; content: string }>;
  media: Array<{
    id: string;
    personId: string;
    sha256: string;
    originalName: string;
    relativePath: string;
    metadata: Record<string, unknown>;
    payloadBytes: 0;
  }>;
  relationshipPairs: BenchmarkRelationshipPair[];
}

export interface BenchmarkWorkspace {
  root: string;
  databasePath: string;
  database: WorkspaceDatabase;
  blueprint: BenchmarkBlueprint;
}

const LINEAGE_COUNT = 8;
const PEOPLE_PER_LINEAGE = 125;
const GENERATION_SIZE = 13;
const FIXED_NOW = "2026-09-16T00:00:00.000Z";

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function stableId(namespace: number, index: number): string {
  return `${namespace.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join(":");
}

export function buildBenchmarkBlueprint(seed = BENCHMARK_SEED): BenchmarkBlueprint {
  const random = xorshift32(seed);
  const lineages: BenchmarkLineage[] = [];
  const people: BenchmarkPerson[] = [];

  for (let lineageIndex = 0; lineageIndex < LINEAGE_COUNT; lineageIndex += 1) {
    const lineageId = stableId(0x11000000, lineageIndex + 1);
    const start = lineageIndex * PEOPLE_PER_LINEAGE;
    for (let localIndex = 0; localIndex < PEOPLE_PER_LINEAGE; localIndex += 1) {
      const generation = Math.floor(localIndex / GENERATION_SIZE) + 1;
      const position = localIndex % GENERATION_SIZE;
      const globalIndex = start + localIndex;
      people.push({
        id: stableId(0x22000000, globalIndex + 1),
        displayName: `基准-${lineageIndex + 1}-${generation}-${position + 1}-${Math.floor(random() * 10_000).toString().padStart(4, "0")}`,
        gender: position === 0 ? "male" : position === 1 ? "female" : globalIndex % 11 === 0 ? "unknown" : globalIndex % 2 === 0 ? "male" : "female",
        birthYear: 1780 + generation * 24 + Math.floor(random() * 5),
        birthMonth: 1 + Math.floor(random() * 12),
        lineageId,
        generation
      });
    }
    lineages.push({
      id: lineageId,
      name: `基准支系 ${lineageIndex + 1}`,
      founderPersonId: people[start]!.id
    });
  }

  const aliases = people.slice(0, 250).map((person, index) => ({
    id: stableId(0x33000000, index + 1),
    personId: person.id,
    name: `别名-${index + 1}-${Math.floor(random() * 10_000).toString().padStart(4, "0")}`
  }));

  const parentChild: BenchmarkParentChild[] = [];
  const normalMarriagePairs = new Map<string, [string, string]>();
  let relationIndex = 0;
  for (let lineageIndex = 0; lineageIndex < LINEAGE_COUNT; lineageIndex += 1) {
    const start = lineageIndex * PEOPLE_PER_LINEAGE;
    let descendantOrdinal = 0;
    for (let localIndex = GENERATION_SIZE; localIndex < PEOPLE_PER_LINEAGE; localIndex += 1) {
      const child = people[start + localIndex]!;
      const generationStart = Math.floor(localIndex / GENERATION_SIZE) * GENERATION_SIZE;
      const priorGenerationStart = generationStart - GENERATION_SIZE;
      const father = people[start + priorGenerationStart]!;
      const mother = people[start + priorGenerationStart + 1]!;
      const familyShape = descendantOrdinal < 10
        ? "singleParent"
        : descendantOrdinal < 30
          ? "unmarriedCoParents"
          : "marriedParents";
      parentChild.push({
        id: stableId(0x44000000, ++relationIndex),
        parentId: father.id,
        childId: child.id,
        parentRole: "father",
        familyShape
      });
      if (familyShape !== "singleParent") {
        parentChild.push({
          id: stableId(0x44000000, ++relationIndex),
          parentId: mother.id,
          childId: child.id,
          parentRole: "mother",
          familyShape
        });
      }
      if (familyShape === "marriedParents") normalMarriagePairs.set(pairKey(father.id, mother.id), [father.id, mother.id]);
      descendantOrdinal += 1;
    }
  }

  const marriages: BenchmarkMarriage[] = [];
  let marriageIndex = 0;
  for (const [spouseAId, spouseBId] of [...normalMarriagePairs.values()].sort(([left], [right]) => left.localeCompare(right))) {
    marriages.push({
      id: stableId(0x55000000, ++marriageIndex),
      spouseAId,
      spouseBId,
      status: "active",
      remarriageAnchorId: null
    });
  }

  const nonParentPeople = people.filter((_, globalIndex) => globalIndex % PEOPLE_PER_LINEAGE % GENERATION_SIZE >= 2);
  const anchors = nonParentPeople.slice(0, 100);
  const formerSpouses = nonParentPeople.slice(100, 200);
  const currentSpouses = nonParentPeople.slice(200, 300);
  anchors.forEach((anchor, index) => {
    const former = formerSpouses[index]!;
    const current = currentSpouses[index]!;
    marriages.push({
      id: stableId(0x55000000, ++marriageIndex),
      spouseAId: anchor.id,
      spouseBId: former.id,
      status: "divorced",
      remarriageAnchorId: anchor.id
    });
    marriages.push({
      id: stableId(0x55000000, ++marriageIndex),
      spouseAId: anchor.id,
      spouseBId: current.id,
      status: "active",
      remarriageAnchorId: anchor.id
    });
  });

  // Add a deterministic, internally contained probe topology. Each lineage gets
  // two sibling parent couples with five children apiece, providing real cousin
  // and multipath paths without changing the required single-parent or unmarried
  // co-parent counts.
  const cousinCandidates: Array<readonly [string, string]> = [];
  for (let lineageIndex = 0; lineageIndex < LINEAGE_COUNT; lineageIndex += 1) {
    const start = lineageIndex * PEOPLE_PER_LINEAGE;
    const branchAFather = people[start + 26]!;
    const branchAMother = people[start + 27]!;
    const branchBFather = people[start + 28]!;
    const branchBMother = people[start + 29]!;
    for (const [spouseAId, spouseBId] of [
      [branchAFather.id, branchAMother.id],
      [branchBFather.id, branchBMother.id]
    ] as const) {
      if (marriages.some((entry) => pairKey(entry.spouseAId, entry.spouseBId) === pairKey(spouseAId, spouseBId))) continue;
      marriages.push({
        id: stableId(0x55000000, ++marriageIndex),
        spouseAId,
        spouseBId,
        status: "active",
        remarriageAnchorId: null
      });
    }
    const branchAChildren = people.slice(start + 2, start + 7);
    const branchBChildren = people.slice(start + 7, start + 12);
    for (const child of branchAChildren) {
      parentChild.push({
        id: stableId(0x44000000, ++relationIndex),
        parentId: branchAFather.id,
        childId: child.id,
        parentRole: "father",
        familyShape: "marriedParents"
      }, {
        id: stableId(0x44000000, ++relationIndex),
        parentId: branchAMother.id,
        childId: child.id,
        parentRole: "mother",
        familyShape: "marriedParents"
      });
    }
    for (const child of branchBChildren) {
      parentChild.push({
        id: stableId(0x44000000, ++relationIndex),
        parentId: branchBFather.id,
        childId: child.id,
        parentRole: "father",
        familyShape: "marriedParents"
      }, {
        id: stableId(0x44000000, ++relationIndex),
        parentId: branchBMother.id,
        childId: child.id,
        parentRole: "mother",
        familyShape: "marriedParents"
      });
    }
    for (const left of branchAChildren) {
      for (const right of branchBChildren) cousinCandidates.push([left.id, right.id]);
    }
  }

  // These pairs deliberately carry incompatible direct facts (parent/child and
  // active spouses) so the production query path is timed against conflict-shaped
  // data instead of a synthetic calculator-only fixture.
  const conflictCandidates: Array<readonly [string, string]> = [];
  const occupiedMarriagePairs = new Set(marriages.map((entry) => pairKey(entry.spouseAId, entry.spouseBId)));
  for (const relation of parentChild) {
    if (conflictCandidates.length >= 16) break;
    const key = pairKey(relation.parentId, relation.childId);
    if (occupiedMarriagePairs.has(key)) continue;
    occupiedMarriagePairs.add(key);
    marriages.push({
      id: stableId(0x55000000, ++marriageIndex),
      spouseAId: relation.parentId,
      spouseBId: relation.childId,
      status: "active",
      remarriageAnchorId: null
    });
    conflictCandidates.push([relation.parentId, relation.childId], [relation.childId, relation.parentId]);
  }

  const usedRelationshipPairs = new Set<string>();
  const relationshipPairs: BenchmarkRelationshipPair[] = [];
  const select = (
    category: BenchmarkRelationshipCategory,
    candidates: ReadonlyArray<readonly [string, string]>,
    count: number
  ): void => {
    for (const [viewpointId, targetId] of candidates) {
      const key = `${viewpointId}:${targetId}`;
      if (viewpointId === targetId || usedRelationshipPairs.has(key)) continue;
      usedRelationshipPairs.add(key);
      relationshipPairs.push({ category, viewpointId, targetId });
      if (relationshipPairs.filter((entry) => entry.category === category).length === count) return;
    }
    throw new Error(`Benchmark relationship category ${category} has fewer than ${count} candidates`);
  };
  const orderedPairs = (pairs: ReadonlyArray<readonly [string, string]>): Array<readonly [string, string]> =>
    [...pairs].sort(([leftA, leftB], [rightA, rightB]) => leftA.localeCompare(rightA) || leftB.localeCompare(rightB));
  const conflictKeys = new Set(conflictCandidates.map(([left, right]) => `${left}:${right}`));
  const directCandidates = orderedPairs([
    ...parentChild.flatMap((entry) => [
      [entry.parentId, entry.childId] as const,
      [entry.childId, entry.parentId] as const
    ]),
    ...marriages.filter((entry) => entry.status === "active").flatMap((entry) => [
      [entry.spouseAId, entry.spouseBId] as const,
      [entry.spouseBId, entry.spouseAId] as const
    ])
  ].filter(([left, right]) => !conflictKeys.has(`${left}:${right}`)));

  const parentsByChild = new Map<string, string[]>();
  const childrenByParent = new Map<string, string[]>();
  for (const relation of parentChild) {
    parentsByChild.set(relation.childId, [...(parentsByChild.get(relation.childId) ?? []), relation.parentId]);
    childrenByParent.set(relation.parentId, [...(childrenByParent.get(relation.parentId) ?? []), relation.childId]);
  }
  const ancestorCandidates: Array<readonly [string, string]> = [];
  for (const [childId, parentIds] of parentsByChild) {
    for (const parentId of parentIds) {
      for (const grandparentId of parentsByChild.get(parentId) ?? []) ancestorCandidates.push([childId, grandparentId]);
    }
  }
  const collateralCandidates: Array<readonly [string, string]> = [];
  for (const childIds of childrenByParent.values()) {
    for (let left = 0; left < childIds.length; left += 1) {
      for (let right = left + 1; right < childIds.length; right += 1) {
        const shared = (parentsByChild.get(childIds[left]!) ?? []).filter((id) => parentsByChild.get(childIds[right]!)?.includes(id));
        if (shared.length !== 1) continue;
        collateralCandidates.push([childIds[left]!, childIds[right]!], [childIds[right]!, childIds[left]!]);
      }
    }
  }
  const multipathCandidates: Array<readonly [string, string]> = [];
  const allPeopleIds = [...parentsByChild.keys()].sort();
  for (let left = 0; left < allPeopleIds.length; left += 1) {
    for (let right = left + 1; right < allPeopleIds.length; right += 1) {
      const shared = (parentsByChild.get(allPeopleIds[left]!) ?? []).filter((id) => parentsByChild.get(allPeopleIds[right]!)?.includes(id));
      if (shared.length < 2) continue;
      multipathCandidates.push(
        [allPeopleIds[left]!, allPeopleIds[right]!],
        [allPeopleIds[right]!, allPeopleIds[left]!]
      );
    }
  }
  const adjacencyByPerson = new Map<string, string[]>();
  for (const relation of parentChild) {
    adjacencyByPerson.set(relation.parentId, [...(adjacencyByPerson.get(relation.parentId) ?? []), relation.childId]);
    adjacencyByPerson.set(relation.childId, [...(adjacencyByPerson.get(relation.childId) ?? []), relation.parentId]);
  }
  const affinityCandidates: Array<readonly [string, string]> = [];
  for (const marriage of marriages.filter((entry) => entry.status === "active")) {
    for (const targetId of adjacencyByPerson.get(marriage.spouseBId) ?? []) affinityCandidates.push([marriage.spouseAId, targetId]);
    for (const targetId of adjacencyByPerson.get(marriage.spouseAId) ?? []) affinityCandidates.push([marriage.spouseBId, targetId]);
  }
  const missingCandidates: Array<readonly [string, string]> = [];
  const missingLeft = people.slice(6 * PEOPLE_PER_LINEAGE, 7 * PEOPLE_PER_LINEAGE);
  const missingRight = people.slice(7 * PEOPLE_PER_LINEAGE, 8 * PEOPLE_PER_LINEAGE);
  for (let index = 0; index < 20; index += 1) missingCandidates.push([missingLeft[80 + index]!.id, missingRight[80 + index]!.id]);

  select("direct", directCandidates, 30);
  select("ancestor", orderedPairs(ancestorCandidates), 25);
  select("collateral", orderedPairs(collateralCandidates), 30);
  select("cousin", orderedPairs(cousinCandidates), 25);
  select("affinity", orderedPairs(affinityCandidates), 30);
  select("multipath", orderedPairs(multipathCandidates), 25);
  select("conflict", orderedPairs(conflictCandidates), 15);
  select("missing", missingCandidates, 20);

  const wikiEntries = people.slice(0, 80).map((person, index) => ({
    id: stableId(0x66000000, index + 1),
    personId: person.id,
    slug: `benchmark-${index + 1}`,
    title: `基准人物条目 ${index + 1}`,
    content: `离线性能基准资料 ${index + 1}；种子 ${seed}。`
  }));
  const media = people.slice(80, 180).map((person, index) => ({
    id: stableId(0x77000000, index + 1),
    personId: person.id,
    sha256: index.toString(16).padStart(64, "0"),
    originalName: `benchmark-${index + 1}.jpg`,
    relativePath: `media/benchmark-${index + 1}.jpg`,
    metadata: { benchmark: true, seed, ordinal: index + 1 },
    payloadBytes: 0 as const
  }));

  return {
    seed,
    workspaceId: BENCHMARK_WORKSPACE_ID,
    people,
    aliases,
    parentChild,
    marriages,
    lineages,
    wikiEntries,
    media,
    relationshipPairs
  };
}

export function benchmarkInvariants(blueprint: BenchmarkBlueprint): Record<string, number> {
  const parentsByChild = new Map<string, BenchmarkParentChild[]>();
  for (const relation of blueprint.parentChild) {
    const current = parentsByChild.get(relation.childId) ?? [];
    current.push(relation);
    parentsByChild.set(relation.childId, current);
  }
  const marriedPairs = new Set(blueprint.marriages.map((entry) => pairKey(entry.spouseAId, entry.spouseBId)));
  const remarriedPeople = new Set(blueprint.marriages.flatMap((entry) => entry.remarriageAnchorId ? [entry.remarriageAnchorId] : []));
  return {
    people: blueprint.people.length,
    generations: Math.max(...blueprint.people.map(({ generation }) => generation)),
    lineages: blueprint.lineages.length,
    divorces: blueprint.marriages.filter(({ status }) => status === "divorced").length,
    remarriedPeople: remarriedPeople.size,
    singleParentGroups: [...parentsByChild.values()].filter((relations) => relations.length === 1).length,
    unmarriedCoParentGroups: [...parentsByChild.values()].filter((relations) => relations.length === 2 && !marriedPairs.has(pairKey(relations[0]!.parentId, relations[1]!.parentId))).length,
    aliases: blueprint.aliases.length,
    wikiEntries: blueprint.wikiEntries.length,
    mediaMetadata: blueprint.media.length,
    mediaPayloadBytes: blueprint.media.reduce((total, entry) => total + entry.payloadBytes, 0)
  };
}

export async function materializeBenchmarkWorkspace(root: string, seed = BENCHMARK_SEED): Promise<BenchmarkWorkspace> {
  const resolvedRoot = resolve(root);
  await mkdir(resolvedRoot, { recursive: true });
  const databasePath = resolve(resolvedRoot, "benchmark.sqlite");
  const blueprint = buildBenchmarkBlueprint(seed);
  const database = openDatabase(databasePath);
  applyMigrations(database);

  const insert = database.transaction(() => {
    database.prepare("INSERT INTO workspace_meta (workspace_id, name, origin_person_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)")
      .run(blueprint.workspaceId, `性能基准 ${seed}`, FIXED_NOW, FIXED_NOW);

    const person = database.prepare(`INSERT INTO person (
      id, workspace_id, display_name, gender,
      birth_calendar, birth_year, birth_month, birth_day, birth_leap_month, birth_precision,
      notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'solar', ?, ?, NULL, 0, 'month', ?, ?, ?)`);
    for (const entry of blueprint.people) {
      person.run(entry.id, blueprint.workspaceId, entry.displayName, entry.gender, entry.birthYear, entry.birthMonth, `seed=${seed};generation=${entry.generation}`, FIXED_NOW, FIXED_NOW);
    }
    database.prepare("UPDATE workspace_meta SET origin_person_id = ?, row_version = row_version + 1 WHERE workspace_id = ?")
      .run(blueprint.people[0]!.id, blueprint.workspaceId);

    const alias = database.prepare("INSERT INTO person_alias (id, workspace_id, person_id, name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const entry of blueprint.aliases) alias.run(entry.id, blueprint.workspaceId, entry.personId, entry.name, entry.name.toLowerCase(), FIXED_NOW, FIXED_NOW);

    const lineage = database.prepare("INSERT INTO lineage (id, workspace_id, name, founder_person_id, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const entry of blueprint.lineages) lineage.run(entry.id, blueprint.workspaceId, entry.name, entry.founderPersonId, `seed=${seed}`, FIXED_NOW, FIXED_NOW);
    const membership = database.prepare("INSERT INTO lineage_membership (id, workspace_id, lineage_id, person_id, lineage_role, is_primary, declared_generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'blood', 1, ?, ?, ?)");
    blueprint.people.forEach((entry, index) => membership.run(stableId(0x88000000, index + 1), blueprint.workspaceId, entry.lineageId, entry.id, entry.generation, FIXED_NOW, FIXED_NOW));

    const parentChild = database.prepare("INSERT INTO parent_child (id, workspace_id, parent_id, child_id, parent_role, relationship_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'biological', ?, ?)");
    for (const entry of blueprint.parentChild) parentChild.run(entry.id, blueprint.workspaceId, entry.parentId, entry.childId, entry.parentRole, FIXED_NOW, FIXED_NOW);

    const marriage = database.prepare(`INSERT INTO marriage (
      id, workspace_id, spouse_a_id, spouse_b_id, marriage_status,
      start_calendar, start_year, start_month, start_day, start_leap_month, start_precision,
      end_calendar, end_year, end_month, end_day, end_leap_month, end_precision,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'solar', ?, 1, NULL, 0, 'month', ?, ?, ?, NULL, 0, ?, ?, ?)`);
    for (const [index, entry] of blueprint.marriages.entries()) {
      const [spouseAId, spouseBId] = [entry.spouseAId, entry.spouseBId].sort();
      const startYear = 1980 + index % 20;
      const ended = entry.status === "divorced";
      marriage.run(
        entry.id,
        blueprint.workspaceId,
        spouseAId,
        spouseBId,
        entry.status,
        startYear,
        ended ? "solar" : null,
        ended ? startYear + 5 : null,
        ended ? 1 : null,
        ended ? "month" : null,
        FIXED_NOW,
        FIXED_NOW
      );
    }

    const wiki = database.prepare("INSERT INTO wiki_entry (id, workspace_id, slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const wikiPerson = database.prepare("INSERT INTO wiki_person (id, workspace_id, wiki_entry_id, person_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)");
    blueprint.wikiEntries.forEach((entry, index) => {
      wiki.run(entry.id, blueprint.workspaceId, entry.slug, entry.title, entry.content, FIXED_NOW, FIXED_NOW);
      wikiPerson.run(stableId(0x99000000, index + 1), blueprint.workspaceId, entry.id, entry.personId, FIXED_NOW, FIXED_NOW);
    });

    const media = database.prepare("INSERT INTO media_asset (id, workspace_id, sha256, original_name, mime_type, byte_size, relative_path, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'image/jpeg', 0, ?, ?, ?, ?)");
    const mediaPerson = database.prepare("INSERT INTO media_person (id, workspace_id, media_asset_id, person_id, caption, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)");
    blueprint.media.forEach((entry, index) => {
      media.run(entry.id, blueprint.workspaceId, entry.sha256, entry.originalName, entry.relativePath, JSON.stringify(entry.metadata), FIXED_NOW, FIXED_NOW);
      mediaPerson.run(stableId(0xaa000000, index + 1), blueprint.workspaceId, entry.id, entry.personId, `基准媒体 ${index + 1}`, FIXED_NOW, FIXED_NOW);
    });
  });

  try {
    insert();
  } catch (error) {
    database.close();
    throw error;
  }
  return { root: resolvedRoot, databasePath, database, blueprint };
}

async function main(): Promise<void> {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (!output) throw new Error("Usage: tsx scripts/generate-benchmark-workspace.ts --output <empty-temporary-directory>");
  const generated = await materializeBenchmarkWorkspace(output, BENCHMARK_SEED);
  generated.database.close();
  process.stdout.write(`${JSON.stringify({
    seed: BENCHMARK_SEED,
    databasePath: generated.databasePath,
    invariants: benchmarkInvariants(generated.blueprint)
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
