import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { QueryToolRegistry } from "../../../src/main/application/query/query-tool-registry";
import { projectWorkspaceTree } from "../../../src/main/application/query/workspace-projection";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";
import { openQueryDatabase } from "../../../src/main/database/open-query-database";
import { createUnitOfWork } from "../../../src/main/database/unit-of-work";
import { QUERY_CHANNELS, registerQueryIpc, WorkspaceQueryGateway, type QueryGateway } from "../../../src/main/ipc/query-ipc";
import { RPC_INPUT_SCHEMAS } from "../../../src/shared/api-schemas";

const workspaceId = "workspace-query-tools";
const solar = (year: number) => ({
  calendar: "solar" as const,
  year,
  month: 1,
  day: null,
  leapMonth: false,
  precision: "month" as const
});

describe("query IPC boundary", () => {
  it("accepts only the four approved tree view request shapes", () => {
    const parse = (input: unknown) => RPC_INPUT_SCHEMAS.query.projectTree.safeParse(input);

    expect(parse({ view: "full" }).success).toBe(true);
    expect(parse({ view: "lineage", subjectId: "person", lineageId: "lineage" }).success).toBe(true);
    expect(parse({ view: "lineage", subjectId: "person" }).success).toBe(false);
    expect(parse({ view: "core", subjectId: "person" }).success).toBe(true);
    expect(parse({ view: "core", subjectId: "person", lineageId: "lineage" }).success).toBe(false);
    expect(parse({ view: "descendants", subjectId: "person" }).success).toBe(true);
    expect(parse({ view: "branch", subjectId: "person" }).success).toBe(false);
    expect(parse({ view: "ancestors", subjectId: "person" }).success).toBe(false);
  });

  it("validates and sender-checks the bounded workspace snapshot and tree projection channels", async () => {
    const workspaceSnapshot = vi.fn().mockResolvedValue({ ok: true, value: { workspaceId, people: [], sources: [], lineages: [] } });
    const projectTree = vi.fn().mockResolvedValue({ ok: true, value: { topology: { key: "full:4", nodes: [], edges: [] }, viewpointId: null, labels: {} } });
    const gateway = {
      workspaceSnapshot,
      projectTree,
      searchPeople: vi.fn(),
      getPerson: vi.fn(),
      listRelatives: vi.fn(),
      calculateRelationship: vi.fn(),
      summarizeLineage: vi.fn(),
      searchWiki: vi.fn()
    } as unknown as QueryGateway;
    const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => Promise<unknown>>();
    registerQueryIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) }, () => 7, gateway);

    await expect(handlers.get(QUERY_CHANNELS.workspaceSnapshot)!({ sender: { id: 7 } }, { databasePath: "C:\\private\\family.sqlite" }))
      .resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    await expect(handlers.get(QUERY_CHANNELS.projectTree)!({ sender: { id: 7 } }, { view: "descendants" }))
      .resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    await expect(handlers.get(QUERY_CHANNELS.projectTree)!({ sender: { id: 7 } }, { view: "full", collapseDepth: 21 }))
      .resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    await expect(handlers.get(QUERY_CHANNELS.workspaceSnapshot)!({ sender: { id: 9 } }, {}))
      .resolves.toEqual({ ok: false, error: { code: "PATH_DENIED", message: "IPC sender was denied" } });
    expect(workspaceSnapshot).not.toHaveBeenCalled();
    expect(projectTree).not.toHaveBeenCalled();

    await expect(handlers.get(QUERY_CHANNELS.workspaceSnapshot)!({ sender: { id: 7 } }, {})).resolves.toMatchObject({ ok: true });
    await expect(handlers.get(QUERY_CHANNELS.projectTree)!({ sender: { id: 7 } }, { view: "core", subjectId: "person-1", viewpointId: "person-2", collapseDepth: 8 }))
      .resolves.toMatchObject({ ok: true });
    expect(projectTree).toHaveBeenCalledWith({ view: "core", subjectId: "person-1", viewpointId: "person-2", collapseDepth: 8 });
  });

  it("rejects escape-hatch fields and sanitizes unexpected gateway details", async () => {
    const searchPeople = vi.fn().mockResolvedValue({ ok: true, value: [] });
    const getPerson = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: "INTERNAL",
        message: "SQL SELECT secret at C:\\private\\genealogy.sqlite",
        details: { stack: "private stack", file: "C:\\private\\genealogy.sqlite" }
      }
    });
    const gateway = {
      searchPeople,
      getPerson,
      listRelatives: vi.fn(),
      calculateRelationship: vi.fn(),
      summarizeLineage: vi.fn(),
      searchWiki: vi.fn()
    } as unknown as QueryGateway;
    const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => Promise<unknown>>();
    registerQueryIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) }, () => 7, gateway);

    await expect(handlers.get(QUERY_CHANNELS.searchPeople)!({ sender: { id: 7 } }, {
      query: "张",
      limit: 20,
      sql: "SELECT * FROM person"
    })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(searchPeople).not.toHaveBeenCalled();

    const internal = await handlers.get(QUERY_CHANNELS.getPerson)!({ sender: { id: 7 } }, { personId: "person-1" });
    expect(internal).toEqual({ ok: false, error: { code: "INTERNAL", message: "Unable to complete query request" } });
    expect(JSON.stringify(internal)).not.toMatch(/SELECT|genealogy\.sqlite|private|stack/i);
  });

  it("returns a sanitized result when an existing workspace database cannot be opened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-gateway-"));
    const databasePath = join(directory, "genealogy.sqlite");
    await writeFile(databasePath, "not a sqlite database");
    const gateway = new WorkspaceQueryGateway({
      getOpenWorkspaceContext: () => ({ workspaceId, databasePath })
    });

    await expect(gateway.searchPeople({ query: "张", limit: 20 })).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Unable to complete query request" }
    });
    await rm(directory, { recursive: true, force: true });
  });

  it("opens query databases read-only without changing on-disk state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-read-only-"));
    const databasePath = join(directory, "genealogy.sqlite");
    const database = new Database(databasePath);
    applyMigrations(database);
    database.close();

    const beforeBytes = await readFile(databasePath);
    const beforeWal = existsSync(`${databasePath}-wal`);
    const beforeShm = existsSync(`${databasePath}-shm`);
    const beforeCheck = new Database(databasePath);
    const beforeJournalMode = beforeCheck.pragma("journal_mode", { simple: true });
    const beforeOperationCount = beforeCheck.prepare("SELECT COUNT(*) AS count FROM operation_group").get() as { count: number };
    beforeCheck.close();

    const gateway = new WorkspaceQueryGateway({
      getOpenWorkspaceContext: () => ({ workspaceId, databasePath })
    });
    await expect(gateway.searchPeople({ query: "张", limit: 20 })).resolves.toEqual({ ok: true, value: [] });

    const queryDatabase = openQueryDatabase(databasePath);
    try {
      expect(() => queryDatabase.exec("CREATE TABLE query_write_probe (id INTEGER)")).toThrow(/readonly|read-only/i);
    } finally {
      queryDatabase.close();
    }

    const afterBytes = await readFile(databasePath);
    const afterCheck = new Database(databasePath);
    const afterJournalMode = afterCheck.pragma("journal_mode", { simple: true });
    const afterOperationCount = afterCheck.prepare("SELECT COUNT(*) AS count FROM operation_group").get() as { count: number };
    afterCheck.close();
    expect(afterBytes).toEqual(beforeBytes);
    expect(afterJournalMode).toBe(beforeJournalMode);
    expect(afterOperationCount).toEqual(beforeOperationCount);
    expect(existsSync(`${databasePath}-wal`)).toBe(beforeWal);
    expect(existsSync(`${databasePath}-shm`)).toBe(beforeShm);
    await rm(directory, { recursive: true, force: true });
  });
});
const source = (key: string) => ({ sourceKey: key, title: `来源 ${key}`, kind: "form" });

