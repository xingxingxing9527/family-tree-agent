import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactCommandError, FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { FactQueries } from "../../../src/main/application/facts/fact-queries";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";

const workspaceId = "workspace-1";
const otherWorkspaceId = "workspace-2";
const source = (key: string) => ({ sourceKey: key, title: key, kind: "form" });
const solar = (year: number, month = 1, day: number | null = null) => ({
  calendar: "solar" as const, year, month, day, leapMonth: false,
  precision: day === null ? "month" as const : "day" as const
});

describe("FactCommandService", () => {
  let root: string;
  let database: WorkspaceDatabase;
  let service: FactCommandService;
  let queries: FactQueries;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agent-facts-"));
    database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
    service = new FactCommandService(database, workspaceId);
    queries = new FactQueries(database, workspaceId);
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  const createPerson = (id: string, displayName: string, gender: "male" | "female" | "unknown" = "unknown", birth: ReturnType<typeof solar> | null = null) =>
    service.execute({
      type: "person.create",
      draft: { id, workspaceId, displayName, gender, birth },
      source: source(`person-${id}`)
    });

  const expectCode = (work: () => unknown, code: string) => {
    try {
      work();
      throw new Error("Expected command to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(FactCommandError);
      expect((error as FactCommandError).issues.map((issue) => issue.code)).toContain(code);
    }
  };

  it("writes a source, fact, operation group, and audit records atomically", () => {
    const result = createPerson("person-a", "甲");
    expect(result).toMatchObject({ changedEntityIds: ["person-a"], warnings: [] });
    expect(result.operationGroupId).not.toBe("");
    expect(queries.listPeople()).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) FROM source").pluck().get()).toBe(1);
    expect(database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get()).toBe(1);
    expect(database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()).toBe(2);
  });

  it("rejects self-parenting and self-marriage without partial writes", () => {
    createPerson("person-a", "甲");
    const before = database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get();
    expectCode(() => service.execute({
      type: "parentChild.add",
      draft: { workspaceId, parentId: "person-a", childId: "person-a", parentRole: "father" },
      source: source("self-parent")
    }), "SELF_RELATION");
    expectCode(() => service.execute({
      type: "marriage.add",
      draft: { workspaceId, spouseAId: "person-a", spouseBId: "person-a" },
      source: source("self-marriage")
    }), "SELF_RELATION");
    expect(database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get()).toBe(before);
    expect(database.prepare("SELECT COUNT(*) FROM parent_child").pluck().get()).toBe(0);
    expect(database.prepare("SELECT COUNT(*) FROM marriage").pluck().get()).toBe(0);
  });

  it("rejects A-to-B, B-to-C, C-to-A as PARENT_CYCLE", () => {
    createPerson("A", "A"); createPerson("B", "B"); createPerson("C", "C");
    service.execute({ type: "parentChild.add", draft: { workspaceId, parentId: "A", childId: "B", parentRole: "father" }, source: source("ab") });
    service.execute({ type: "parentChild.add", draft: { workspaceId, parentId: "B", childId: "C", parentRole: "father" }, source: source("bc") });
    expectCode(() => service.execute({ type: "parentChild.add", draft: { workspaceId, parentId: "C", childId: "A", parentRole: "father" }, source: source("ca") }), "PARENT_CYCLE");
    expect(queries.listParentChild()).toHaveLength(2);
  });

  it("rejects a second active biological father or mother", () => {
    createPerson("father-1", "父一", "male"); createPerson("father-2", "父二", "male"); createPerson("mother-1", "母一", "female"); createPerson("mother-2", "母二", "female"); createPerson("child", "孩子");
    service.execute({ type: "parentChild.add", draft: { workspaceId, parentId: "father-1", childId: "child", parentRole: "father" }, source: source("father-1") });
    service.execute({ type: "parentChild.add", draft: { workspaceId, parentId: "mother-1", childId: "child", parentRole: "mother" }, source: source("mother-1") });
    expectCode(() => service.execute({ type: "parentChild.add", draft: { workspaceId, parentId: "father-2", childId: "child", parentRole: "father" }, source: source("father-2") }), "PARENT_ROLE_OCCUPIED");
    expectCode(() => service.execute({ type: "parentChild.add", draft: { workspaceId, parentId: "mother-2", childId: "child", parentRole: "mother" }, source: source("mother-2") }), "PARENT_ROLE_OCCUPIED");
  });

  it("requires divorce before either spouse starts another active marriage", () => {
    createPerson("A", "A"); createPerson("B", "B"); createPerson("C", "C");
    const first = service.execute({ type: "marriage.add", draft: { id: "marriage-1", workspaceId, spouseAId: "A", spouseBId: "B" }, source: source("marriage-1") });
    expect(first.changedEntityIds).toEqual(["marriage-1"]);
    expectCode(() => service.execute({ type: "marriage.add", draft: { workspaceId, spouseAId: "A", spouseBId: "C" }, source: source("blocked-remarriage") }), "ACTIVE_MARRIAGE_EXISTS");
    expectCode(() => service.execute({ type: "marriage.add", draft: { workspaceId, spouseAId: "C", spouseBId: "B" }, source: source("blocked-remarriage-other-spouse") }), "ACTIVE_MARRIAGE_EXISTS");

    service.execute({ type: "marriage.divorce", marriageId: "marriage-1", endDate: solar(2020), expectedVersion: 1, source: source("divorce") });
    service.execute({ type: "marriage.add", draft: { id: "marriage-2", workspaceId, spouseAId: "A", spouseBId: "C" }, source: source("remarriage") });
    expect(queries.listMarriages().map((marriage) => marriage.status)).toEqual(["divorced", "active"]);
    expect(queries.listMarriages()[0]?.end).toEqual(solar(2020));
  });

  it("rejects referenced people and drafts from a different workspace", () => {
    createPerson("local", "本地");
    const now = new Date().toISOString();
    database.prepare("INSERT INTO person (id, workspace_id, display_name, gender, created_at, updated_at) VALUES (?, ?, ?, 'unknown', ?, ?)")
      .run("foreign", otherWorkspaceId, "外部", now, now);
    expectCode(() => service.execute({ type: "parentChild.add", draft: { workspaceId, parentId: "foreign", childId: "local", parentRole: "father" }, source: source("foreign-ref") }), "WORKSPACE_MISMATCH");
    expectCode(() => service.execute({ type: "person.create", draft: { id: "wrong", workspaceId: otherWorkspaceId, displayName: "错误", gender: "unknown" }, source: source("wrong-workspace") }), "WORKSPACE_MISMATCH");
  });

  it("returns age warnings without any write until confirmed on a second call", () => {
    createPerson("parent", "年轻父亲", "male", solar(2000)); createPerson("child", "孩子", "unknown", solar(2010));
    const command = { type: "parentChild.add" as const, draft: { id: "young-link", workspaceId, parentId: "parent", childId: "child", parentRole: "father" as const }, source: source("young-link") };
    const before = {
      operations: database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get(),
      sources: database.prepare("SELECT COUNT(*) FROM source").pluck().get(),
      audit: database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()
    };
    const preview = service.execute(command);
    expect(preview).toMatchObject({ operationGroupId: "", changedEntityIds: [], warnings: [{ code: "PARENT_AGE_OUTLIER" }] });
    expect(database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get()).toBe(before.operations);
    expect(database.prepare("SELECT COUNT(*) FROM source").pluck().get()).toBe(before.sources);
    expect(database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()).toBe(before.audit);
    expect(queries.listParentChild()).toHaveLength(0);

    const committed = service.execute(command, { confirmWarnings: true });
    expect(committed.changedEntityIds).toEqual(["young-link"]);
    expect(committed.warnings.map((warning) => warning.code)).toEqual(["PARENT_AGE_OUTLIER"]);
    expect(queries.listParentChild()).toHaveLength(1);
  });

  it("rejects a child born before its known parent birth year", () => {
    createPerson("parent", "父", "male", solar(2000)); createPerson("child", "子", "male", solar(1999));
    expectCode(() => service.execute({ type: "parentChild.add", draft: { workspaceId, parentId: "parent", childId: "child", parentRole: "father" }, source: source("impossible") }), "IMPOSSIBLE_DATE");
  });

  it("rejects invalid person and marriage dates before opening a transaction", () => {
    expectCode(() => service.execute({ type: "person.create", draft: { id: "bad", workspaceId, displayName: "坏日期", gender: "unknown", birth: solar(2023, 2, 29) }, source: source("bad-date") }), "INVALID_DATE");
    createPerson("A", "A"); createPerson("B", "B");
    expectCode(() => service.execute({
      type: "marriage.add",
      draft: { workspaceId, spouseAId: "A", spouseBId: "B", start: { calendar: "lunar", year: 2020, month: 13, day: 1, leapMonth: false, precision: "day" } },
      source: source("bad-marriage-date")
    }), "INVALID_DATE");
  });

  it("enforces optimistic versions for updates, divorce, and soft delete", () => {
    createPerson("A", "A"); createPerson("B", "B");
    service.execute({ type: "person.update", personId: "A", patch: { displayName: "A2" }, expectedVersion: 1, source: source("update-a") });
    expectCode(() => service.execute({ type: "person.update", personId: "A", patch: { displayName: "stale" }, expectedVersion: 1, source: source("stale-update") }), "CONFLICT");
    service.execute({ type: "marriage.add", draft: { id: "m", workspaceId, spouseAId: "A", spouseBId: "B" }, source: source("m") });
    expectCode(() => service.execute({ type: "marriage.divorce", marriageId: "m", endDate: null, expectedVersion: 2, source: source("stale-divorce") }), "CONFLICT");
    expectCode(() => service.execute({ type: "fact.softDelete", entityType: "person", entityId: "B", expectedVersion: 2 }), "CONFLICT");
    service.execute({ type: "fact.softDelete", entityType: "marriage", entityId: "m", expectedVersion: 1 });
    expect(queries.listMarriages()).toEqual([]);
  });

  it("resolves merged person ID redirects before validating and writing relations", () => {
    createPerson("survivor", "保留人物", "male");
    createPerson("merged", "被合并人物", "male");
    createPerson("child", "孩子");
    const operationGroupId = database.prepare("SELECT id FROM operation_group ORDER BY created_at, id LIMIT 1").pluck().get() as string;
    const now = new Date().toISOString();
    database.prepare("INSERT INTO merge_record (id, workspace_id, survivor_person_id, merged_person_id, operation_group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("merge-1", workspaceId, "survivor", "merged", operationGroupId, now, now);
    database.prepare("INSERT INTO id_redirect (id, workspace_id, old_person_id, new_person_id, merge_record_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("redirect-1", workspaceId, "merged", "survivor", "merge-1", now, now);

    service.execute({
      type: "parentChild.add",
      draft: { id: "redirected-link", workspaceId, parentId: "merged", childId: "child", parentRole: "father" },
      source: source("redirected-link")
    });

    expect(queries.listParentChild()).toMatchObject([{ id: "redirected-link", parentId: "survivor", childId: "child" }]);
  });

  it("validates person date updates against existing parent-child facts before writing", () => {
    createPerson("parent", "父", "male", solar(1980));
    createPerson("child", "子", "male", solar(2000));
    service.execute({
      type: "parentChild.add",
      draft: { workspaceId, parentId: "parent", childId: "child", parentRole: "father" },
      source: source("parent-child")
    });
    const before = database.prepare("SELECT COUNT(*) FROM source").pluck().get();

    expectCode(() => service.execute({
      type: "person.update",
      personId: "parent",
      patch: { birth: solar(2001) },
      expectedVersion: 1,
      source: source("impossible-update")
    }), "IMPOSSIBLE_DATE");

    expect(queries.listPeople().find((person) => person.id === "parent")?.birth).toEqual(solar(1980));
    expect(database.prepare("SELECT COUNT(*) FROM source").pluck().get()).toBe(before);
  });

  it("rolls back operation groups and facts when source creation fails inside the transaction", () => {
    createPerson("A", "A");
    const before = {
      operations: database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get(),
      people: database.prepare("SELECT COUNT(*) FROM person").pluck().get(),
      audit: database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()
    };

    expect(() => service.execute({
      type: "person.create",
      draft: { id: "B", workspaceId, displayName: "B", gender: "unknown" },
      source: source("person-A")
    })).toThrow();

    expect(database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get()).toBe(before.operations);
    expect(database.prepare("SELECT COUNT(*) FROM person").pluck().get()).toBe(before.people);
    expect(database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()).toBe(before.audit);
  });
});
