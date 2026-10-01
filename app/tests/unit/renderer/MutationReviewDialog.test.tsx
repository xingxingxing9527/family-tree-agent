// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MutationPreview } from "../../../src/shared/mutations";
import { MutationReviewDialog } from "../../../src/renderer/src/features/mutations/MutationReviewDialog";

afterEach(cleanup);

describe("MutationReviewDialog", () => {
  it("shows create, update, unchanged, warnings and blockers before confirm", () => {
    const preview: MutationPreview = {
      id: "draft-1",
      workspaceId: "workspace-1",
      version: 1,
      expiresAt: "2026-10-01T00:30:00.000Z",
      expectedVersions: { p1: 1 },
      changes: [
        { id: "c1", disposition: "create", entityType: "person", entityId: "new-1", summary: "创建人物 王强", fieldChanges: [] },
        { id: "c2", disposition: "update", entityType: "person", entityId: "p1", summary: "更新人物 王建国", fieldChanges: [] },
        { id: "c3", disposition: "unchanged", entityType: "person", entityId: "p2", summary: "人物无变化", fieldChanges: [] },
        { id: "c4", disposition: "blocked", entityType: "marriage", entityId: null, summary: "创建婚姻", fieldChanges: [] }
      ],
      issues: [
        { changeId: "c2", severity: "warning", code: "AGE_OUTLIER", message: "年龄差需要确认" },
        { changeId: "c4", severity: "error", code: "ACTIVE_MARRIAGE_EXISTS", message: "仍有有效婚姻" }
      ],
      canConfirm: true
    };
    const confirm = vi.fn();
    render(<MutationReviewDialog preview={preview} onCancel={vi.fn()} onConfirm={confirm} />);

    const dialog = screen.getByRole("dialog", { name: "确认写入" });
    expect(dialog).toHaveTextContent("新增");
    expect(dialog).toHaveTextContent("更新");
    expect(dialog).toHaveTextContent("未变化");
    expect(dialog).toHaveTextContent("阻断问题");
    expect(dialog).toHaveTextContent("年龄差需要确认");
    expect(dialog).toHaveTextContent("仍有有效婚姻");
    const button = screen.getByRole("button", { name: "确认写入" });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByLabelText("我已阅读 AGE_OUTLIER 提醒"));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(["c1", "c2"], ["AGE_OUTLIER"]);
  });
});
