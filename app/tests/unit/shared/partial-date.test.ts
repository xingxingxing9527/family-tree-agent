import { describe, expect, it } from "vitest";
import { parsePartialDate } from "../../../src/shared/domain";

describe("parsePartialDate", () => {
  it("accepts lunar leap month 2 without a day and derives month precision", () => {
    expect(parsePartialDate({ calendar: "lunar", year: 2024, month: 2, day: null, leapMonth: true })).toEqual({
      calendar: "lunar", year: 2024, month: 2, day: null, leapMonth: true, precision: "month"
    });
  });

  it("rejects a year without a month", () => {
    expect(() => parsePartialDate({ calendar: "solar", year: 2024, day: null, leapMonth: false })).toThrow();
  });

  it("rejects leap months in the solar calendar", () => {
    expect(() => parsePartialDate({ calendar: "solar", year: 2024, month: 2, day: null, leapMonth: true })).toThrow();
  });

  it("rejects nonexistent solar calendar days", () => {
    expect(() => parsePartialDate({ calendar: "solar", year: 2024, month: 2, day: 30, leapMonth: false })).toThrow();
  });
});
