import { open, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";
import { CHINESE_HEADERS, CHINESE_SHEETS, parseDateBody, parseMarriageDate, personReferenceCode, restoreNeutralizedText } from "./chinese-workbook-schema.js";
import type { ImportCellValue, ImportSheet, ParseImportOptions, ParsedImport, ParsedImportRow } from "./import-types.js";
import { readWorkbookMetadata, workbookSourceKey } from "./workbook-metadata.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_CELL_CHARACTERS = 32_768;
const MAX_ZIP_ENTRIES = 200;
const MAX_ZIP_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_RATIO = 100;

export const IMPORT_TEMPLATE_COLUMNS: Readonly<Record<ImportSheet, readonly string[]>> = {
  People: ["person_external_id", "name", "gender", "birth_calendar", "birth_year", "birth_month", "birth_day", "birth_leap_month", "notes"],
  ParentChild: ["parent_external_id", "child_external_id", "parent_role"],
  Marriages: ["spouse_a_external_id", "spouse_b_external_id", "status", "start_calendar", "start_year", "start_month", "start_day", "start_leap_month", "end_calendar", "end_year", "end_month", "end_day", "end_leap_month"]
};

const cellValue = (value: ExcelJS.CellValue): ImportCellValue => {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > MAX_CELL_CHARACTERS) throw new Error("Import cell is too large");
    return value ?? null;
  }
  throw new Error("Formula cells are not supported; only text, numeric, boolean, and blank import cells are allowed");
};

const nonBlank = (row: Record<string, ImportCellValue>): boolean => Object.values(row).some((entry) => entry !== null && String(entry).length > 0);

const equalColumns = (actual: unknown[], expected: readonly string[]): boolean => actual.length === expected.length && actual.every((value, index) => value === expected[index]);

export async function preflightXlsxArchive(filePath: string): Promise<void> {
  const archive = await readFile(filePath);
  const start = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let index = archive.length - 22; index >= start; index -= 1) {
    if (archive.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("XLSX archive has no central directory");
  const entries = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error("ZIP64 XLSX archives are not supported");
  if (entries > MAX_ZIP_ENTRIES || directoryOffset + directorySize > eocd) throw new Error("XLSX archive exceeds structural limits");
  let cursor = directoryOffset; let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > directoryOffset + directorySize || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("XLSX central directory is invalid");
    const compressed = archive.readUInt32LE(cursor + 20); const uncompressed = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28); const extraLength = archive.readUInt16LE(cursor + 30); const commentLength = archive.readUInt16LE(cursor + 32);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > directoryOffset + directorySize) throw new Error("XLSX archive entry is invalid");
    const name = archive.subarray(cursor + 46, nameEnd).toString("utf8").replaceAll("\\", "/");
    if (!name || isAbsolute(name) || name.split("/").some((part) => part === ".." || part === "" && name.includes("//"))) throw new Error("XLSX archive contains an unsafe entry name");
    if (name === "xl/vbaProject.bin" || name === "xl/connections.xml" || name.startsWith("xl/externalLinks/") || name.startsWith("xl/embeddings/")) throw new Error("XLSX archive contains forbidden content");
    if (uncompressed > MAX_ZIP_ENTRY_BYTES || (compressed > 0 && uncompressed / compressed > MAX_ZIP_RATIO)) throw new Error("XLSX archive exceeds uncompressed size or compression ratio limits");
    total += uncompressed; if (total > MAX_ZIP_TOTAL_BYTES) throw new Error("XLSX archive exceeds total uncompressed size limit");
    cursor = nameEnd + extraLength + commentLength;
  }
  if (cursor !== directoryOffset + directorySize) throw new Error("XLSX central directory has trailing data");
}

const canonicalPersonReference = (value: string, batchId: string): string => {
  const code = personReferenceCode(value);
  return /^N\d{3,}$/u.test(code) ? `batch:${batchId}:${code}` : code;
};

const chineseCell = (worksheet: ExcelJS.Worksheet, row: number, column: number): ImportCellValue => cellValue(worksheet.getCell(row, column).value);
const chineseText = (value: ImportCellValue): string => value === null ? "" : String(value).trim();

function addChineseDate(raw: Record<string, ImportCellValue>, prefix: "birth" | "start" | "end", calendar: "solar" | "lunar" | "", body: string): void {
  if (!body && !calendar) {
    Object.assign(raw, { [`${prefix}_calendar`]: "", [`${prefix}_year`]: "", [`${prefix}_month`]: "", [`${prefix}_day`]: "", [`${prefix}_leap_month`]: false });
    return;
  }
  const parsed = parseDateBody(body);
  if (!parsed || !calendar) throw new Error(`Invalid ${prefix} date format`);
  Object.assign(raw, {
    [`${prefix}_calendar`]: calendar,
    [`${prefix}_year`]: parsed.year,
    [`${prefix}_month`]: parsed.month,
    [`${prefix}_day`]: parsed.day ?? "",
    [`${prefix}_leap_month`]: parsed.leapMonth
  });
}

