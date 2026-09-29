// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataManagementApi } from "../../../src/shared/contracts";
import { AuditHistory } from "../../../src/renderer/src/features/settings/AuditHistory";
import { DataManagementPage } from "../../../src/renderer/src/features/settings/DataManagementPage";
import { PrivacyWarning } from "../../../src/renderer/src/features/settings/PrivacyWarning";

afterEach(cleanup);
const workspaceId = "11111111-1111-4111-8111-111111111111";
const fileToken = "22222222-2222-4222-8222-222222222222";
const restoreToken = "33333333-3333-4333-8333-333333333333";
const groupId = "44444444-4444-4444-8444-444444444444";
const counts = { people: 5, parentChild: 4, marriages: 1, wikiEntries: 2, auditRows: 20, mediaAssets: 3 };

function api(): DataManagementApi {
  return {
    listAudit: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    undoOperationGroup: vi.fn().mockResolvedValue({ ok: true, value: { operationGroupId: groupId, undoneAt: "2026-09-16T00:01:00.000Z", restoredEntities: 1 } }),
    createBackup: vi.fn().mockResolvedValue({ ok: true, value: { saved: true, verified: true, createdAt: "2026-09-16T00:00:00.000Z", schemaVersion: 4, counts } }),
    listRestoreTargets: vi.fn().mockResolvedValue({ ok: true, value: [{ id: workspaceId, name: "王氏家谱", directory: "opaque", originPersonId: null, lastOpenedAt: null, schemaVersion: 4 }] }),
    selectRestoreFile: vi.fn().mockResolvedValue({ ok: true, value: { selected: true, fileToken, fileName: "family.zip" } }),
    inspectBackup: vi.fn().mockResolvedValue({ ok: true, value: { restoreToken, targetWorkspaceId: workspaceId, verified: true, expiresAt: "2026-09-16T00:10:00.000Z", manifest: { formatVersion: 1, workspaceId, workspaceName: "王氏家谱", createdAt: "2026-09-16T00:00:00.000Z", schemaVersion: 4, counts } } }),
    restoreBackup: vi.fn().mockResolvedValue({ ok: true, value: { restored: true, automaticSnapshotVerified: true, cleanupPending: false } }),
    exportWorkspace: vi.fn().mockResolvedValue({ ok: true, value: { saved: true, files: 7, mediaAssets: 1 } })
  };
}

