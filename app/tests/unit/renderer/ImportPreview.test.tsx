// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportPlanDto } from "../../../src/shared/contracts";
import { FieldMappingStep } from "../../../src/renderer/src/features/import/FieldMappingStep";
import { ImportPreview } from "../../../src/renderer/src/features/import/ImportPreview";

afterEach(cleanup);

const plan: ImportPlanDto = {
  id: "plan-1",
  sourceKey: "archive",
  fileName: "family.xlsx",
  actions: [{
    id: "People:2:person",
    entityType: "person",
    kind: "update",
    sourceRow: { sheet: "People", row: 2, raw: { person_external_id: "A", name: "新姓名" } },
    entityId: "person-a",
    expectedRowVersion: 1,
    changes: [{ field: "displayName", before: "旧姓名", after: "新姓名" }],
    issueIds: ["warning-1"]
  }],
  issues: [
    { id: "warning-1", severity: "warning", code: "SAME_NAME_CANDIDATE", message: "发现同名候选", actionId: "People:2:person", evidence: { candidateEntityIds: ["person-b"] } },
    { id: "error-1", severity: "error", code: "MISSING_REFERENCE", message: "缺少引用", evidence: { row: 3 } }
  ],
  summary: { creates: 0, updates: 1, unchanged: 0, blocked: 0 }
};

describe("ImportPreview", () => {
  it("filters issues, exposes row exclusion, and renders field-level diffs", () => {
    const onToggleAction = vi.fn();
    render(<ImportPreview plan={plan} excludedActionIds={new Set()} onToggleAction={onToggleAction} />);

    expect(screen.getByText("displayName: 旧姓名 → 新姓名")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "包含 People 第 2 行" }));
    expect(onToggleAction).toHaveBeenCalledWith("People:2:person");

    fireEvent.change(screen.getByLabelText("问题筛选"), { target: { value: "error" } });
    expect(screen.getByText("MISSING_REFERENCE").closest("li")).toHaveTextContent("缺少引用");
    expect(screen.queryByText("发现同名候选")).not.toBeInTheDocument();
  });

  it("shows explicit CSV entity and column mapping controls", () => {
    const onEntityTypeChange = vi.fn();
    const onMappingChange = vi.fn();
    render(<FieldMappingStep entityType="People" mapping={{ name: "姓名" }} onEntityTypeChange={onEntityTypeChange} onMappingChange={onMappingChange} />);

    fireEvent.change(screen.getByLabelText("CSV 实体类型"), { target: { value: "ParentChild" } });
    expect(onEntityTypeChange).toHaveBeenCalledWith("ParentChild");
    expect(screen.getByLabelText("name 对应列")).toHaveValue("姓名");
  });
});
