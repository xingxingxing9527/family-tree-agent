import { open, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";
import type { ImportCellValue, ImportSheet, ParseImportOptions, ParsedImport, ParsedImportRow } from "./import-types.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_CELL_CHARACTERS = 32_768;

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
  throw new Error("Only text, numeric, boolean, and blank import cells are supported");
};

const nonBlank = (row: Record<string, ImportCellValue>): boolean => Object.values(row).some((entry) => entry !== null && String(entry).length > 0);

async function parseWorkbook(filePath: string, sourceKey: string): Promise<ParsedImport> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const rows: ParsedImportRow[] = [];
  for (const sheetName of Object.keys(IMPORT_TEMPLATE_COLUMNS) as ImportSheet[]) {
    const worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) throw new Error(`Missing required worksheet: ${sheetName}`);
    const required = IMPORT_TEMPLATE_COLUMNS[sheetName];
    const headers = worksheet.getRow(1).values as ExcelJS.CellValue[];
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
  if (extension === ".xlsx") return parseWorkbook(filePath, sourceKey);
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
