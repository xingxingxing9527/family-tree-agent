import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportBlankWorkbook } from "../../../src/main/application/import/chinese-workbook-exporter";
import { ImportPlanner, ImportPlanStore } from "../../../src/main/application/import/import-planner";
import { parseImport } from "../../../src/main/application/import/workbook-parser";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";

const workspaceId = "workspace-chinese-security";

describe("Chinese workbook security", () => {
  let root: string;
  let database: WorkspaceDatabase;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agent-chinese-security-"));
    database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
  });
  afterEach(async () => { database.close(); await rm(root, { recursive: true, force: true }); });

  const editedFile = async (edit: (workbook: ExcelJS.Workbook) => void): Promise<string> => {
    const bytes = await exportBlankWorkbook({ database, workspaceId, workspaceName: "王氏家谱", reservedNewRows: 2 });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    edit(workbook);
    const file = join(root, `${Math.random()}.xlsx`);
    await writeFile(file, Buffer.from(await workbook.xlsx.writeBuffer()));
    return file;
  };

  it("rejects a workbook bound to a different family", async () => {
    const file = await editedFile(() => undefined);
    await expect(parseImport(file, "ignored", { expectedWorkspaceId: "other-workspace" })).rejects.toThrow(/workspace|family/i);
  });

  it("rejects a malformed hidden batch identifier", async () => {
    const file = await editedFile((workbook) => {
      workbook.getWorksheet("_系统元数据")!.getCell("B3").value = "tampered-batch";
    });
    await expect(parseImport(file, "ignored", { expectedWorkspaceId: workspaceId })).rejects.toThrow(/metadata/i);
  });

  it("blocks an unknown or tampered permanent person code", async () => {
    const file = await editedFile((workbook) => {
      workbook.getWorksheet("人物信息")!.getRow(2).values = ["P999999", "篡改人物", "未知", "", "", ""];
    });
    const input = await parseImport(file, "ignored", { expectedWorkspaceId: workspaceId });
    const plan = new ImportPlanner(database, workspaceId, new ImportPlanStore()).plan(input);
    expect(plan.summary.blocked).toBe(1);
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: "UNKNOWN_PERMANENT_CODE" }));
  });

  it("rejects formula cells instead of evaluating spreadsheet input", async () => {
    const file = await editedFile((workbook) => {
      const people = workbook.getWorksheet("人物信息")!;
      people.getCell("B2").value = { formula: "HYPERLINK(\"https://bad\")", result: "恶意内容" };
    });
    await expect(parseImport(file, "ignored", { expectedWorkspaceId: workspaceId })).rejects.toThrow(/formula|supported|text/i);
  });
});
