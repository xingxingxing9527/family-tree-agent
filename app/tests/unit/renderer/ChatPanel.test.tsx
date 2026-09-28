// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../../../src/renderer/src/features/chat/ChatPanel";
import { MutationDraftPreview } from "../../../src/renderer/src/features/chat/MutationDraftPreview";
import { ModelSettings } from "../../../src/renderer/src/features/settings/ModelSettings";
import type { ConversationDraftPreview } from "../../../src/shared/chat";

afterEach(cleanup);

describe("controlled chat UI", () => {
  it("shows disclosure before every online send and supports cancellation", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<ChatPanel onSend={onSend} />);
    fireEvent.change(screen.getByLabelText("对话问题"), { target: { value: "张国强有几个孩子？" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.getByRole("dialog", { name: "在线模型披露" })).toHaveTextContent("问题、必要人物摘要和查询结果");
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.click(screen.getByRole("button", { name: "同意并发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("张国强有几个孩子？"));
  });

  it("renders source and relationship-path evidence", () => {
    render(<ChatPanel answer={{
      answer: "张敏是张国强的女儿。", matchedPersonIds: ["father", "child"], sourceIds: ["source-1"],
      relationship: {
        primaryTerm: "女儿", reverseTerm: "父亲", description: "父女关系", ruleVersion: "v1", alternatives: [], uncertainty: [],
        signature: { steps: ["child"], generationDelta: 1, lineageSide: "self", bloodAffinity: "blood", viewpointGender: "male", targetGender: "female", relativeAgeOrder: "unknown", pathPersonIds: ["father", "child"], pathRelationIds: ["edge-1"] }
      }, toolTrace: [{ name: "calculate_relationship", arguments: { viewpointId: "father", targetId: "child" } }]
    }} />);
    expect(screen.getByText("source-1")).toBeVisible();
    expect(screen.getByText("father → child")).toBeVisible();
  });

  it("offers confirmation only when a draft is fully resolved", () => {
    const preview: ConversationDraftPreview = {
      id: "draft", workspaceId: "workspace", version: 1, expiresAt: "2099-01-01T00:00:00.000Z",
      changes: [{ id: "change", kind: "create", entityType: "person", entityId: "person", summary: "创建人物 张敏", dependsOnChangeIds: [], fieldChanges: [{ field: "displayName", before: null, after: "张敏" }] }],
      creates: 1, updates: 0, warnings: [], conflicts: [], unresolvedReferences: []
    };
    const { rerender } = render(<MutationDraftPreview preview={{ ...preview, unresolvedReferences: [{ reference: "张敏", candidatePersonIds: ["a", "b"], reason: "同名" }] }} onConfirm={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "确认写入" })).not.toBeInTheDocument();
    rerender(<MutationDraftPreview preview={preview} onConfirm={vi.fn()} />);
    expect(screen.getByRole("button", { name: "确认写入" })).toBeEnabled();
  });

  it("resets selected changes when editing produces a new immutable draft version", () => {
    const onConfirm = vi.fn();
    const preview: ConversationDraftPreview = {
      id: "draft-1", workspaceId: "workspace", version: 1, expiresAt: "2099-01-01T00:00:00.000Z",
      changes: [{ id: "change-1", kind: "create", entityType: "person", entityId: "person-1", summary: "创建人物 一", dependsOnChangeIds: [], fieldChanges: [] }],
      creates: 1, updates: 0, warnings: [], conflicts: [], unresolvedReferences: []
    };
    const { rerender } = render(<MutationDraftPreview preview={preview} onConfirm={onConfirm} />);
    rerender(<MutationDraftPreview preview={{ ...preview, id: "draft-2", version: 2, changes: [{ ...preview.changes[0]!, id: "change-2", entityId: "person-2", summary: "创建人物 二" }] }} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "确认写入" }));
    expect(onConfirm).toHaveBeenCalledWith(["change-2"]);
  });

  it("saves a key without ever rendering its stored value", async () => {
    const settings = { status: vi.fn().mockResolvedValue({ ok: true, value: { configured: true } }), saveKey: vi.fn().mockResolvedValue({ ok: true, value: null }), clearKey: vi.fn() };
    render(<ModelSettings api={settings as never} />);
    await screen.findByText("已配置在线模型密钥");
    fireEvent.change(screen.getByLabelText("OpenAI API 密钥"), { target: { value: "sk-render-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "安全保存" }));
    await waitFor(() => expect(settings.saveKey).toHaveBeenCalledWith({ key: "sk-render-secret" }));
    expect(screen.queryByDisplayValue("sk-render-secret")).not.toBeInTheDocument();
  });
});