async function parseChineseWorkbook(workbook: ExcelJS.Workbook, filePath: string, options: ParseImportOptions): Promise<ParsedImport> {
  if (workbook.worksheets.length !== CHINESE_SHEETS.length || workbook.worksheets.some((sheet, index) => sheet.name !== CHINESE_SHEETS[index])) {
    throw new Error("Chinese XLSX workbook must use the exact template sheets");
  }
  const metadataSheet = workbook.getWorksheet("_系统元数据");
  if (!metadataSheet || metadataSheet.state !== "veryHidden") throw new Error("Workbook metadata sheet is missing or visible");
  const metadata = readWorkbookMetadata(metadataSheet);
  if (options.expectedWorkspaceId && metadata.workspaceId !== options.expectedWorkspaceId) throw new Error("Workbook belongs to a different workspace or family");
  const rows: ParsedImportRow[] = [];
  const people = workbook.getWorksheet("人物信息")!;
  const parentChild = workbook.getWorksheet("亲子关系")!;
  const marriages = workbook.getWorksheet("婚姻关系")!;
  for (const [sheet, expected] of [[people, CHINESE_HEADERS.人物信息], [parentChild, CHINESE_HEADERS.亲子关系], [marriages, CHINESE_HEADERS.婚姻关系]] as const) {
    const headers = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((entry) => cellValue(entry ?? null));
    if (!equalColumns(headers, expected)) throw new Error(`Chinese XLSX workbook must use the exact columns for ${sheet.name}`);
    if (sheet.actualRowCount - 1 > MAX_ROWS) throw new Error("Import exceeds the row limit");
  }
  for (let row = 2; row <= people.actualRowCount; row += 1) {
    const cells = Array.from({ length: 6 }, (_, index) => chineseCell(people, row, index + 1));
    if (!cells.slice(1).some((entry) => chineseText(entry).length > 0 && chineseText(entry) !== "未知")) continue;
    const externalId = canonicalPersonReference(chineseText(cells[0]!), metadata.batchId);
    const calendar = chineseText(cells[3]!) === "公历" ? "solar" : chineseText(cells[3]!) === "农历" ? "lunar" : "";
    const raw: Record<string, ImportCellValue> = {
      person_external_id: externalId,
      name: restoreNeutralizedText(chineseText(cells[1]!)),
      gender: chineseText(cells[2]!) === "男" ? "male" : chineseText(cells[2]!) === "女" ? "female" : chineseText(cells[2]!) === "未知" ? "unknown" : chineseText(cells[2]!),
      notes: restoreNeutralizedText(chineseText(cells[5]!))
    };
    addChineseDate(raw, "birth", calendar, chineseText(cells[4]!));
    rows.push({ sheet: "People", row, raw });
  }
  for (let row = 2; row <= parentChild.actualRowCount; row += 1) {
    const parent = chineseText(chineseCell(parentChild, row, 1));
    const child = chineseText(chineseCell(parentChild, row, 2));
    if (!parent && !child) continue;
    const role = chineseText(chineseCell(parentChild, row, 3));
    rows.push({ sheet: "ParentChild", row, raw: {
      parent_external_id: canonicalPersonReference(parent, metadata.batchId),
      child_external_id: canonicalPersonReference(child, metadata.batchId),
      parent_role: role === "父亲" ? "father" : role === "母亲" ? "mother" : role
    } });
  }
  for (let row = 2; row <= marriages.actualRowCount; row += 1) {
    const spouseA = chineseText(chineseCell(marriages, row, 1));
    const spouseB = chineseText(chineseCell(marriages, row, 2));
    if (!spouseA && !spouseB) continue;
    const status = chineseText(chineseCell(marriages, row, 3));
    const raw: Record<string, ImportCellValue> = {
      spouse_a_external_id: canonicalPersonReference(spouseA, metadata.batchId),
      spouse_b_external_id: canonicalPersonReference(spouseB, metadata.batchId),
      status: status === "婚姻中" ? "active" : status === "已离婚" ? "divorced" : status
    };
    for (const [prefix, column] of [["start", 4], ["end", 5]] as const) {
      const text = chineseText(chineseCell(marriages, row, column));
      if (!text) addChineseDate(raw, prefix, "", "");
      else {
        const parsed = parseMarriageDate(text);
        if (!parsed) throw new Error(`Invalid ${prefix} date format`);
        addChineseDate(raw, prefix, parsed.calendar, text.replace(/^(公历|农历)\s+/u, ""));
      }
    }
    rows.push({ sheet: "Marriages", row, raw });
  }
  return { sourceKey: workbookSourceKey(metadata), fileName: basename(filePath), rows, metadata };
}

