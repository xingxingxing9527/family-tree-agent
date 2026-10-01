// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { StagedMutationService } from "../../../src/main/application/mutations/staged-mutation-service";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";
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
        { id: "c1", disposition: "create", entityType: "person", entityId: "new-1", summary: "创建人物 王强", fieldChanges: [], originKind: "explicit", selectedByDefault: true, dependsOnChangeIds: [] },
        { id: "c2", disposition: "update", entityType: "person", entityId: "p1", summary: "更新人物 王建国", fieldChanges: [], originKind: "explicit", selectedByDefault: true, dependsOnChangeIds: [] },
        { id: "c3", disposition: "unchanged", entityType: "person", entityId: "p2", summary: "人物无变化", fieldChanges: [], originKind: "explicit", selectedByDefault: false, dependsOnChangeIds: [] },
        { id: "c4", disposition: "blocked", entityType: "marriage", entityId: null, summary: "创建婚姻", fieldChanges: [], originKind: "explicit", selectedByDefault: false, dependsOnChangeIds: [] }
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

  it("renders provenance and completion basis while info notices require no acknowledgement", () => {
    const preview: MutationPreview = {
      id: "draft-family",
      workspaceId: "workspace-1",
      version: 1,
      expiresAt: "2026-10-01T00:30:00.000Z",
      expectedVersions: {},
      changes: [
        { id: "explicit", disposition: "create", entityType: "parentChild", entityId: "edge-1", summary: "明确父亲 → 孩子：父亲", fieldChanges: [], originKind: "explicit", selectedByDefault: true, dependsOnChangeIds: [] },
        { id: "auto", disposition: "create", entityType: "parentChild", entityId: "edge-2", summary: "建议母亲 → 孩子：母亲（依据：唯一已确认配偶）", fieldChanges: [], originKind: "spouse_default", selectedByDefault: true, dependsOnChangeIds: ["explicit"] },
        { id: "missing", disposition: "blocked", entityType: "parentChild", entityId: null, summary: "另一位父母尚未确认", fieldChanges: [], originKind: "spouse_default", selectedByDefault: false, dependsOnChangeIds: ["explicit"] }
      ],
      issues: [{ changeId: "missing", severity: "info", code: "PARENT_COMPLETION_NO_CANDIDATE", message: "没有可用于补全的已确认婚姻配偶" }],
      canConfirm: true
    };
    const confirm = vi.fn();
    render(<MutationReviewDialog preview={preview} onCancel={vi.fn()} onConfirm={confirm} />);

    expect(screen.getAllByText("人工录入")).toHaveLength(1);
    expect(screen.getAllByText("系统自动补全")).toHaveLength(2);
    expect(screen.getByText(/唯一已确认配偶/u)).toBeInTheDocument();
    expect(screen.getByText("没有可用于补全的已确认婚姻配偶")).toBeInTheDocument();
    expect(screen.queryByLabelText(/PARENT_COMPLETION_NO_CANDIDATE/u)).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "确认写入" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(["explicit", "auto"], []);
  });

  it("cannot select an automatic change without its newly-created explicit dependency", () => {
    const preview: MutationPreview = {
      id: "draft-dependency",
      workspaceId: "workspace-1",
      version: 1,
      expiresAt: "2026-10-01T00:30:00.000Z",
      expectedVersions: {},
      changes: [
        { id: "explicit", disposition: "create", entityType: "parentChild", entityId: "edge-1", summary: "明确父亲", fieldChanges: [], originKind: "explicit", selectedByDefault: true, dependsOnChangeIds: [] },
        { id: "auto", disposition: "create", entityType: "parentChild", entityId: "edge-2", summary: "自动母亲", fieldChanges: [], originKind: "spouse_default", selectedByDefault: true, dependsOnChangeIds: ["explicit"] }
      ],
      issues: [],
      canConfirm: true
    };
    render(<MutationReviewDialog preview={preview} onCancel={vi.fn()} onConfirm={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("选择 明确父亲"));
    expect(screen.getByLabelText("选择 自动母亲")).not.toBeChecked();
    expect(screen.getByLabelText("选择 自动母亲")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("选择 明确父亲"));
    expect(screen.getByLabelText("选择 自动母亲")).toBeEnabled();
    expect(screen.getByLabelText("选择 自动母亲")).not.toBeChecked();
  });

  it("toggles and confirms a real staged correction only as one all-or-none group", () => {
    const database = openDatabase(":memory:");
    try {
      applyMigrations(database);
      const workspaceId = "workspace-1";
      const facts = new FactCommandService(database, workspaceId);
      const source = (sourceKey: string) => ({ sourceKey, title: sourceKey, kind: "test" });
      for (const [id, displayName] of [["old", "错误父亲"], ["replacement", "正确父亲"], ["child", "孩子"]] as const) {
        facts.execute({ type: "person.create", draft: { id, workspaceId, displayName, gender: "unknown" }, source: source(`person:${id}`) });
      }
      facts.execute({
        type: "parentChild.add",
        draft: { id: "old-edge", workspaceId, parentId: "old", childId: "child", parentRole: "father" },
        source: source("old-edge")
      });
      const service = new StagedMutationService(database, workspaceId);
      const preview = service.stage({ intents: [{
        type: "parentChild.correct",
        relationId: "old-edge",
        expectedVersion: 1,
        replacement: {
          knownParentId: "replacement",
          childId: "child",
          parentRole: "father",
          completionPolicy: "spouse-default",
          skipCompletion: true,
          sourceDescription: "人物中心关系更正"
        }
      }] });
      const [removal, replacement] = preview.changes;
      expect(removal?.selectionGroupId).toBeTruthy();
      expect(replacement?.selectionGroupId).toBe(removal?.selectionGroupId);
      const confirm = vi.fn((selectedChangeIds: string[], acknowledgedWarningCodes: string[]) => service.confirm({
        draftId: preview.id,
        draftVersion: preview.version,
        selectedChangeIds,
        acknowledgedWarningCodes
      }));
      render(<MutationReviewDialog preview={preview} onCancel={vi.fn()} onConfirm={confirm} />);

      const removalSelection = screen.getByLabelText(`选择 ${removal!.summary}`);
      const replacementSelection = screen.getByLabelText(`选择 ${replacement!.summary}`);
      fireEvent.click(replacementSelection);
      expect(removalSelection).not.toBeChecked();
      expect(replacementSelection).not.toBeChecked();
      expect(screen.getByRole("button", { name: "确认写入" })).toBeDisabled();

      fireEvent.click(removalSelection);
      expect(removalSelection).toBeChecked();
      expect(replacementSelection).toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: "确认写入" }));

      expect(confirm).toHaveBeenCalledWith([removal!.id, replacement!.id], []);
      expect(database.prepare("SELECT parent_id FROM parent_child WHERE child_id='child' AND deleted_at IS NULL").pluck().all())
        .toEqual(["replacement"]);
    } finally {
      database.close();
    }
  });
});
