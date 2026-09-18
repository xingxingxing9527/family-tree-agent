import React, { useEffect, useState, type JSX } from "react";
import type { CalendarType, PartialDate } from "../../../../shared/domain";

interface PartialDateFieldProps {
  label: string;
  value: PartialDate | null;
  onChange(value: PartialDate | null): void;
}

interface DateFields {
  calendar: "" | CalendarType;
  year: string;
  month: string;
  day: string;
  leapMonth: boolean;
}

const toFields = (value: PartialDate | null): DateFields => value
  ? {
      calendar: value.calendar,
      year: String(value.year),
      month: String(value.month),
      day: value.day === null ? "" : String(value.day),
      leapMonth: value.leapMonth
    }
  : { calendar: "", year: "", month: "", day: "", leapMonth: false };

export function PartialDateField({ label, value, onChange }: PartialDateFieldProps): JSX.Element {
  const [fields, setFields] = useState<DateFields>(() => toFields(value));

  useEffect(() => setFields(toFields(value)), [value]);

  const update = (patch: Partial<DateFields>): void => {
    const next = { ...fields, ...patch };
    if (next.calendar !== "lunar") next.leapMonth = false;
    setFields(next);
    if (!next.calendar) {
      onChange(null);
      return;
    }
    const year = Number(next.year);
    const month = Number(next.month);
    if (!Number.isInteger(year) || year < 1 || !Number.isInteger(month) || month < 1) return;
    const day = next.day === "" ? null : Number(next.day);
    onChange({
      calendar: next.calendar,
      year,
      month,
      day,
      leapMonth: next.calendar === "lunar" && next.leapMonth,
      precision: day === null ? "month" : "day"
    });
  };

  return (
    <fieldset className="date-field">
      <legend className="text-primary">{label}</legend>
      <label>
        <span>{label}历法</span>
        <select
          className="field-control"
          aria-label={`${label}历法`}
          value={fields.calendar}
          onChange={(event) => update({ calendar: event.target.value as DateFields["calendar"] })}
        >
          <option value="">未填写</option>
          <option value="solar">公历</option>
          <option value="lunar">农历</option>
        </select>
      </label>
      {fields.calendar && (
        <div className="date-grid">
          <label>
            <span>{label.replace("日期", "")}年份</span>
            <input className="field-control" aria-label={`${label.replace("日期", "")}年份`} type="number" min="1" required value={fields.year} onChange={(event) => update({ year: event.target.value })} />
          </label>
          <label>
            <span>{label.replace("日期", "")}月份</span>
            <input className="field-control" aria-label={`${label.replace("日期", "")}月份`} type="number" min="1" max="12" required value={fields.month} onChange={(event) => update({ month: event.target.value })} />
          </label>
          <label>
            <span>{label}</span>
            <input className="field-control" aria-label={label} type="number" min="1" max={fields.calendar === "lunar" ? 30 : 31} value={fields.day} onChange={(event) => update({ day: event.target.value })} />
          </label>
          {fields.calendar === "lunar" && (
            <label className="checkbox-field">
              <input aria-label={`${label}为闰月`} type="checkbox" checked={fields.leapMonth} onChange={(event) => update({ leapMonth: event.target.checked })} />
              <span>闰月</span>
            </label>
          )}
        </div>
      )}
    </fieldset>
  );
}
