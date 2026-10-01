// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportPlanDto } from "../../../src/shared/contracts";
import { FieldMappingStep } from "../../../src/renderer/src/features/import/FieldMappingStep";
import { ImportPreview } from "../../../src/renderer/src/features/import/ImportPreview";
import { ImportPage } from "../../../src/renderer/src/features/import/ImportPage";

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
    issueIds: ["warning-1"],
    dependsOnActionIds: []
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
    fireEvent.click(screen.getByRole("checkbox", { name: "包含 人物信息 第 2 行" }));
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

  it("disables a relationship whose selected prerequisite has been excluded", () => {
    const dependent: ImportPlanDto = { ...plan, actions: [{
      ...plan.actions[0]!, id: "ParentChild:2:parentChild", entityType: "parentChild",
      sourceRow: { sheet: "ParentChild", row: 2, raw: {} }, dependsOnActionIds: ["People:2:person"]
    }] };
    render(<ImportPreview plan={dependent} excludedActionIds={new Set(["People:2:person"])} onToggleAction={vi.fn()} />);

    expect(screen.getByRole("checkbox", { name: "包含 亲子关系 第 2 行" })).toBeDisabled();
    expect(screen.getByText(/需要先包含/)).toBeVisible();
  });

  it("renders every final report row with disposition, entity, issues, and operation group", async () => {
    const api = {
      selectFile: vi.fn().mockResolvedValue({ ok: true, value: { fileToken: "11111111-1111-4111-8111-111111111111", fileName: "family.xlsx" } }),
      parse: vi.fn().mockResolvedValue({ ok: true, value: plan }),
      commit: vi.fn().mockResolvedValue({ ok: true, value: {
        planId: plan.id, sourceKey: plan.sourceKey, operationGroupId: "group-1", rows: [
          { actionId: "a", sheet: "People", row: 2, disposition: "committed", entityId: "person-a", issueCodes: ["WARN"], operationGroupId: "group-1" },
          { actionId: "b", sheet: "ParentChild", row: 3, disposition: "excluded", entityId: null, issueCodes: ["MISSING_REFERENCE"], operationGroupId: null }
        ]
      } }), exportTemplate: vi.fn()
    } as never;
    render(<ImportPage api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "选择导入文件" }));
    await waitFor(() => expect(screen.getByLabelText("已选导入文件")).toHaveTextContent("family.xlsx"));
    fireEvent.change(screen.getByLabelText("来源键"), { target: { value: "archive" } });
    fireEvent.click(screen.getByRole("button", { name: "解析并预览" }));
    await screen.findByText("导入预览");
    fireEvent.click(screen.getByRole("checkbox", { name: /我已核对/ }));
    fireEvent.click(screen.getByRole("button", { name: /确认导入/ }));
    await waitFor(() => expect(screen.getByLabelText("导入报告")).toBeVisible());
    const report = screen.getByLabelText("导入报告");
    expect(screen.getAllByText(/People 第 2 行/).find((node) => node.closest("section") === report)).toHaveTextContent(/committed.*person-a.*WARN.*group-1/);
    expect(screen.getByText(/ParentChild 第 3 行/)).toHaveTextContent(/excluded.*MISSING_REFERENCE/);
  });

  it("shows a sanitized error when file selection rejects", async () => {
    const api = { selectFile: vi.fn().mockRejectedValue(new Error("C:\\private\\family.xlsx")), parse: vi.fn(), commit: vi.fn(), exportTemplate: vi.fn() } as never;
    render(<ImportPage api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "选择导入文件" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法选择导入文件");
    expect(screen.queryByText(/private|family\.xlsx/u)).not.toBeInTheDocument();
  });

  it("offers separate current-family and blank Chinese workbook downloads", async () => {
    const api = {
      selectFile: vi.fn(), parse: vi.fn(), commit: vi.fn(), exportTemplate: vi.fn(),
      exportCurrentWorkbook: vi.fn().mockResolvedValue({ ok: false, error: { code: "INTERNAL", message: "测试结束" } }),
      exportBlankWorkbook: vi.fn().mockResolvedValue({ ok: false, error: { code: "INTERNAL", message: "测试结束" } })
    } as never;
    render(<ImportPage api={api} />);

    fireEvent.click(screen.getByRole("button", { name: "导出当前家谱表格" }));
    await waitFor(() => expect(api.exportCurrentWorkbook).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "下载空白导入模板" }));
    await waitFor(() => expect(api.exportBlankWorkbook).toHaveBeenCalledOnce());
  });
});
