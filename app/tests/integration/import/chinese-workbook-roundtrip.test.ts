import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { exportBlankWorkbook, exportCurrentFamilyWorkbook } from "../../../src/main/application/import/chinese-workbook-exporter";
import { ImportCommitter } from "../../../src/main/application/import/import-committer";
import { ImportPlanner, ImportPlanStore } from "../../../src/main/application/import/import-planner";
import { parseImport } from "../../../src/main/application/import/workbook-parser";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";
import { PersonRepository } from "../../../src/main/database/repositories/person-repository";

const workspaceId = "workspace-chinese-roundtrip";
const selectable = (plan: { actions: Array<{ id: string; kind: string }> }) => plan.actions.filter((action) => action.kind === "create" || action.kind === "update").map((action) => action.id);

describe("Chinese workbook round trip", () => {
  let root: string;
  let database: WorkspaceDatabase;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agent-chinese-roundtrip-"));
    database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
  });
  afterEach(async () => { database.close(); await rm(root, { recursive: true, force: true }); });

  it("accepts month and leap-month day dates and re-imports one batch as unchanged", async () => {
    const bytes = await exportBlankWorkbook({ database, workspaceId, workspaceName: "王氏家谱", reservedNewRows: 3 });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const people = workbook.getWorksheet("人物信息")!;
    people.getRow(2).values = ["N001", "王建国", "男", "公历", "1985-03", "父亲"];
    people.getRow(3).values = ["N002", "赵秀兰", "女", "农历", "1985-闰04-16", "母亲"];
    const marriage = workbook.getWorksheet("婚姻关系")!;
    marriage.getRow(2).values = ["N001｜王建国", "N002｜赵秀兰", "婚姻中", "公历 2008-06", ""];
    const file = join(root, "王氏家谱导入.xlsx");
    await writeFile(file, Buffer.from(await workbook.xlsx.writeBuffer()));

    const parsed = await parseImport(file, "ignored", { expectedWorkspaceId: workspaceId });
    expect(parsed.rows.filter((row) => row.sheet === "People").map((row) => row.raw)).toMatchObject([
      { birth_calendar: "solar", birth_year: 1985, birth_month: 3, birth_day: "", birth_leap_month: false },
      { birth_calendar: "lunar", birth_year: 1985, birth_month: 4, birth_day: 16, birth_leap_month: true }
    ]);
    const store = new ImportPlanStore();
    const planner = new ImportPlanner(database, workspaceId, store);
    const committer = new ImportCommitter(database, workspaceId, store);
    const first = planner.plan(parsed);
    expect(first.summary).toEqual({ creates: 3, updates: 0, unchanged: 0, blocked: 0 });
    committer.commitImport(first.id, selectable(first));

    const second = planner.plan(await parseImport(file, "ignored-again", { expectedWorkspaceId: workspaceId }));
    expect(second.summary).toEqual({ creates: 0, updates: 0, unchanged: first.actions.length, blocked: 0 });
  });

  it("updates an exported current-family person by permanent code without creating a duplicate", async () => {
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({ type: "person.create", draft: { id: "existing", workspaceId, displayName: "王建国", gender: "male" }, source: { sourceKey: "seed", title: "seed", kind: "test" } });
    const bytes = await exportCurrentFamilyWorkbook({ database, workspaceId, workspaceName: "王氏家谱", reservedNewRows: 1 });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    workbook.getWorksheet("人物信息")!.getCell("B2").value = "王建国（修订）";
    const file = join(root, "当前家谱修订.xlsx");
    await writeFile(file, Buffer.from(await workbook.xlsx.writeBuffer()));

    const store = new ImportPlanStore();
    const planner = new ImportPlanner(database, workspaceId, store);
    const plan = planner.plan(await parseImport(file, "ignored", { expectedWorkspaceId: workspaceId }));
    expect(plan.summary).toEqual({ creates: 0, updates: 1, unchanged: 0, blocked: 0 });
    new ImportCommitter(database, workspaceId, store).commitImport(plan.id, selectable(plan));

    expect(new PersonRepository(database, workspaceId).list()).toEqual([
      expect.objectContaining({ id: "existing", personCode: "P000001", displayName: "王建国（修订）" })
    ]);
  });
});
