import ExcelJS from "exceljs";
import type { WorkspaceDatabase } from "../../database/open-database.js";
import { PersonRepository } from "../../database/repositories/person-repository.js";
import { RelationRepository } from "../../database/repositories/relation-repository.js";
import { CHINESE_HEADERS, formatDateBody, formatMarriageDate, neutralizeFormulaText } from "./chinese-workbook-schema.js";
import { createWorkbookMetadata, writeWorkbookMetadata } from "./workbook-metadata.js";

export interface ChineseWorkbookExportContext {
  database: WorkspaceDatabase;
  workspaceId: string;
  workspaceName: string;
  reservedNewRows?: number;
}

const font = { name: "Arial", size: 10 };
const headerFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1F4E78" } };
const inputFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF2CC" } };
const border = { style: "thin" as const, color: { argb: "FFD9E2F3" } };
const code = (index: number): string => `N${String(index).padStart(3, "0")}`;
const gender = (value: "male" | "female" | "unknown"): string => value === "male" ? "男" : value === "female" ? "女" : "未知";
const safe = (value: string | null): string => neutralizeFormulaText(value ?? "");

const styleTable = (sheet: ExcelJS.Worksheet, columns: number, rows: number): void => {
  sheet.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  sheet.getRow(1).height = 26;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { ...font, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = headerFill;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = { bottom: border };
  });
  for (let row = 2; row <= rows; row += 1) for (let column = 1; column <= columns; column += 1) {
    const cell = sheet.getCell(row, column);
    cell.font = font;
    cell.alignment = { vertical: "middle", horizontal: column === 1 ? "left" : undefined };
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns } };
};

const protectInputSheet = async (sheet: ExcelJS.Worksheet, editableColumns: number[], fromRow: number, toRow: number): Promise<void> => {
  for (let row = fromRow; row <= toRow; row += 1) for (const column of editableColumns) {
    const cell = sheet.getCell(row, column);
    cell.protection = { locked: false };
    cell.fill = inputFill;
  }
  await sheet.protect("family-agent", { selectLockedCells: true, selectUnlockedCells: true, formatCells: false, insertRows: false, deleteRows: false });
};