describe("data-management settings", () => {
  it("shows the exact unencrypted privacy warning before backup and export actions", () => {
    render(<PrivacyWarning />);
    expect(screen.getByText("该文件未加密，包含家族隐私资料。")).toBeVisible();
  });

  it("shows verified backup metadata, an explicit target, and requires a separate replacement confirmation", async () => {
    const value = api();
    const onMutationComplete = vi.fn().mockResolvedValue(undefined);
    render(<DataManagementPage api={value} onMutationComplete={onMutationComplete} />);
    expect(screen.getByText("该文件未加密，包含家族隐私资料。")).toBeVisible();
    expect(await screen.findByRole("option", { name: "王氏家谱" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "选择备份文件" }));
    expect(await screen.findByText("family.zip")).toBeVisible();
    fireEvent.change(screen.getByLabelText("恢复目标谱册"), { target: { value: workspaceId } });
    fireEvent.click(screen.getByRole("button", { name: "验证备份" }));

    expect(await screen.findByText("验证通过")).toBeVisible();
    expect(screen.getByText("2026-09-16T00:00:00.000Z")).toBeVisible();
    expect(screen.getByText("架构版本 4")).toBeVisible();
    expect(screen.getByText(/人物 5.*亲子 4.*婚姻 1.*词条 2.*审计 20.*媒体 3/)).toBeVisible();
    expect(screen.getByText("恢复目标：王氏家谱")).toBeVisible();
    const restore = screen.getByRole("button", { name: "替换目标谱册" });
    expect(restore).toBeDisabled();
    fireEvent.click(screen.getByLabelText("我确认用已验证备份替换王氏家谱"));
    fireEvent.click(restore);
    await waitFor(() => expect(value.restoreBackup).toHaveBeenCalledWith({ restoreToken, targetWorkspaceId: workspaceId, confirmReplace: true }));
    await waitFor(() => expect(onMutationComplete).toHaveBeenCalledWith(workspaceId));
  });

  it("keeps backup and export path selection entirely inside the API", async () => {
    const value = api();
    render(<DataManagementPage api={value} />);
    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    fireEvent.click(screen.getByRole("button", { name: "导出资料" }));
    await waitFor(() => expect(value.createBackup).toHaveBeenCalledWith());
    expect(value.exportWorkspace).toHaveBeenCalledWith();
  });

  it("turns rejected data-management operations into a sanitized visible failure", async () => {
    const value = api();
    vi.mocked(value.createBackup).mockRejectedValue(new Error("C:\\private\\family.sqlite"));
    render(<DataManagementPage api={value} />);
    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("操作失败，请稍后重试");
    expect(screen.queryByText(/private|family\.sqlite/u)).not.toBeInTheDocument();
  });

  it("distinguishes a committed restore whose old-directory cleanup is still pending", async () => {
    const value = api();
    vi.mocked(value.restoreBackup).mockResolvedValue({ ok: true, value: { restored: true, automaticSnapshotVerified: true, cleanupPending: true } });
    render(<DataManagementPage api={value} />);
    await screen.findByRole("option", { name: "王氏家谱" });
    fireEvent.click(screen.getByRole("button", { name: "选择备份文件" }));
    await screen.findByText("family.zip");
    fireEvent.click(screen.getByRole("button", { name: "验证备份" }));
    await screen.findByText("验证通过");
    fireEvent.click(screen.getByLabelText("我确认用已验证备份替换王氏家谱"));
    fireEvent.click(screen.getByRole("button", { name: "替换目标谱册" }));

    expect(await screen.findByText("恢复已提交，旧工作区清理待完成")).toBeVisible();
  });

  it("does not refresh authoritative state when restore is rejected", async () => {
    const value = api();
    vi.mocked(value.restoreBackup).mockResolvedValue({ ok: false, error: { code: "VALIDATION", message: "备份不可用" } });
    const onMutationComplete = vi.fn();
    render(<DataManagementPage api={value} onMutationComplete={onMutationComplete} />);
    await screen.findByRole("option", { name: "王氏家谱" });
    fireEvent.click(screen.getByRole("button", { name: "选择备份文件" }));
    await screen.findByText("family.zip");
    fireEvent.click(screen.getByRole("button", { name: "验证备份" }));
    await screen.findByText("验证通过");
    fireEvent.click(screen.getByLabelText("我确认用已验证备份替换王氏家谱"));
    fireEvent.click(screen.getByRole("button", { name: "替换目标谱册" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("备份不可用");
    expect(onMutationComplete).not.toHaveBeenCalled();
  });

  it("shows the reason a history group cannot be undone and refreshes after an allowed undo", async () => {
    const value = api();
    vi.mocked(value.listAudit).mockResolvedValue({ ok: true, value: [
      { id: groupId, kind: "manual.edit", createdAt: "2026-09-16T00:00:00.000Z", status: "available", affectedEntities: [{ entityType: "person", entityId: "person-one" }], undoable: true, reason: null, undoneAt: null },
      { id: workspaceId, kind: "person.merge", createdAt: "2026-09-15T00:00:00.000Z", status: "blocked", affectedEntities: [], undoable: false, reason: "Merge groups require the dedicated unmerge workflow", undoneAt: null }
    ] });
    const onMutationComplete = vi.fn().mockResolvedValue(undefined);
    render(<AuditHistory api={value} onMutationComplete={onMutationComplete} />);
    expect(await screen.findByText("Merge groups require the dedicated unmerge workflow")).toBeVisible();
    expect(screen.queryByRole("button", { name: `撤销 ${workspaceId}` })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `撤销 ${groupId}` }));
    expect(value.undoOperationGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "确认撤销操作" })).toHaveTextContent("person:person-one");
    fireEvent.click(screen.getByLabelText("我确认撤销以上 1 个受影响实体"));
    fireEvent.click(screen.getByRole("button", { name: "确认撤销" }));
    await waitFor(() => expect(value.undoOperationGroup).toHaveBeenCalledWith({ operationGroupId: groupId }));
    await waitFor(() => expect(onMutationComplete).toHaveBeenCalledWith());
    expect(value.listAudit).toHaveBeenCalledTimes(1);
  });

  it("sanitizes a rejected audit-history request", async () => {
    const value = api();
    vi.mocked(value.listAudit).mockRejectedValue(new Error("C:\\private\\audit.sqlite 张敏"));
    render(<AuditHistory api={value} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取操作历史");
    expect(screen.queryByText(/private|audit\.sqlite/u)).not.toBeInTheDocument();
  });

  it("does not refresh authoritative state when undo is rejected", async () => {
    const value = api();
    vi.mocked(value.listAudit).mockResolvedValue({ ok: true, value: [{
      id: groupId, kind: "manual.edit", createdAt: "2026-09-16T00:00:00.000Z", status: "available",
      affectedEntities: [{ entityType: "person", entityId: "person-one" }], undoable: true, reason: null, undoneAt: null
    }] });
    vi.mocked(value.undoOperationGroup).mockResolvedValue({ ok: false, error: { code: "CONFLICT", message: "撤销冲突" } });
    const onMutationComplete = vi.fn();
    render(<AuditHistory api={value} onMutationComplete={onMutationComplete} />);
    fireEvent.click(await screen.findByRole("button", { name: `撤销 ${groupId}` }));
    fireEvent.click(screen.getByLabelText("我确认撤销以上 1 个受影响实体"));
    fireEvent.click(screen.getByRole("button", { name: "确认撤销" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("撤销冲突");
    expect(onMutationComplete).not.toHaveBeenCalled();
  });
});
