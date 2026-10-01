import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { ensureFamily, openArea, rpc } from "./helpers";

test("downloads, imports and re-exports the Chinese Excel workbook in the browser", async ({ page, request }, testInfo) => {
  const workspace = await ensureFamily(request);
  await openArea(page, workspace.id, "entry");
  await page.getByRole("button", { name: "表格导入" }).click();

  const blankDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载空白导入模板" }).click();
  const blankDownload = await blankDownloadPromise;
  expect(blankDownload.suggestedFilename()).toContain("空白导入模板");
  const blankPath = testInfo.outputPath("空白模板.xlsx");
  await blankDownload.saveAs(blankPath);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(blankPath);
  const people = workbook.getWorksheet("人物信息");
  expect(people?.getRow(1).values).toEqual([, "人物编号", "姓名", "性别", "出生历法", "出生日期", "备注"]);
  people!.getRow(2).values = ["N001", "表格李云", "女", "公历", "1970-07", "网页导入往返验证"];
  people!.getRow(3).values = ["N002", "表格李雨", "女", "公历", "1992-07", "网页导入往返验证"];
  workbook.getWorksheet("亲子关系")!.getRow(2).values = ["N001｜表格李云", "N002｜表格李雨", "母亲"];
  const uploadPath = testInfo.outputPath("中文导入.xlsx");
  await workbook.xlsx.writeFile(uploadPath);

  await page.locator('input[type="file"][accept=".xlsx,.csv"]').setInputFiles(uploadPath);
  await expect(page.getByLabel("已选导入文件")).toHaveText("中文导入.xlsx");
  await page.getByRole("button", { name: "解析并预览" }).click();
  await expect(page.getByLabel("导入预览")).toContainText("新增 3");
  await page.getByLabel("我已核对变更和问题，并确认写入所选行").check();
  await page.getByRole("button", { name: "确认导入 3 行" }).click();
  await expect(page.getByLabel("导入报告")).toContainText("已写入 3 行");

  const currentDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前家谱表格" }).click();
  const currentDownload = await currentDownloadPromise;
  expect(currentDownload.suggestedFilename()).toContain("当前家谱");
  const currentPath = testInfo.outputPath("当前家谱.xlsx");
  await currentDownload.saveAs(currentPath);
  const exported = new ExcelJS.Workbook();
  await exported.xlsx.readFile(currentPath);
  const exportedNames = exported.getWorksheet("人物信息")!.getColumn(2).values;
  expect(exportedNames).toContain("表格李云");
  expect(exportedNames).toContain("表格李雨");

  const before = await rpc<{ people: Array<{ id: string; displayName: string }> }>(request, "query", "workspaceSnapshot");
  const parentId = before.people.find((person) => person.displayName === "表格李云")!.id;
  const childrenBefore = await rpc<Array<{ kind: string; person: { displayName: string } }>>(request, "query", "listRelatives", { personId: parentId, kinds: ["child"] });
  expect(childrenBefore.filter((relative) => relative.person.displayName === "表格李雨")).toHaveLength(1);

  await page.locator('input[type="file"][accept=".xlsx,.csv"]').setInputFiles(currentPath);
  await expect(page.getByLabel("已选导入文件")).toHaveText("当前家谱.xlsx");
  await page.getByRole("button", { name: "解析并预览" }).click();
  await expect(page.getByLabel("导入预览")).toContainText("新增 0 · 更新 0");

  await page.locator('input[type="file"][accept=".xlsx,.csv"]').setInputFiles(uploadPath);
  await expect(page.getByLabel("已选导入文件")).toHaveText("中文导入.xlsx");
  await page.getByRole("button", { name: "解析并预览" }).click();
  await expect(page.getByLabel("导入预览")).toContainText("新增 0 · 更新 0");

  const after = await rpc<{ people: Array<{ id: string; displayName: string }> }>(request, "query", "workspaceSnapshot");
  const childrenAfter = await rpc<Array<{ kind: string; person: { displayName: string } }>>(request, "query", "listRelatives", { personId: parentId, kinds: ["child"] });
  expect(after.people).toHaveLength(before.people.length);
  expect(childrenAfter.filter((relative) => relative.person.displayName === "表格李雨")).toHaveLength(1);
});