async function exportWorkbook(context: ChineseWorkbookExportContext, kind: "current" | "blank"): Promise<Buffer> {
  const reserved = Math.max(1, Math.min(context.reservedNewRows ?? 100, 1_000));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "家谱智能体";
  workbook.created = new Date();
  const instructions = workbook.addWorksheet("填写说明", { views: [{ showGridLines: false }] });
  instructions.columns = [{ width: 22 }, { width: 90 }];
  instructions.addRows([
    [context.workspaceName, "中文家谱导入表"],
    ["使用方法", "可在人物信息中修改已有资料或填写预留的 N 编号行；关系表通过 人物编号｜姓名 引用人物。上传后仍需在网页中预览并确认。"],
    ["人物编号", "P 开头的是系统永久编号，N 开头的是本批次新增编号。编号不可修改；删除表格行不会删除系统资料。"],
    ["日期", "出生日期示例：1985-03、1985-04-16、1985-闰04-16。结婚/离婚日期示例：公历 2008-06、农历 2008-闰04-16。"],
    ["限制", "只录入人物、亲子和婚姻事实。公式、未知永久编号、跨家族工作簿和无效日期会被阻断。"]
  ]);
  instructions.getColumn(1).font = { ...font, bold: true };
  instructions.getColumn(2).font = font;
  instructions.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  instructions.getRow(1).height = 28;
  instructions.getCell("A1").font = { name: "Arial", size: 14, bold: true };

  const peopleSheet = workbook.addWorksheet("人物信息");
  const parentSheet = workbook.addWorksheet("亲子关系");
  const marriageSheet = workbook.addWorksheet("婚姻关系");
  const metadataSheet = workbook.addWorksheet("_系统元数据");
  const metadata = createWorkbookMetadata(context.workspaceId, kind);
  writeWorkbookMetadata(metadataSheet, metadata);

  peopleSheet.addRow([...CHINESE_HEADERS.人物信息]);
  parentSheet.addRow([...CHINESE_HEADERS.亲子关系]);
  marriageSheet.addRow([...CHINESE_HEADERS.婚姻关系]);
  const people = kind === "current" ? new PersonRepository(context.database, context.workspaceId).list() : [];
  const relations = new RelationRepository(context.database, context.workspaceId);
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const reference = (personId: string): string => {
    const person = peopleById.get(personId);
    if (!person) throw new Error(`Workbook relation references an unavailable person: ${personId}`);
    return `${person.personCode}｜${safe(person.displayName)}`;
  };
  for (const person of people) peopleSheet.addRow([
    person.personCode,
    safe(person.displayName),
    gender(person.gender),
    person.birth ? (person.birth.calendar === "solar" ? "公历" : "农历") : "",
    person.birth ? formatDateBody(person.birth) : "",
    safe(person.notes)
  ]);
  for (let index = 1; index <= reserved; index += 1) peopleSheet.addRow([code(index), "", "未知", "", "", ""]);
  if (kind === "current") {
    for (const relation of relations.listParentChild()) parentSheet.addRow([reference(relation.parentId), reference(relation.childId), relation.parentRole === "father" ? "父亲" : "母亲"]);
    for (const marriage of relations.listMarriages()) marriageSheet.addRow([reference(marriage.spouseAId), reference(marriage.spouseBId), marriage.status === "active" ? "婚姻中" : "已离婚", formatMarriageDate(marriage.start), formatMarriageDate(marriage.end)]);
  }
  for (let index = 0; index < reserved; index += 1) { parentSheet.addRow(["", "", "父亲"]); marriageSheet.addRow(["", "", "婚姻中", "", ""]); }

  const peopleLastRow = peopleSheet.rowCount;
  const parentLastRow = parentSheet.rowCount;
  const marriageLastRow = marriageSheet.rowCount;
  styleTable(peopleSheet, 6, peopleLastRow);
  styleTable(parentSheet, 3, parentLastRow);
  styleTable(marriageSheet, 5, marriageLastRow);
  peopleSheet.columns = [{ width: 14 }, { width: 20 }, { width: 10 }, { width: 12 }, { width: 18 }, { width: 40 }];
  parentSheet.columns = [{ width: 28 }, { width: 28 }, { width: 12 }];
  marriageSheet.columns = [{ width: 28 }, { width: 28 }, { width: 12 }, { width: 22 }, { width: 22 }];
  peopleSheet.getCell(`C2`).dataValidation = { type: "list", allowBlank: false, formulae: ['"男,女,未知"'] };
  peopleSheet.getCell(`D2`).dataValidation = { type: "list", allowBlank: true, formulae: ['"公历,农历"'] };
  for (let row = 2; row <= peopleLastRow; row += 1) {
    peopleSheet.getCell(row, 3).dataValidation = { type: "list", allowBlank: false, formulae: ['"男,女,未知"'] };
    peopleSheet.getCell(row, 4).dataValidation = { type: "list", allowBlank: true, formulae: ['"公历,农历"'] };
    peopleSheet.getCell(row, 1).protection = { locked: true };
  }
  const referenceStart = 8;
  metadataSheet.getCell(referenceStart, 4).value = "人物引用";
  for (let row = 2; row <= peopleLastRow; row += 1) metadataSheet.getCell(referenceStart + row - 1, 4).value = { formula: `'人物信息'!A${row}&IF('人物信息'!B${row}<>"","｜"&'人物信息'!B${row},"")` };
  const validationRange = `'_系统元数据'!$D$${referenceStart + 1}:$D$${referenceStart + peopleLastRow - 1}`;
  for (let row = 2; row <= parentLastRow; row += 1) {
    parentSheet.getCell(row, 1).dataValidation = { type: "list", allowBlank: true, formulae: [validationRange] };
    parentSheet.getCell(row, 2).dataValidation = { type: "list", allowBlank: true, formulae: [validationRange] };
    parentSheet.getCell(row, 3).dataValidation = { type: "list", allowBlank: false, formulae: ['"父亲,母亲"'] };
  }
  for (let row = 2; row <= marriageLastRow; row += 1) {
    marriageSheet.getCell(row, 1).dataValidation = { type: "list", allowBlank: true, formulae: [validationRange] };
    marriageSheet.getCell(row, 2).dataValidation = { type: "list", allowBlank: true, formulae: [validationRange] };
    marriageSheet.getCell(row, 3).dataValidation = { type: "list", allowBlank: false, formulae: ['"婚姻中,已离婚"'] };
  }
  await protectInputSheet(peopleSheet, [2, 3, 4, 5, 6], 2, peopleLastRow);
  await protectInputSheet(parentSheet, [1, 2, 3], 2, parentLastRow);
  await protectInputSheet(marriageSheet, [1, 2, 3, 4, 5], 2, marriageLastRow);
  metadataSheet.state = "veryHidden";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export const exportCurrentFamilyWorkbook = (context: ChineseWorkbookExportContext): Promise<Buffer> => exportWorkbook(context, "current");
export const exportBlankWorkbook = (context: ChineseWorkbookExportContext): Promise<Buffer> => exportWorkbook(context, "blank");
