import { describe, expect, it } from "vitest";
import type { PartialDate } from "../../../src/shared/domain";
import { formatApproximateAge } from "../../../src/renderer/src/features/people/format-approximate-age";

const partialDate = (year: number, month: number, calendar: PartialDate["calendar"] = "solar"): PartialDate => ({
  calendar,
  year,
  month,
  day: null,
  leapMonth: false,
  precision: "month"
});

describe("formatApproximateAge", () => {
  const now = new Date(2026, 9, 2);

  it("uses only the recorded year and month for a fuzzy current age", () => {
    expect(formatApproximateAge(partialDate(1990, 9), null, now)).toBe("约 36 岁");
    expect(formatApproximateAge(partialDate(1990, 11), null, now)).toBe("约 35 岁");
  });

  it("keeps lunar dates approximate without performing calendar conversion", () => {
    expect(formatApproximateAge(partialDate(1990, 9, "lunar"), null, now)).toBe("约 36 岁");
  });

  it("uses the recorded death year and month for deceased people", () => {
    expect(formatApproximateAge(partialDate(1950, 10), partialDate(2020, 8), now)).toBe("享年约 69 岁");
  });

  it("omits age when birth is missing or later than the endpoint", () => {
    expect(formatApproximateAge(null, null, now)).toBeNull();
    expect(formatApproximateAge(partialDate(2030, 1), null, now)).toBeNull();
  });
});
