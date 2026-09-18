import type { PartialDate } from "../../../../shared/domain";

export function formatPartialDate(value: PartialDate | null): string {
  if (!value) return "未记录";
  const calendar = value.calendar === "solar" ? "公历" : "农历";
  const leap = value.calendar === "lunar" && value.leapMonth ? "闰" : "";
  return `${calendar} ${value.year}年${leap}${value.month}月${value.day === null ? "" : `${value.day}日`}`;
}
