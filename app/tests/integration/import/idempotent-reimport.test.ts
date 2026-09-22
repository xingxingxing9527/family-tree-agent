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
});
