import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { exportCurrentFamilyWorkbook } from "../../../src/main/application/import/chinese-workbook-exporter";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";

const workspaceId = "workspace-chinese-export";
const source = (key: string) => ({ sourceKey: key, title: key, kind: "test" });

describe("Chinese family workbook export", () => {
  let database: WorkspaceDatabase;

  beforeEach(() => {
    database = openDatabase(":memory:");
    applyMigrations(database);
  });

  it("exports the four Chinese sheets, hidden metadata and locked permanent codes", async () => {
    const facts = new FactCommandService(database, workspaceId);
    facts.execute({ type: "person.create", draft: { id: "father", workspaceId, displayName: "王建国", gender: "male", birth: { calendar: "solar", year: 1950, month: 2, day: null, leapMonth: false, precision: "month" }, notes: "=HYPERLINK(\"https://bad\")" }, source: source("father") });
    facts.execute({ type: "person.create", draft: { id: "child", workspaceId, displayName: "王强", gender: "male" }, source: source("child") });
    facts.execute({ type: "parentChild.add", draft: { workspaceId, parentId: "father", childId: "child", parentRole: "father" }, source: source("edge") }, { confirmWarnings: true });

    const bytes = await exportCurrentFamilyWorkbook({ database, workspaceId, workspaceName: "王氏家谱", reservedNewRows: 3 });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["填写说明", "人物信息", "亲子关系", "婚姻关系", "_系统元数据"]);
    expect(workbook.getWorksheet("_系统元数据")?.state).toBe("veryHidden");
    const people = workbook.getWorksheet("人物信息")!;
    expect((people.getRow(1).values as unknown[]).slice(1)).toEqual(["人物编号", "姓名", "性别", "出生历法", "出生日期", "备注"]);
    expect(people.getCell("A2").value).toBe("P000001");
    expect(people.getCell("A2").protection?.locked).not.toBe(false);
    expect(people.getCell("A4").value).toBe("N001");
    expect(people.getCell("A4").protection?.locked).not.toBe(false);
    expect(people.sheetProtection?.sheet).toBe(true);
    expect(people.getCell("F2").value).toBe("'=HYPERLINK(\"https://bad\")");
    expect(workbook.getWorksheet("亲子关系")?.getCell("A2").value).toBe("P000001｜王建国");
    database.close();
  });
});
