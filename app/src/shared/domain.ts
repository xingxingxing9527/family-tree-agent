import { z } from "zod";

export type CalendarType = "solar" | "lunar";
export type DatePrecision = "month" | "day";

export interface PartialDate {
  calendar: CalendarType;
  year: number;
  month: number;
  day: number | null;
  leapMonth: boolean;
  precision: DatePrecision;
}

const partialDateInputSchema = z.object({
  calendar: z.enum(["solar", "lunar"]),
  year: z.number().int().min(1),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31).nullable(),
  leapMonth: z.boolean()
});

export function parsePartialDate(input: unknown): PartialDate {
  const value = partialDateInputSchema.parse(input);
  if (value.calendar === "solar" && value.leapMonth) {
    throw new Error("Solar dates cannot use leap months");
  }
  if (value.calendar === "solar" && value.day !== null) {
    const lastDay = new Date(Date.UTC(value.year, value.month, 0)).getUTCDate();
    if (value.day > lastDay) throw new Error("Invalid solar calendar day");
  }
  return { ...value, precision: value.day === null ? "month" : "day" };
}
