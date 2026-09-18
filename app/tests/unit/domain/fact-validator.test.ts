import { describe, expect, it } from "vitest";
import { validatePartialDate } from "../../../src/main/domain/validation/partial-date-validator";
import { wouldCreateParentCycle } from "../../../src/main/domain/validation/graph-cycle-detector";
import { validateParentChildFact } from "../../../src/main/domain/validation/fact-validator";

const solar = (year: number, month = 1, day: number | null = null) => ({
  calendar: "solar" as const,
  year,
  month,
  day,
  leapMonth: false,
  precision: day === null ? "month" as const : "day" as const
});

describe("partial-date validation", () => {
  it("rejects impossible solar dates and solar leap-month flags", () => {
    expect(validatePartialDate(solar(2023, 2, 29)).errors.map((issue) => issue.code)).toContain("INVALID_DATE");
    expect(validatePartialDate({ ...solar(2024, 2, 29), leapMonth: true }).errors.map((issue) => issue.code)).toContain("INVALID_DATE");
    expect(validatePartialDate(solar(2024, 2, 29)).errors).toEqual([]);
  });

  it("rejects February 29 in a huge non-leap year beyond the ECMAScript Date range", () => {
    expect(validatePartialDate(solar(275761, 2, 29)).errors.map((issue) => issue.code)).toContain("INVALID_DATE");
  });

  it("accepts February 29 in a huge Gregorian leap year", () => {
    expect(validatePartialDate(solar(400000, 2, 29)).errors).toEqual([]);
  });

  it("validates lunar storage bounds without converting calendars", () => {
    const lunar = { calendar: "lunar" as const, year: 2024, month: 12, day: 30, leapMonth: true, precision: "day" as const };
    expect(validatePartialDate(lunar).errors).toEqual([]);
    expect(validatePartialDate({ ...lunar, month: 13 }).errors.map((issue) => issue.code)).toContain("INVALID_DATE");
    expect(validatePartialDate({ ...lunar, day: 31 }).errors.map((issue) => issue.code)).toContain("INVALID_DATE");
  });

  it("requires precision to match whether day is present", () => {
    expect(validatePartialDate({ ...solar(2024, 1), precision: "day" }).errors.map((issue) => issue.code)).toContain("INVALID_DATE");
    expect(validatePartialDate({ ...solar(2024, 1, 2), precision: "month" }).errors.map((issue) => issue.code)).toContain("INVALID_DATE");
  });
});

describe("genealogy invariant validation", () => {
  it("detects a proposed parent cycle", () => {
    const edges = [
      { parentId: "A", childId: "B" },
      { parentId: "B", childId: "C" }
    ];
    expect(wouldCreateParentCycle("C", "A", edges)).toBe(true);
    expect(wouldCreateParentCycle("A", "C", edges)).toBe(false);
  });

  it("rejects impossible chronology and warns for parent ages outside 12-80", () => {
    const impossible = validateParentChildFact(
      { id: "p", workspaceId: "w", birth: solar(2000) },
      { id: "c", workspaceId: "w", birth: solar(1999) },
      []
    );
    expect(impossible.errors.map((issue) => issue.code)).toContain("IMPOSSIBLE_DATE");

    const young = validateParentChildFact(
      { id: "p", workspaceId: "w", birth: solar(2000) },
      { id: "c", workspaceId: "w", birth: solar(2010) },
      []
    );
    expect(young.warnings.map((issue) => issue.code)).toContain("PARENT_AGE_OUTLIER");

    const old = validateParentChildFact(
      { id: "p", workspaceId: "w", birth: solar(1900) },
      { id: "c", workspaceId: "w", birth: solar(1981) },
      []
    );
    expect(old.warnings.map((issue) => issue.code)).toContain("PARENT_AGE_OUTLIER");
  });
});