async function parseWorkbook(filePath: string, sourceKey: string, options: ParseImportOptions): Promise<ParsedImport> {
  await preflightXlsxArchive(filePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  if (workbook.worksheets[0]?.name === "填写说明") return parseChineseWorkbook(workbook, filePath, options);
  const expectedSheets = Object.keys(IMPORT_TEMPLATE_COLUMNS) as ImportSheet[];
  if (workbook.worksheets.length !== expectedSheets.length || workbook.worksheets.some((sheet, index) => sheet.name !== expectedSheets[index])) {
    throw new Error("XLSX workbook must use the exact template sheets");
  }
  const rows: ParsedImportRow[] = [];
  for (const sheetName of Object.keys(IMPORT_TEMPLATE_COLUMNS) as ImportSheet[]) {
    const worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) throw new Error(`Missing required worksheet: ${sheetName}`);
    const required = IMPORT_TEMPLATE_COLUMNS[sheetName];
    const headers = worksheet.getRow(1).values as ExcelJS.CellValue[];
    const headerValues = headers.slice(1).map((header) => cellValue(header ?? null));
    if (!equalColumns(headerValues, required)) throw new Error(`XLSX workbook must use the exact template columns for ${sheetName}`);
    const positions = new Map<string, number>();
    for (let column = 1; column < headers.length; column += 1) {
      const header = cellValue(headers[column] ?? null);
      if (typeof header === "string") positions.set(header, column);
    }
    for (const column of required) {
      if (!positions.has(column)) throw new Error(`Missing required column ${sheetName}.${column}`);
    }
    if (worksheet.actualRowCount - 1 > MAX_ROWS || rows.length + Math.max(0, worksheet.actualRowCount - 1) > MAX_ROWS) {
      throw new Error("Import exceeds the row limit");
    }
    worksheet.eachRow((worksheetRow, rowNumber) => {
      if (rowNumber === 1) return;
      const raw = Object.fromEntries(required.map((column) => [column, cellValue(worksheetRow.getCell(positions.get(column)!).value)]));
      if (nonBlank(raw)) rows.push({ sheet: sheetName, row: rowNumber, raw });
    });
  }
  return { sourceKey, fileName: basename(filePath), rows };
}

async function parseCsvFile(filePath: string, sourceKey: string, options: ParseImportOptions): Promise<ParsedImport> {
  const sheet = options.csvEntityType;
  if (!sheet || !(sheet in IMPORT_TEMPLATE_COLUMNS)) throw new Error("CSV import requires an entity type");
  const records = parseCsv(await import("node:fs/promises").then(({ readFile }) => readFile(filePath, "utf8")), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    max_record_size: MAX_CELL_CHARACTERS * IMPORT_TEMPLATE_COLUMNS[sheet].length,
    to_line: MAX_ROWS + 2
  }) as Record<string, string>[];
  if (records.length > MAX_ROWS) throw new Error("Import exceeds the row limit");
  const mapping = options.fieldMapping ?? {};
  const required = IMPORT_TEMPLATE_COLUMNS[sheet];
  const available = new Set(records.length > 0 ? Object.keys(records[0]!) : []);
  for (const column of required) {
    const sourceColumn = mapping[column] ?? column;
    if (!available.has(sourceColumn)) throw new Error(`Missing required column ${sheet}.${column}`);
  }
  const rows = records.map((record, index) => {
    const raw = Object.fromEntries(required.map((column) => {
      const cell = record[mapping[column] ?? column] ?? "";
      if (cell.length > MAX_CELL_CHARACTERS) throw new Error("Import cell is too large");
      return [column, cell];
    }));
    return { sheet, row: index + 2, raw } satisfies ParsedImportRow;
  });
  return { sourceKey, fileName: basename(filePath), rows };
}

export async function parseImport(filePath: string, sourceKey: string, options: ParseImportOptions = {}): Promise<ParsedImport> {
  if (!filePath || !sourceKey.trim()) throw new Error("File path and source key are required");
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error("Import path is not a file");
  if (metadata.size > MAX_FILE_BYTES) throw new Error("Import file exceeds 10 MiB");
  const extension = extname(filePath).toLowerCase();
  if (extension === ".xlsx") return parseWorkbook(filePath, sourceKey, options);
  if (extension === ".csv") return parseCsvFile(filePath, sourceKey, options);
  throw new Error("Only .xlsx and .csv imports are supported");
}

export async function exportImportTemplate(targetFile: string): Promise<string> {
  if (extname(targetFile).toLowerCase() !== ".xlsx") throw new Error("Template target must use .xlsx");
  let reservation;
  try {
    reservation = await open(targetFile, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Template target already exists");
    throw error;
  }
  await reservation.close();
  const workbook = new ExcelJS.Workbook();
  for (const sheet of Object.keys(IMPORT_TEMPLATE_COLUMNS) as ImportSheet[]) {
    workbook.addWorksheet(sheet).addRow([...IMPORT_TEMPLATE_COLUMNS[sheet]]);
  }
  try {
    await workbook.xlsx.writeFile(targetFile);
  } catch (error) {
    await import("node:fs/promises").then(({ unlink }) => unlink(targetFile).catch(() => undefined));
    throw error;
  }
  return targetFile;
}
