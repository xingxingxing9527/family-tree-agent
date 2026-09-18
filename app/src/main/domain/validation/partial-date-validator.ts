import type { PartialDate } from "../../../shared/domain.js";

export interface DomainIssue {
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface ValidationResult {
  errors: DomainIssue[];
  warnings: DomainIssue[];
}

const invalidDate = (message: string): DomainIssue => ({
  code: "INVALID_DATE",
  message
});

export function validatePartialDate(value: PartialDate): ValidationResult {
  const errors: DomainIssue[] = [];
  const dayIsPresent = value.day !== null;

  if (value.calendar !== "solar" && value.calendar !== "lunar") {
    errors.push(invalidDate("Calendar must be solar or lunar"));
  }
  if (!Number.isInteger(value.year) || value.year < 1) {
    errors.push(invalidDate("Year must be a positive integer"));
  }
  if (!Number.isInteger(value.month) || value.month < 1 || value.month > 12) {
    errors.push(invalidDate("Month must be between 1 and 12"));
  }
  if (typeof value.leapMonth !== "boolean" || (value.calendar === "solar" && value.leapMonth)) {
    errors.push(invalidDate("Only lunar dates may use a leap month"));
  }
  if (value.precision !== (dayIsPresent ? "day" : "month")) {
    errors.push(invalidDate("Precision must match whether a day is present"));
  }

  if (dayIsPresent) {
    if (!Number.isInteger(value.day) || value.day! < 1) {
      errors.push(invalidDate("Day must be a positive integer"));
    } else if (value.calendar === "lunar" && value.day! > 30) {
      errors.push(invalidDate("Lunar day must be between 1 and 30"));
    } else if (
      value.calendar === "solar" &&
      Number.isInteger(value.year) &&
      value.year >= 1 &&
      Number.isInteger(value.month) &&
      value.month >= 1 &&
      value.month <= 12
    ) {
      const lastDay = new Date(Date.UTC(value.year, value.month, 0)).getUTCDate();
      if (value.day! > lastDay) {
        errors.push(invalidDate("Day is outside the selected Gregorian month"));
      }
    }
  }

  return { errors, warnings: [] };
}
