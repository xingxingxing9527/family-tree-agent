import type { PartialDate } from "../../../shared/domain.js";

export type PartialDateIntervalRelation = "inside" | "outside" | "unknown";

interface DateRange {
  calendar: PartialDate["calendar"];
  minimum: CalendarPoint;
  maximum: CalendarPoint;
}

interface CalendarPoint {
  year: number;
  monthOrder: number;
  day: number;
}

function solarMonthLength(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function dateRange(date: PartialDate): DateRange {
  const monthOrder = date.calendar === "lunar"
    ? date.month * 2 + (date.leapMonth ? 1 : 0)
    : date.month;
  const maximumDay = date.calendar === "lunar" ? 30 : solarMonthLength(date.year, date.month);
  return {
    calendar: date.calendar,
    minimum: { year: date.year, monthOrder, day: date.day ?? 1 },
    maximum: { year: date.year, monthOrder, day: date.day ?? maximumDay }
  };
}

function comparePoint(left: CalendarPoint, right: CalendarPoint): number {
  if (left.year !== right.year) return left.year < right.year ? -1 : 1;
  if (left.monthOrder !== right.monthOrder) return left.monthOrder < right.monthOrder ? -1 : 1;
  if (left.day !== right.day) return left.day < right.day ? -1 : 1;
  return 0;
}

export function relationToPartialDateInterval(
  subject: PartialDate | null,
  start: PartialDate | null,
  end: PartialDate | null
): PartialDateIntervalRelation {
  if (!subject || (!start && !end)) return "unknown";

  const subjectRange = dateRange(subject);
  const startRange = start ? dateRange(start) : null;
  const endRange = end ? dateRange(end) : null;
  if ((startRange && startRange.calendar !== subjectRange.calendar)
    || (endRange && endRange.calendar !== subjectRange.calendar)) {
    return "unknown";
  }
  if ((startRange && comparePoint(subjectRange.maximum, startRange.minimum) < 0)
    || (endRange && comparePoint(subjectRange.minimum, endRange.maximum) > 0)) {
    return "outside";
  }

  const afterStart = !startRange || comparePoint(subjectRange.minimum, startRange.maximum) >= 0;
  const beforeEnd = !endRange || comparePoint(subjectRange.maximum, endRange.minimum) <= 0;
  return afterStart && beforeEnd ? "inside" : "unknown";
}
