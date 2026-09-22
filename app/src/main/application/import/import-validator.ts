import type { PartialDate } from "../../../shared/domain.js";
import { validatePartialDate } from "../../domain/validation/partial-date-validator.js";
import type { ImportCellValue, ImportIssue, ParsedImportRow } from "./import-types.js";

const text = (value: ImportCellValue | undefined): string => value === null || value === undefined ? "" : String(value);
const present = (value: ImportCellValue | undefined): boolean => text(value).trim().length > 0;

export const issueFor = (
  row: ParsedImportRow,
  severity: ImportIssue["severity"],
  code: string,
  message: string,
  evidence: Readonly<Record<string, unknown>> = {}
): ImportIssue => ({
  id: `${row.sheet}:${row.row}:${code}:${String(evidence.column ?? "row")}`,
  severity,
  code,
  message,
  evidence: { sheet: row.sheet, row: row.row, ...evidence }
});

export function requiredText(row: ParsedImportRow, column: string): { value?: string; issue?: ImportIssue } {
  const raw = row.raw[column];
  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    return { issue: issueFor(row, "error", "INVALID_VALUE", `${column} must be text`, { column, value: raw }) };
  }
  const value = text(raw);
  if (!value.trim()) {
    return { issue: issueFor(row, "error", "REQUIRED_FIELD", `${column} is required`, { column, value }) };
  }
  return { value };
}

export function enumValue<T extends string>(
  row: ParsedImportRow,
  column: string,
  values: readonly T[]
): { value?: T; issue?: ImportIssue } {
  const candidate = text(row.raw[column]);
  if ((values as readonly string[]).includes(candidate)) return { value: candidate as T };
  return { issue: issueFor(row, "error", "INVALID_VALUE", `${column} has an unsupported value`, { column, value: candidate, allowed: values }) };
}

const integer = (value: ImportCellValue | undefined): number | null => {
  if (!present(value)) return null;
  if (typeof value === "number") return Number.isInteger(value) ? value : Number.NaN;
  return /^-?\d+$/.test(String(value)) ? Number(value) : Number.NaN;
};

const booleanValue = (value: ImportCellValue | undefined): boolean | null => {
  if (!present(value)) return false;
  if (value === true || value === false) return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
};

export function partialDateFromRow(
  row: ParsedImportRow,
  prefix: "birth" | "start" | "end"
): { value: PartialDate | null; issues: ImportIssue[] } {
  const columns = [`${prefix}_calendar`, `${prefix}_year`, `${prefix}_month`, `${prefix}_day`, `${prefix}_leap_month`];
  const dateColumns = columns.slice(0, 4);
  if (!dateColumns.some((column) => present(row.raw[column]))) {
    if (booleanValue(row.raw[`${prefix}_leap_month`]) === true) {
      return { value: null, issues: [issueFor(row, "error", "INVALID_DATE", `${prefix} leap-month flag requires a date`, { columns })] };
    }
    return { value: null, issues: [] };
  }

  const calendar = text(row.raw[`${prefix}_calendar`]);
  const year = integer(row.raw[`${prefix}_year`]);
  const month = integer(row.raw[`${prefix}_month`]);
  const day = integer(row.raw[`${prefix}_day`]);
  const leapMonth = booleanValue(row.raw[`${prefix}_leap_month`]);
  if ((calendar !== "solar" && calendar !== "lunar") || year === null || month === null || Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day) || leapMonth === null) {
    return {
      value: null,
      issues: [issueFor(row, "error", "INVALID_DATE", `${prefix} date fields are incomplete or invalid`, {
        columns,
        values: Object.fromEntries(columns.map((column) => [column, row.raw[column] ?? null]))
      })]
    };
  }
  const value: PartialDate = {
    calendar,
    year,
    month,
    day,
    leapMonth,
    precision: day === null ? "month" : "day"
  };
  const validation = validatePartialDate(value);
  return validation.errors.length === 0 ? { value, issues: [] } : {
    value: null,
    issues: [issueFor(row, "error", "INVALID_DATE", validation.errors.map((entry) => entry.message).join("; "), {
      columns,
      values: Object.fromEntries(columns.map((column) => [column, row.raw[column] ?? null]))
    })]
  };
}
