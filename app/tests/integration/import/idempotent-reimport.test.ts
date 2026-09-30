import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { ImportCommitter } from "../../../src/main/application/import/import-committer";
import { ImportPlanner, ImportPlanStore } from "../../../src/main/application/import/import-planner";
import type { ParsedImport, ParsedImportRow } from "../../../src/main/application/import/import-types";
import { parseImport } from "../../../src/main/application/import/workbook-parser";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";

const workspaceId = "workspace-idempotent-import";
const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/import/${name}`, import.meta.url));
const selectable = (plan: { actions: Array<{ id: string; kind: string }> }) => plan.actions.filter((action) => action.kind === "create" || action.kind === "update").map((action) => action.id);
const peopleRow = (row: number, externalId: string, name: string): ParsedImportRow => ({
  sheet: "People",
  row,
  raw: {
    person_external_id: externalId,
    name,
    gender: "unknown",
    birth_calendar: "",
    birth_year: "",
    birth_month: "",
    birth_day: "",
    birth_leap_month: "",
    notes: ""
  }
});
const marriageRow = (
  row: number,
  spouseA: string,
  spouseB: string,
  status: "active" | "divorced",
  startYear: number,
  endYear?: number
): ParsedImportRow => ({
  sheet: "Marriages",
  row,
  raw: {
    spouse_a_external_id: spouseA,
    spouse_b_external_id: spouseB,
    status,
    start_calendar: "solar",
    start_year: String(startYear),
    start_month: "1",
    start_day: "",
    start_leap_month: "false",
    end_calendar: endYear === undefined ? "" : "solar",
    end_year: endYear === undefined ? "" : String(endYear),
    end_month: endYear === undefined ? "" : "1",
    end_day: "",
    end_leap_month: "false"
  }
});
const parsed = (sourceKey: string, rows: ParsedImportRow[]): ParsedImport => ({ sourceKey, fileName: "updates.xlsx", rows });

describe("idempotent spreadsheet re-import", () => {
  let root: string;
  let database: WorkspaceDatabase;
  let store: ImportPlanStore;
  let planner: ImportPlanner;
  let committer: ImportCommitter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agent-idempotent-import-"));
    database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
    store = new ImportPlanStore();
    planner = new ImportPlanner(database, workspaceId, store);
    committer = new ImportCommitter(database, workspaceId, store);
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("commits the workbook in one operation group and re-imports the same source key without creates", async () => {
    const first = planner.plan(await parseImport(fixture("valid-family.xlsx"), "archive:王氏-2026"));
    const report = committer.commitImport(first.id, selectable(first));

    expect(first.summary).toEqual({ creates: 5, updates: 0, unchanged: 0, blocked: 0 });
    expect(report.operationGroupId).toMatch(/\S/);
    expect(report.rows.filter((row) => row.disposition === "committed")).toHaveLength(5);
    expect(new Set(report.rows.filter((row) => row.disposition === "committed").map((row) => row.operationGroupId))).toEqual(new Set([report.operationGroupId]));
    expect(database.prepare("SELECT COUNT(*) FROM person WHERE workspace_id = ?").pluck().get(workspaceId)).toBe(3);
    expect(database.prepare("SELECT COUNT(*) FROM parent_child WHERE workspace_id = ?").pluck().get(workspaceId)).toBe(1);
    expect(database.prepare("SELECT COUNT(*) FROM marriage WHERE workspace_id = ?").pluck().get(workspaceId)).toBe(1);
    expect(database.prepare("SELECT COUNT(*) FROM operation_group WHERE workspace_id = ?").pluck().get(workspaceId)).toBe(1);
    expect(database.prepare("SELECT source_key, external_person_id, raw_json FROM import_identity ORDER BY external_person_id").all()).toMatchObject([
      { source_key: "archive:王氏-2026", external_person_id: "P-001" },
      { source_key: "archive:王氏-2026", external_person_id: "P-002" },
      { source_key: "archive:王氏-2026", external_person_id: "P-003" }
    ]);

    const second = planner.plan(await parseImport(fixture("valid-family.xlsx"), "archive:王氏-2026"));
    expect(second.summary).toEqual({ creates: 0, updates: 0, unchanged: 5, blocked: 0 });
    expect(second.actions.every((action) => action.kind === "unchanged")).toBe(true);
    expect(database.prepare("SELECT COUNT(*) FROM person WHERE workspace_id = ?").pluck().get(workspaceId)).toBe(3);
  });

  it("revalidates all selected row versions and rolls back the entire selected update set", () => {
    const initial = planner.plan(parsed("archive:stale", [peopleRow(2, "A", "甲"), peopleRow(3, "B", "乙")]));
    committer.commitImport(initial.id, selectable(initial));

    const update = planner.plan(parsed("archive:stale", [peopleRow(2, "A", "甲-导入"), peopleRow(3, "B", "乙-导入")]));
    const identityA = database.prepare("SELECT person_id FROM import_identity WHERE workspace_id = ? AND source_key = ? AND external_person_id = ?").pluck().get(workspaceId, "archive:stale", "A") as string;
    new FactCommandService(database, workspaceId).execute({
      type: "person.update",
      personId: identityA,
      patch: { displayName: "甲-手工修改" },
      expectedVersion: 1,
      source: { sourceKey: "manual:stale-a", title: "manual", kind: "test" }
    });
    const operationCount = database.prepare("SELECT COUNT(*) FROM operation_group WHERE workspace_id = ?").pluck().get(workspaceId);

    expect(() => committer.commitImport(update.id, selectable(update))).toThrow(/changed since preview/i);
    expect(database.prepare("SELECT display_name FROM person WHERE workspace_id = ? ORDER BY display_name").pluck().all(workspaceId)).toEqual(["乙", "甲-手工修改"]);
    expect(database.prepare("SELECT COUNT(*) FROM operation_group WHERE workspace_id = ?").pluck().get(workspaceId)).toBe(operationCount);
  });

  it("never creates a partial relationship for missing external references", async () => {
    const input = await parseImport(fixture("missing-reference.csv"), "csv:missing", { csvEntityType: "ParentChild" });
    const plan = planner.plan(input);
    const report = committer.commitImport(plan.id, selectable(plan));

    expect(report.operationGroupId).toBeNull();
    expect(report.rows).toMatchObject([{ disposition: "blocked", issueCodes: expect.arrayContaining(["MISSING_REFERENCE"]) }]);
    expect(database.prepare("SELECT COUNT(*) FROM parent_child").pluck().get()).toBe(0);
    expect(database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get()).toBe(0);
  });

  it("rejects a selected relationship when its planned person prerequisite is excluded", () => {
    const plan = planner.plan(parsed("dependent-selection", [
      peopleRow(2, "A", "甲"),
      peopleRow(3, "B", "乙"),
      { sheet: "ParentChild", row: 2, raw: { parent_external_id: "A", child_external_id: "B", parent_role: "father" } }
    ]));
    const relationship = plan.actions.find((action) => action.entityType === "parentChild")!;

    expect(() => committer.commitImport(plan.id, [relationship.id])).toThrow(/prerequisite/i);
    expect(database.prepare("SELECT COUNT(*) FROM person").pluck().get()).toBe(0);
    expect(database.prepare("SELECT COUNT(*) FROM parent_child").pluck().get()).toBe(0);
  });

  it("imports divorce and remarriage episodes and re-imports both as unchanged", () => {
    const rows = [
      peopleRow(2, "A", "甲"),
      peopleRow(3, "B", "乙"),
      marriageRow(2, "A", "B", "divorced", 1990, 2000),
      marriageRow(3, "B", "A", "active", 2010)
    ];
    const first = planner.plan(parsed("archive:remarriage", rows));
    expect(first.summary).toEqual({ creates: 4, updates: 0, unchanged: 0, blocked: 0 });
    committer.commitImport(first.id, selectable(first));
    expect(database.prepare("SELECT marriage_status, start_year, end_year FROM marriage ORDER BY start_year").all()).toEqual([
      { marriage_status: "divorced", start_year: 1990, end_year: 2000 },
      { marriage_status: "active", start_year: 2010, end_year: null }
    ]);

    const second = planner.plan(parsed("archive:remarriage", rows));
    expect(second.summary).toEqual({ creates: 0, updates: 0, unchanged: 4, blocked: 0 });
    expect(second.actions.filter((action) => action.entityType === "marriage").every((action) => action.kind === "unchanged")).toBe(true);
  });

  it("creates a later active episode after a persisted divorce", () => {
    const people = [peopleRow(2, "A", "甲"), peopleRow(3, "B", "乙")];
    const historical = planner.plan(parsed("archive:persisted-remarriage", [...people, marriageRow(2, "A", "B", "divorced", 1990, 2000)]));
    committer.commitImport(historical.id, selectable(historical));

    const later = planner.plan(parsed("archive:persisted-remarriage", [...people, marriageRow(2, "A", "B", "divorced", 1990, 2000), marriageRow(3, "A", "B", "active", 2010)]));
    expect(later.summary).toEqual({ creates: 1, updates: 0, unchanged: 3, blocked: 0 });
    committer.commitImport(later.id, selectable(later));
    expect(database.prepare("SELECT COUNT(*) FROM marriage").pluck().get()).toBe(2);
  });

  it("deduplicates an identical marriage episode repeated in one input", () => {
    const plan = planner.plan(parsed("archive:duplicate-episode", [
      peopleRow(2, "A", "甲"),
      peopleRow(3, "B", "乙"),
      marriageRow(2, "A", "B", "divorced", 1990, 2000),
      marriageRow(3, "B", "A", "divorced", 1990, 2000)
    ]));

    expect(plan.summary).toEqual({ creates: 3, updates: 0, unchanged: 1, blocked: 0 });
    committer.commitImport(plan.id, selectable(plan));
    expect(database.prepare("SELECT COUNT(*) FROM marriage").pluck().get()).toBe(1);
  });

  it("blocks a second active marriage for either spouse during preview even when the pair differs", () => {
    const plan = planner.plan(parsed("archive:cross-pair-active", [
      peopleRow(2, "A", "甲"),
      peopleRow(3, "B", "乙"),
      peopleRow(4, "C", "丙"),
      marriageRow(2, "A", "B", "active", 2010),
      marriageRow(3, "A", "C", "active", 2020)
    ]));

    expect(plan.actions.filter((action) => action.entityType === "marriage").map((action) => action.kind)).toEqual(["create", "blocked"]);
    expect(plan.summary).toEqual({ creates: 4, updates: 0, unchanged: 0, blocked: 1 });
  });

  it("blocks a cross-pair historical episode that overlaps a persisted marriage", () => {
    const people = [peopleRow(2, "A", "甲"), peopleRow(3, "B", "乙"), peopleRow(4, "C", "丙")];
    const initial = planner.plan(parsed("archive:cross-pair-history", [...people, marriageRow(2, "A", "B", "divorced", 1990, 2010)]));
    committer.commitImport(initial.id, selectable(initial));

    const preview = planner.plan(parsed("archive:cross-pair-history", [
      ...people,
      marriageRow(2, "A", "B", "divorced", 1990, 2010),
      marriageRow(3, "A", "C", "divorced", 2000, 2005)
    ]));

    expect(preview.actions.filter((action) => action.entityType === "marriage").map((action) => action.kind)).toEqual(["unchanged", "blocked"]);
    expect(preview.summary).toEqual({ creates: 0, updates: 0, unchanged: 4, blocked: 1 });
  });

  it("blocks a conflicting second active episode and rolls back a stale selected set atomically", () => {
    const initial = planner.plan(parsed("archive:active-conflict", [peopleRow(2, "A", "甲"), peopleRow(3, "B", "乙")]));
    committer.commitImport(initial.id, selectable(initial));

    const proposed = planner.plan(parsed("archive:active-conflict", [
      peopleRow(2, "A", "甲"),
      peopleRow(3, "B", "乙"),
      peopleRow(4, "C", "丙"),
      marriageRow(2, "A", "B", "active", 2010)
    ]));
    const identities = database.prepare("SELECT external_person_id, person_id FROM import_identity WHERE source_key = ?").all("archive:active-conflict") as Array<{ external_person_id: string; person_id: string }>;
    const ids = new Map(identities.map((entry) => [entry.external_person_id, entry.person_id]));
    new FactCommandService(database, workspaceId).execute({
      type: "marriage.add",
      draft: { workspaceId, spouseAId: ids.get("A")!, spouseBId: ids.get("B")!, status: "active", start: { calendar: "solar", year: 2005, month: 1, day: null, leapMonth: false, precision: "month" } },
      source: { sourceKey: "manual:concurrent-marriage", title: "manual", kind: "test" }
    });

    expect(() => committer.commitImport(proposed.id, selectable(proposed))).toThrow(/active marriage/i);
    expect(database.prepare("SELECT COUNT(*) FROM person").pluck().get()).toBe(2);
    expect(database.prepare("SELECT COUNT(*) FROM import_identity WHERE external_person_id = 'C'").pluck().get()).toBe(0);

    const previewAfterConflict = planner.plan(parsed("archive:active-conflict", [
      peopleRow(2, "A", "甲"),
      peopleRow(3, "B", "乙"),
      marriageRow(2, "A", "B", "active", 2010)
    ]));
    expect(previewAfterConflict.actions.find((action) => action.entityType === "marriage")).toMatchObject({ kind: "blocked" });
  });
});
