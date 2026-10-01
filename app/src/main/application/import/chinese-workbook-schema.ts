import type { PartialDate } from "../../../shared/domain.js";

export const CHINESE_WORKBOOK_SCHEMA_VERSION = 1;
export const CHINESE_SHEETS = ["填写说明", "人物信息", "亲子关系", "婚姻关系", "_系统元数据"] as const;
export const CHINESE_HEADERS = {
  人物信息: ["人物编号", "姓名", "性别", "出生历法", "出生日期", "备注"],
  亲子关系: ["父母人物", "子女人物", "父母身份"],
  婚姻关系: ["配偶一", "配偶二", "婚姻状态", "结婚日期", "离婚日期"]
} as const;

export type ChineseWorkbookKind = "current" | "blank";
export type ChineseDataSheet = keyof typeof CHINESE_HEADERS;

export const neutralizeFormulaText = (value: string): string => /^[=+\-@]/u.test(value) ? `'${value}` : value;
export const restoreNeutralizedText = (value: string): string => /^'[=+\-@]/u.test(value) ? value.slice(1) : value;

export const formatDateBody = (date: PartialDate): string => {
  const month = String(date.month).padStart(2, "0");
  const day = date.day === null ? "" : `-${String(date.day).padStart(2, "0")}`;
  return `${date.year}-${date.leapMonth ? "闰" : ""}${month}${day}`;
};

export const formatMarriageDate = (date: PartialDate | null): string => date
  ? `${date.calendar === "solar" ? "公历" : "农历"} ${formatDateBody(date)}`
  : "";

export function parseDateBody(value: string): { year: number; month: number; day: number | null; leapMonth: boolean } | null {
  const match = /^(\d{1,4})-(闰)?(\d{1,2})(?:-(\d{1,2}))?$/u.exec(value.trim());
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[3]), day: match[4] ? Number(match[4]) : null, leapMonth: Boolean(match[2]) };
}

export function parseMarriageDate(value: string): ({ calendar: PartialDate["calendar"] } & ReturnType<typeof parseDateBody>) | null {
  const match = /^(公历|农历)\s+(.+)$/u.exec(value.trim());
  if (!match) return null;
  const body = parseDateBody(match[2]!);
  return body ? { calendar: match[1] === "公历" ? "solar" : "lunar", ...body } : null;
}

export const personReferenceCode = (value: string): string => value.trim().split("｜", 1)[0]!.trim();
