import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { ImportPlanner, ImportPlanStore } from "../../../src/main/application/import/import-planner";
import type { ParsedImport, ParsedImportRow } from "../../../src/main/application/import/import-types";
import { exportImportTemplate, parseImport } from "../../../src/main/application/import/workbook-parser";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";

const workspaceId = "workspace-import-planner";
const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/import/${name}`, import.meta.url));
const source = (key: string) => ({ sourceKey: key, title: key, kind: "test" });
const peopleRow = (row: number, externalId: string, name: string, overrides: Record<string, unknown> = {}): ParsedImportRow => ({
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
    notes: "",
    ...overrides
  }
});
const relationRow = (row: number, parent: string, child: string, role: string): ParsedImportRow => ({
  sheet: "ParentChild",
  row,
  raw: { parent_external_id: parent, child_external_id: child, parent_role: role }
});
const parsed = (sourceKey: string, rows: ParsedImportRow[]): ParsedImport => ({
  sourceKey,
  fileName: "inline.xlsx",
  rows
});

describe("spreadsheet import planning", () => {
  let root: string;
  let database: WorkspaceDatabase;
  let planner: ImportPlanner;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agent-import-plan-"));
    database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
    planner = new ImportPlanner(database, workspaceId, new ImportPlanStore());
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("parses the fixed workbook template and preserves external identifiers and source cells", async () => {
    const workbook = await parseImport(fixture("valid-family.xlsx"), "archive:王氏-2026");

    expect(workbook.sourceKey).toBe("archive:王氏-2026");
    expect(workbook.rows.filter((row) => row.sheet === "People")).toHaveLength(3);
    expect(workbook.rows[0]).toMatchObject({
      sheet: "People",
      row: 2,
      raw: { person_external_id: "P-001", name: "王建国", notes: "祖父原始备注" }
    });
  });

  it("exports the exact fixed template without overwriting an existing file", async () => {
    const target = join(root, "family-import-template.xlsx");
    await exportImportTemplate(target);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(target);

    expect((workbook.getWorksheet("People")?.getRow(1).values as unknown[]).slice(1)).toEqual([
      "person_external_id", "name", "gender", "birth_calendar", "birth_year", "birth_month", "birth_day", "birth_leap_month", "notes"
    ]);
    expect((workbook.getWorksheet("ParentChild")?.getRow(1).values as unknown[]).slice(1)).toEqual([
      "parent_external_id", "child_external_id", "parent_role"
    ]);
    expect((workbook.getWorksheet("Marriages")?.getRow(1).values as unknown[]).slice(1)).toEqual([
      "spouse_a_external_id", "spouse_b_external_id", "status", "start_calendar", "start_year", "start_month", "start_day", "start_leap_month", "end_calendar", "end_year", "end_month", "end_day", "end_leap_month"
    ]);
    await expect(exportImportTemplate(target)).rejects.toThrow(/already exists/i);
  });

  it("blocks a CSV relationship with missing external references and includes cell evidence", async () => {
    const input = await parseImport(fixture("missing-reference.csv"), "csv:missing", { csvEntityType: "ParentChild" });
    const plan = planner.plan(input);

    expect(plan.summary).toEqual({ creates: 0, updates: 0, unchanged: 0, blocked: 1 });
    expect(plan.actions).toMatchObject([{ kind: "blocked", entityType: "parentChild", sourceRow: { sheet: "ParentChild", row: 2 } }]);
    expect(plan.issues).toContainEqual(expect.objectContaining({
      severity: "error",
      code: "MISSING_REFERENCE",
      evidence: expect.objectContaining({ column: "parent_external_id", value: "UNKNOWN-PARENT", row: 2 })
    }));
  });

  it("blocks every duplicate external ID instead of choosing a row", () => {
    const plan = planner.plan(parsed("dup-source", [
      peopleRow(2, "SAME-ID", "甲"),
      peopleRow(3, "SAME-ID", "乙")
    ]));

    expect(plan.summary).toEqual({ creates: 0, updates: 0, unchanged: 0, blocked: 2 });
    expect(plan.issues.filter((issue) => issue.code === "DUPLICATE_EXTERNAL_ID")).toHaveLength(2);
    expect(plan.actions.every((action) => action.kind === "blocked")).toBe(true);
  });

  it("does not coerce numeric external identifiers into guessed text identifiers", () => {
    const row = peopleRow(2, "placeholder", "甲");
    row.raw.person_external_id = 1001;
    const plan = planner.plan(parsed("numeric-id", [row]));

    expect(plan.summary).toEqual({ creates: 0, updates: 0, unchanged: 0, blocked: 1 });
    expect(plan.issues).toContainEqual(expect.objectContaining({
      code: "INVALID_VALUE",
      evidence: expect.objectContaining({ column: "person_external_id", value: 1001 })
    }));
  });

  it("suggests same-name candidates but keeps a separate create action", () => {
    new FactCommandService(database, workspaceId).execute({
      type: "person.create",
      draft: { id: "existing-zhang", workspaceId, displayName: "张敏", gender: "female" },
      source: source("manual:zhang")
    });

    const plan = planner.plan(parsed("new-archive", [peopleRow(2, "EXT-张敏", "张敏", { gender: "female" })]));

    expect(plan.summary).toEqual({ creates: 1, updates: 0, unchanged: 0, blocked: 0 });
    expect(plan.actions[0]).toMatchObject({ kind: "create", entityType: "person" });
    expect(plan.actions[0]?.entityId).toBeUndefined();
    expect(plan.issues).toContainEqual(expect.objectContaining({
      severity: "warning",
      code: "SAME_NAME_CANDIDATE",
      evidence: expect.objectContaining({ externalId: "EXT-张敏", candidateEntityIds: ["existing-zhang"] })
    }));
  });

  it("reports parent cycles and invalid dates without guessing or creating actions", () => {
    const plan = planner.plan(parsed("invalid-archive", [
      peopleRow(2, "A", "甲"),
      peopleRow(3, "B", "乙", { birth_calendar: "solar", birth_year: "2023", birth_month: "2", birth_day: "29", birth_leap_month: "false" }),
      peopleRow(4, "C", "丙"),
      relationRow(2, "A", "B", "father"),
      relationRow(3, "B", "C", "father"),
      relationRow(4, "C", "A", "father")
    ]));

    expect(plan.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["INVALID_DATE", "PARENT_CYCLE"]));
    expect(plan.actions.find((action) => action.sourceRow.sheet === "People" && action.sourceRow.row === 3)?.kind).toBe("blocked");
    expect(plan.actions.find((action) => action.sourceRow.sheet === "ParentChild" && action.sourceRow.row === 4)?.kind).toBe("blocked");
  });

  it("makes planned relationship rows depend on the planned person creates", () => {
    const plan = planner.plan(parsed("dependency-source", [
      peopleRow(2, "PARENT", "父"),
      peopleRow(3, "CHILD", "子"),
      relationRow(2, "PARENT", "CHILD", "father")
    ]));

    expect(plan.actions.find((action) => action.entityType === "parentChild")?.dependsOnActionIds).toEqual([
      "People:2:person", "People:3:person"
    ]);
  });
});
