import React, { type JSX } from "react";
import type { ImportSheetDto } from "../../../../shared/contracts";

const columns: Readonly<Record<ImportSheetDto, readonly string[]>> = {
  People: ["person_external_id", "name", "gender", "birth_calendar", "birth_year", "birth_month", "birth_day", "birth_leap_month", "notes"],
  ParentChild: ["parent_external_id", "child_external_id", "parent_role"],
  Marriages: ["spouse_a_external_id", "spouse_b_external_id", "status", "start_calendar", "start_year", "start_month", "start_day", "start_leap_month", "end_calendar", "end_year", "end_month", "end_day", "end_leap_month"]
};

interface FieldMappingStepProps {
  entityType: ImportSheetDto;
  mapping: Record<string, string>;
  onEntityTypeChange(entityType: ImportSheetDto): void;
  onMappingChange(mapping: Record<string, string>): void;
}

export function FieldMappingStep({ entityType, mapping, onEntityTypeChange, onMappingChange }: FieldMappingStepProps): JSX.Element {
  return (
    <fieldset className="import-card">
      <legend>CSV 字段映射</legend>
      <label>
        <span>CSV 实体类型</span>
        <select className="field-control" aria-label="CSV 实体类型" value={entityType} onChange={(event) => onEntityTypeChange(event.target.value as ImportSheetDto)}>
          <option value="People">People</option>
          <option value="ParentChild">ParentChild</option>
          <option value="Marriages">Marriages</option>
        </select>
      </label>
      <div className="mapping-grid">
        {columns[entityType].map((column) => (
          <label key={column}>
            <span>{column}</span>
            <input
              className="field-control"
              aria-label={`${column} 对应列`}
              value={mapping[column] ?? column}
              onChange={(event) => onMappingChange({ ...mapping, [column]: event.target.value })}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