describe("QueryToolRegistry", () => {
  let database: WorkspaceDatabase;
  let registry: QueryToolRegistry;

  beforeEach(() => {
    database = openDatabase(":memory:");
    applyMigrations(database);
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({
      type: "person.create",
      draft: { id: "father", workspaceId, displayName: "张国强", gender: "male", birth: solar(1960) },
      source: source("father")
    });
    facts.execute({
      type: "person.create",
      draft: { id: "child-a", workspaceId, displayName: "张敏", aliases: ["敏敏"], gender: "female", birth: solar(1988) },
      source: source("child-a")
    });
    facts.execute({
      type: "person.create",
      draft: { id: "child-b", workspaceId, displayName: "张敏", gender: "male", birth: solar(1990) },
      source: source("child-b")
    });
    facts.execute({
      type: "person.create",
      draft: { id: "spouse", workspaceId, displayName: "李华", gender: "female" },
      source: source("spouse")
    });
    facts.execute({
      type: "parentChild.add",
      draft: { id: "father-child-a", workspaceId, parentId: "father", childId: "child-a", parentRole: "father" },
      source: source("father-child-a")
    });
    facts.execute({
      type: "parentChild.add",
      draft: { id: "father-child-b", workspaceId, parentId: "father", childId: "child-b", parentRole: "father" },
      source: source("father-child-b")
    });

    createUnitOfWork(database, workspaceId).run("lineage.fixtures", (context) => {
      context.lineages.create(context, { id: "lineage", name: "张氏", founderPersonId: "father" });
      context.lineages.addMembership(context, { id: "member-a", lineageId: "lineage", personId: "child-a", lineageRole: "blood" });
      context.lineages.addMembership(context, { id: "member-b", lineageId: "lineage", personId: "child-b", lineageRole: "blood" });
      context.lineages.addMembership(context, { id: "member-spouse", lineageId: "lineage", personId: "spouse", lineageRole: "married_in", declaredGeneration: 2 });
    });

    const now = new Date().toISOString();
    database.prepare("INSERT INTO wiki_entry (id, workspace_id, slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("wiki-active", workspaceId, "percent-story", "百分号 % 家史", "记录含有 100% 原文和下划线_符号", now, now);
    database.prepare("INSERT INTO wiki_entry (id, workspace_id, slug, title, content, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("wiki-archived", workspaceId, "archived", "旧家史", "百分号 % 家史", now, now, now);
    registry = new QueryToolRegistry(database, workspaceId);
  });

  afterEach(() => database.close());

  it("keeps duplicate names disambiguated with birth and parent hints", () => {
    expect(registry.tools.search_people({ query: "张敏", limit: 20 })).toEqual([
      {
        id: "child-a",
        displayName: "张敏",
        aliases: ["敏敏"],
        gender: "female",
        birth: solar(1988),
        parentHints: [{ id: "father", displayName: "张国强", role: "father" }]
      },
      {
        id: "child-b",
        displayName: "张敏",
        aliases: [],
        gender: "male",
        birth: solar(1990),
        parentHints: [{ id: "father", displayName: "张国强", role: "father" }]
      }
    ]);
  });

  it("returns structured person sources and typed relatives without mutating facts", () => {
    const operationCount = database.prepare("SELECT COUNT(*) AS count FROM operation_group").get() as { count: number };

    const person = registry.tools.get_person({ personId: "child-a" });
    const children = registry.tools.list_relatives({ personId: "father", kinds: ["child"] });

    expect(person.sources).toEqual([expect.objectContaining({ title: "来源 child-a", sourceKey: "child-a" })]);
    expect(children).toHaveLength(2);
    expect(children.map((relative) => relative.person.id)).toEqual(["child-a", "child-b"]);
    expect(children.every((relative) => relative.kind === "child")).toBe(true);
    expect(database.prepare("SELECT COUNT(*) AS count FROM operation_group").get()).toEqual(operationCount);
  });

  it("falls back to legacy operation-group provenance when durable fact-source links are absent", () => {
    database.prepare(`DELETE FROM fact_source_link
      WHERE workspace_id = ?
        AND (entity_type, entity_id) IN (('person', 'child-a'), ('parent_child', 'father-child-a'))`)
      .run(workspaceId);

    expect(registry.tools.get_person({ personId: "child-a" }).sources)
      .toEqual([expect.objectContaining({ title: "来源 child-a", sourceKey: "child-a" })]);
    const relationSourceIds = registry.sourceIdsForFacts(["father-child-a"]);
    expect(relationSourceIds).toHaveLength(1);
    expect(database.prepare("SELECT source_key FROM source WHERE id = ?").pluck().get(relationSourceIds[0]))
      .toBe("father-child-a");
  });

  it("combines legacy provenance with later directly-linked updates without widening the new operation", () => {
    database.prepare("DELETE FROM fact_source_link WHERE workspace_id = ? AND entity_type = 'person' AND entity_id = 'child-a'")
      .run(workspaceId);
    new FactCommandService(database, workspaceId).execute({
      type: "person.update",
      personId: "child-a",
      expectedVersion: 1,
      patch: { notes: "迁移后的修订" },
      source: source("child-a-update")
    });

    expect(registry.tools.get_person({ personId: "child-a" }).sources.map(({ sourceKey }) => sourceKey).sort())
      .toEqual(["child-a", "child-a-update"]);
  });

  it("returns provenance only for parent and child relatives", () => {
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({
      type: "marriage.add",
      draft: { id: "parents-marriage", workspaceId, spouseAId: "father", spouseBId: "spouse" },
      source: source("parents-marriage")
    });
    facts.execute({
      type: "parentChild.add",
      draft: {
        id: "mother-child-a", workspaceId, parentId: "spouse", childId: "child-a", parentRole: "mother",
        originKind: "spouse_default", inferredFromMarriageId: "parents-marriage"
      },
      source: source("mother-child-a")
    });

    const parents = registry.tools.list_relatives({ personId: "child-a", kinds: ["parent"] });
    const children = registry.tools.list_relatives({ personId: "spouse", kinds: ["child"] });
    const spouses = registry.tools.list_relatives({ personId: "father", kinds: ["spouse"] });

    expect(parents).toHaveLength(2);
    expect(parents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relationId: "father-child-a", kind: "parent", rowVersion: 1,
        originKind: "explicit", inferredFromMarriageId: null
      }),
      expect.objectContaining({
        relationId: "mother-child-a", kind: "parent", rowVersion: 1,
        originKind: "spouse_default", inferredFromMarriageId: "parents-marriage"
      })
    ]));
    expect(children).toEqual([expect.objectContaining({
      relationId: "mother-child-a", kind: "child", rowVersion: 1,
      originKind: "spouse_default", inferredFromMarriageId: "parents-marriage"
    })]);
    expect(spouses).toEqual([expect.objectContaining({ relationId: "parents-marriage", kind: "spouse" })]);
    expect(spouses[0]).not.toHaveProperty("rowVersion");
    expect(spouses[0]).not.toHaveProperty("originKind");
    expect(spouses[0]).not.toHaveProperty("inferredFromMarriageId");
  });

  it("calculates the same relationship bidirectionally with inspectable paths", () => {
    const downward = registry.tools.calculate_relationship({ viewpointId: "father", targetId: "child-a" });
    const upward = registry.tools.calculate_relationship({ viewpointId: "child-a", targetId: "father" });

    expect(downward.primaryTerm).toBe(upward.reverseTerm);
    expect(downward.reverseTerm).toBe(upward.primaryTerm);
    expect(downward.signature.pathPersonIds).toEqual(["father", "child-a"]);
    expect(upward.signature.pathPersonIds).toEqual(["child-a", "father"]);
  });

  it("withholds a relationship term when persisted direct roles conflict", () => {
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO marriage (
      id, workspace_id, spouse_a_id, spouse_b_id, marriage_status,
      start_calendar, start_year, start_month, start_day, start_leap_month, start_precision,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 'solar', 2020, 1, NULL, 0, 'month', ?, ?)`)
      .run("invalid-direct-role", workspaceId, "child-a", "father", now, now);

    const result = new QueryToolRegistry(database, workspaceId).tools.calculate_relationship({
      viewpointId: "father",
      targetId: "child-a"
    });

    expect(result.primaryTerm).toBeNull();
    expect(result.reverseTerm).toBeNull();
    expect(result.uncertainty).toEqual([
      "数据冲突：incompatible-direct-roles:child-a:father"
    ]);
    expect(projectWorkspaceTree(database, workspaceId, {
      view: "full",
      collapseDepth: 4,
      viewpointId: "father"
    }).labels["child-a"]).toBeNull();
  });

  it("summarizes blood generations without counting married-in members", () => {
    const summary = registry.tools.summarize_lineage({ lineageId: "lineage" });
    const secondGeneration = registry.tools.summarize_lineage({ lineageId: "lineage", generation: 2 });

    expect(summary).toMatchObject({
      lineageId: "lineage",
      name: "张氏",
      memberCount: 4,
      bloodMemberCount: 3,
      generationCounts: { "1": 1, "2": 2 }
    });
    expect(secondGeneration.members.map((member) => member.personId)).toEqual(["child-a", "child-b"]);
    expect(secondGeneration.members.some((member) => member.personId === "spouse")).toBe(false);
  });

  it("keeps the six-tool map closed and treats LIKE wildcard characters literally", () => {
    expect(Object.keys(registry.tools)).toEqual([
      "search_people",
      "get_person",
      "list_relatives",
      "calculate_relationship",
      "summarize_lineage",
      "search_wiki"
    ]);
    expect(registry.tools.search_wiki({ query: "%", limit: 50 })).toEqual([
      expect.objectContaining({ wikiEntryId: "wiki-active", title: "百分号 % 家史", sourceIds: [] })
    ]);
    expect(() => registry.tools.search_people({ query: "张", limit: 2, sql: "SELECT *" } as never)).toThrow();
  });
});
