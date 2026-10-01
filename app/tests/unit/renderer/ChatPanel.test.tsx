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
      status: "answered", conclusion: "张敏是张国强的女儿。", answer: "张敏是张国强的女儿。",
      viewpoint: { id: "father", displayName: "张国强" },
      relationshipPath: [{ personId: "father", displayName: "张国强" }, { personId: "child", displayName: "张敏" }],
      evidence: [{ id: "source-1", title: "张氏家谱原件" }], candidates: [], missingFacts: [],
      matchedPersonIds: ["father", "child"], sourceIds: ["source-1"],
      relationship: {
        primaryTerm: "女儿", reverseTerm: "父亲", description: "父女关系", ruleVersion: "v1", alternatives: [], uncertainty: [],
        signature: { steps: ["child"], generationDelta: 1, lineageSide: "self", bloodAffinity: "blood", viewpointGender: "male", targetGender: "female", relativeAgeOrder: "unknown", pathPersonIds: ["father", "child"], pathRelationIds: ["edge-1"] }
      }, toolTrace: [{ name: "calculate_relationship", arguments: { viewpointId: "father", targetId: "child" } }]
    }} />);
    expect(screen.getByText("回答视角：张国强")).toBeVisible();
    expect(screen.getByText("张氏家谱原件")).toBeVisible();
    expect(screen.getByText("张国强 → 张敏")).toBeVisible();
  });

  it("shows disambiguation candidates without presenting a guessed answer", () => {
    const onSelectCandidate = vi.fn();
    render(<ChatPanel onSelectCandidate={onSelectCandidate} answer={{
      status: "needs_disambiguation", conclusion: "找到两位同名人物，请先选择。", answer: "找到两位同名人物，请先选择。",
      viewpoint: { id: "viewpoint", displayName: "王明" }, relationshipPath: [], evidence: [], missingFacts: [],
      candidates: [
        { id: "a", displayName: "张敏", aliases: [], gender: "female", birth: null, parentHints: [] },
        { id: "b", displayName: "张敏", aliases: [], gender: "male", birth: null, parentHints: [] }
      ], matchedPersonIds: [], sourceIds: [], relationship: null, toolTrace: []
    }} />);
    expect(screen.getByRole("heading", { name: "需要确认人物" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /选择张敏.*女/u }));
    expect(onSelectCandidate).toHaveBeenCalledWith("a");
  });

  it("offers a direct person action when facts are insufficient", () => {
    const onOpenPerson = vi.fn();
    render(<ChatPanel onOpenPerson={onOpenPerson} answer={{
      status: "insufficient", conclusion: "子女资料尚未确认完整。", answer: "子女资料尚未确认完整。",
      viewpoint: { id: "viewpoint", displayName: "王明" }, relationshipPath: [], evidence: [], candidates: [],
      missingFacts: [{ code: "children_completeness", message: "子女资料尚未由管理员确认完整", personId: "person" }],
      matchedPersonIds: ["person"], sourceIds: [], relationship: null, toolTrace: []
    }} />);
    fireEvent.click(screen.getByRole("button", { name: "前往补录" }));
    expect(onOpenPerson).toHaveBeenCalledWith("person");
  });

  it("allows only one confirmed request at a time so an older completion cannot clear a newer question", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const onSend = vi.fn().mockReturnValue(pending);
    render(<ChatPanel onSend={onSend} />);

    fireEvent.change(screen.getByLabelText("对话问题"), { target: { value: "第一个问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.click(screen.getByRole("button", { name: "同意并发送" }));

    expect(screen.getByLabelText("对话问题")).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "发送" }).closest("form")!);
    expect(onSend).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(screen.getByLabelText("对话问题")).toBeEnabled());
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

  it("renders warnings and conflicts and requires explicit warning acknowledgement", () => {
    const onConfirm = vi.fn();
    const base: ConversationDraftPreview = {
      id: "draft-warning", workspaceId: "workspace", version: 3, expiresAt: "2099-01-01T00:00:00.000Z",
      changes: [{ id: "change", kind: "create", entityType: "person", entityId: "person", summary: "创建人物", dependsOnChangeIds: [], fieldChanges: [] }],
      creates: 1, updates: 0, warnings: [{ code: "PARENT_AGE_OUTLIER", message: "年龄差异常" }], conflicts: [], unresolvedReferences: []
    };
    const { rerender } = render(<MutationDraftPreview preview={base} onConfirm={onConfirm} />);
    expect(screen.getByRole("alert")).toHaveTextContent("年龄差异常");
    expect(screen.getByRole("button", { name: "确认写入" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /已阅读并确认/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认写入" }));
    expect(onConfirm).toHaveBeenCalledWith(["change"], { draftVersion: 3, acknowledgedWarningCodes: ["PARENT_AGE_OUTLIER"] });

    rerender(<MutationDraftPreview preview={{ ...base, id: "conflict", conflicts: [{ code: "SELF_RELATION", message: "不能和自己结婚" }] }} onConfirm={onConfirm} />);
    expect(screen.getByText(/不能和自己结婚/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "确认写入" })).not.toBeInTheDocument();
  });

  it("acknowledges only selected contextual warnings and ignores unselected conflicts", () => {
    const onConfirm = vi.fn();
    const preview: ConversationDraftPreview = {
      id: "selected", workspaceId: "workspace", version: 1, expiresAt: "2099-01-01T00:00:00Z",
      changes: [
        { id: "c1", kind: "update", entityType: "person", entityId: "p1", summary: "更新甲", dependsOnChangeIds: [], fieldChanges: [] },
        { id: "c2", kind: "update", entityType: "person", entityId: "p2", summary: "更新乙", dependsOnChangeIds: [], fieldChanges: [] }
      ], creates: 0, updates: 2,
      warnings: [
        { changeId: "c1", occurrence: 1, code: "PARENT_AGE_OUTLIER", message: "年龄异常" },
        { changeId: "c2", occurrence: 1, code: "PARENT_AGE_OUTLIER", message: "年龄异常" }
      ],
      conflicts: [{ changeId: "c2", occurrence: 1, code: "CONFLICT", message: "乙冲突" }], unresolvedReferences: []
    };
    render(<MutationDraftPreview preview={preview} onConfirm={onConfirm} />);
    expect(screen.queryByRole("button", { name: "确认写入" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "更新乙" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /已阅读并确认/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认写入" }));
    expect(onConfirm).toHaveBeenCalledWith(["c1"], { draftVersion: 1, acknowledgedWarningCodes: ["PARENT_AGE_OUTLIER"] });
  });

  it("shows parent-completion origins and Chinese reasoning while allowing the automatic relation to be cancelled", () => {
    const onConfirm = vi.fn();
    const preview: ConversationDraftPreview = {
      id: "parent-completion", workspaceId: "workspace", version: 1, expiresAt: "2099-01-01T00:00:00Z",
      changes: [
        {
          id: "child", kind: "create", entityType: "person", entityId: "child-person", summary: "创建人物 孩子",
          originKind: "explicit", selectedByDefault: true, dependsOnChangeIds: [], fieldChanges: []
        },
        {
          id: "explicit", kind: "create", entityType: "parentChild", entityId: "edge-father", summary: "父亲 → 孩子：父亲",
          originKind: "explicit", selectedByDefault: true, dependsOnChangeIds: ["child"], fieldChanges: []
        },
        {
          id: "automatic", kind: "create", entityType: "parentChild", entityId: "edge-mother", summary: "母亲 → 孩子：母亲（依据：唯一已确认配偶）",
          originKind: "spouse_default", selectedByDefault: true, dependsOnChangeIds: ["child", "explicit"], fieldChanges: [],
          parentCompletion: {
            status: "suggested", basis: "unique_spouse", reason: "已确认婚姻中唯一的配偶候选", candidatePersonId: "mother", candidates: []
          }
        }
      ],
      creates: 3, updates: 0, warnings: [], conflicts: [], unresolvedReferences: []
    };

    render(<MutationDraftPreview preview={preview} onConfirm={onConfirm} />);

    expect(screen.getAllByText("人工录入")).toHaveLength(2);
    expect(screen.getByText("系统自动补全")).toBeVisible();
    expect(screen.getByText("已确认婚姻中唯一的配偶候选")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: /选择系统自动补全.*母亲 → 孩子/u }));
    fireEvent.click(screen.getByRole("button", { name: "确认写入" }));
    expect(onConfirm).toHaveBeenCalledWith(["child", "explicit"], { draftVersion: 1, acknowledgedWarningCodes: [] });
  });

  it("prunes excluded people and explicit relations from dependent completion choices", () => {
    const preview: ConversationDraftPreview = {
      id: "dependencies", workspaceId: "workspace", version: 1, expiresAt: "2099-01-01T00:00:00Z",
      changes: [
        { id: "child", kind: "create", entityType: "person", entityId: "child-person", summary: "创建人物 孩子", originKind: "explicit", selectedByDefault: true, dependsOnChangeIds: [], fieldChanges: [] },
        { id: "explicit", kind: "create", entityType: "parentChild", entityId: "edge-father", summary: "父亲 → 孩子：父亲", originKind: "explicit", selectedByDefault: true, dependsOnChangeIds: ["child"], fieldChanges: [] },
        { id: "automatic", kind: "create", entityType: "parentChild", entityId: "edge-mother", summary: "母亲 → 孩子：母亲", originKind: "spouse_default", selectedByDefault: true, dependsOnChangeIds: ["child", "explicit"], fieldChanges: [] }
      ],
      creates: 3, updates: 0, warnings: [], conflicts: [], unresolvedReferences: []
    };
    render(<MutationDraftPreview preview={preview} onConfirm={vi.fn()} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /选择人工录入.*创建人物 孩子/u }));

    expect(screen.getByRole("checkbox", { name: /父亲 → 孩子/u })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /母亲 → 孩子/u })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /母亲 → 孩子/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "确认写入" })).toBeDisabled();
  });

  it("renders no-candidate information and makes ambiguous spouse choices mutually exclusive", () => {
    const onConfirm = vi.fn();
    const preview: ConversationDraftPreview = {
      id: "ambiguous", workspaceId: "workspace", version: 1, expiresAt: "2099-01-01T00:00:00Z",
      changes: [
        { id: "explicit", kind: "create", entityType: "parentChild", entityId: "edge-father", summary: "父亲 → 孩子：父亲", originKind: "explicit", selectedByDefault: true, dependsOnChangeIds: [], fieldChanges: [], parentCompletion: {
          status: "ambiguous", basis: null, reason: "孩子存在多个配偶候选，婚姻和出生时间不足以唯一判断",
          candidates: [{
            personId: "former", personName: "前配偶", intervalRelation: "unknown", reason: "已确认婚姻配偶，但出生时间证据不足以唯一判断",
            evidenceIds: ["marriage:former-marriage"],
            marriageEpisodes: [{
              id: "former-marriage", status: "divorced", rowVersion: 1,
              start: { calendar: "solar", year: 1990, month: 1, day: null, leapMonth: false, precision: "month" },
              end: { calendar: "solar", year: 1999, month: 1, day: null, leapMonth: false, precision: "month" }
            }, {
              id: "current-marriage", status: "active", rowVersion: 1,
              start: { calendar: "lunar", year: 2000, month: 4, day: null, leapMonth: true, precision: "month" },
              end: null
            }]
          }]
        } },
        { id: "former", kind: "create", entityType: "parentChild", entityId: "edge-former", summary: "前配偶 → 孩子：母亲（管理员候选）", originKind: "spouse_default", selectedByDefault: false, selectionGroupId: "explicit", dependsOnChangeIds: ["explicit"], fieldChanges: [], parentCompletion: { status: "ambiguous", basis: "administrator_selected", reason: "已确认婚姻配偶，但出生时间证据不足以唯一判断", candidatePersonId: "former", candidates: [] } },
        { id: "current", kind: "create", entityType: "parentChild", entityId: "edge-current", summary: "现配偶 → 孩子：母亲（管理员候选）", originKind: "spouse_default", selectedByDefault: false, selectionGroupId: "explicit", dependsOnChangeIds: ["explicit"], fieldChanges: [], parentCompletion: { status: "ambiguous", basis: "administrator_selected", reason: "已确认婚姻配偶，但出生时间证据不足以唯一判断", candidatePersonId: "current", candidates: [] } }
      ],
      creates: 3, updates: 0, warnings: [], conflicts: [], unresolvedReferences: []
    };
    const { rerender } = render(<MutationDraftPreview preview={preview} onConfirm={onConfirm} />);

    expect(screen.getByText("孩子存在多个配偶候选，婚姻和出生时间不足以唯一判断")).toBeVisible();
    expect(screen.getByText("可选择一位已确认婚姻配偶，或跳过系统自动补全：")).toBeVisible();
    expect(screen.getByText(/婚姻记录：已离异，公历 1990年1月 至 公历 1999年1月；存续，农历 2000年闰4月 至今/u)).toBeVisible();
    const former = screen.getByRole("checkbox", { name: /前配偶/u });
    const current = screen.getByRole("checkbox", { name: /现配偶/u });
    expect(former).not.toBeChecked();
    expect(current).not.toBeChecked();
    fireEvent.click(former);
    fireEvent.click(current);
    expect(former).not.toBeChecked();
    expect(current).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "确认写入" }));
    expect(onConfirm).toHaveBeenCalledWith(["explicit", "current"], { draftVersion: 1, acknowledgedWarningCodes: [] });

    rerender(<MutationDraftPreview preview={{
      ...preview,
      id: "no-candidate",
      changes: [{
        ...preview.changes[0]!,
        parentCompletion: { status: "no_candidate", basis: null, reason: "孩子的另一位父母尚未确认", candidates: [] }
      }]
    }} onConfirm={onConfirm} />);
    expect(screen.getByText("孩子的另一位父母尚未确认")).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: /已阅读并确认/u })).not.toBeInTheDocument();
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
    expect(onConfirm).toHaveBeenCalledWith(["change-2"], { draftVersion: 2, acknowledgedWarningCodes: [] });
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

  it("sanitizes a rejected model-key save and restores the form", async () => {
    const settings = { status: vi.fn().mockResolvedValue({ ok: true, value: { configured: false } }), saveKey: vi.fn().mockRejectedValue(new Error("sk-secret-value")), clearKey: vi.fn() };
    render(<ModelSettings api={settings as never} />);
    await screen.findByText("尚未配置在线模型密钥");
    fireEvent.change(screen.getByLabelText("OpenAI API 密钥"), { target: { value: "sk-secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "安全保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法保存在线模型密钥");
    expect(screen.queryByText("sk-secret-value")).not.toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API 密钥")).toBeEnabled();
    expect(screen.getByRole("button", { name: "安全保存" })).toBeDisabled();
  });
});
