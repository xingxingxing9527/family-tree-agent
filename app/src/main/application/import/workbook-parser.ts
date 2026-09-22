import { open, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";
import type { ImportCellValue, ImportSheet, ParseImportOptions, ParsedImport, ParsedImportRow } from "./import-types.js";

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
  throw new Error("Only text, numeric, boolean, and blank import cells are supported");
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

async function parseWorkbook(filePath: string, sourceKey: string): Promise<ParsedImport> {
  await preflightXlsxArchive(filePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
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
