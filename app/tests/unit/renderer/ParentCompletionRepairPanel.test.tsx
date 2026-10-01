// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FamilyAgentApi,
  ParentCompletionPlanDto,
  ParentCompletionScanDto,
  ParentCompletionScanItemDto,
  PersonListItem
} from "../../../src/shared/contracts";
import type { MutationPreview } from "../../../src/shared/mutations";
import { PeoplePage } from "../../../src/renderer/src/features/people/PeoplePage";

afterEach(cleanup);

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const person = (id: string, displayName: string): PersonListItem => ({
  id,
  personCode: `P-${id}`,
  displayName,
  aliases: [],
  gender: "unknown",
  birth: null,
  death: null,
  notes: null,
  rowVersion: 1
});

function plan(
  childId: string,
  childName: string,
  knownParentId: string,
  knownParentName: string,
  status: ParentCompletionPlanDto["status"],
  candidateName?: string
): ParentCompletionPlanDto {
  const suggested = candidateName ? {
    parentId: `candidate-${childId}`,
    parentName: candidateName,
    childId,
    childName,
    parentRole: "mother" as const,
    inferredFromMarriageId: `marriage-${childId}`
  } : undefined;
  return {
    status,
    basis: status === "suggested" ? "unique_spouse" : null,
    explicit: {
      parentId: knownParentId,
      parentName: knownParentName,
      childId,
      childName,
      parentRole: "father"
    },
    ...(suggested ? { suggested } : {}),
    candidates: candidateName ? [{
      personId: `candidate-${childId}`,
      personName: candidateName,
      intervalRelation: status === "suggested" ? "inside" : "unknown",
      marriageEpisodes: [{
        id: `marriage-${childId}`,
        status: "active",
        start: null,
        end: null,
        rowVersion: 1
      }],
      reason: status === "suggested" ? "已确认婚姻中唯一的配偶候选" : "婚姻和出生时间不足以唯一判断",
      evidenceIds: [`marriage-${childId}`]
    }] : [],
    issues: status === "no_candidate" ? [{
      code: "PARENT_COMPLETION_NO_CANDIDATE",
      severity: "info",
      message: `${knownParentName}没有可用于补全${childName}另一位父母的已确认婚姻配偶`,
      evidenceIds: []
    }] : status === "ambiguous" ? [{
      code: "PARENT_COMPLETION_AMBIGUOUS",
      severity: "warning",
      message: `${childName}存在多个配偶候选，婚姻和出生时间不足以唯一判断`,
      evidenceIds: []
    }] : status === "conflict" ? [{
      code: "PARENT_ROLE_OCCUPIED",
      severity: "error",
      message: `${childName}的母亲已有另一人物，不能覆盖`,
      evidenceIds: []
    }] : [],
    evidence: []
  };
}

function item(
  childId: string,
  childName: string,
  classification: ParentCompletionScanItemDto["classification"],
  candidateName?: string
): ParentCompletionScanItemDto {
  const status = classification === "safe"
    ? "suggested"
    : classification === "no-candidate"
      ? "no_candidate"
      : classification;
  return {
    childId,
    childName,
    knownParentId: `known-${childId}`,
    knownParentName: `已知父亲-${childName}`,
    parentRole: "father",
    classification,
    plan: plan(childId, childName, `known-${childId}`, `已知父亲-${childName}`, status, candidateName)
  };
}

const mixedScan = (): ParentCompletionScanDto => ({
  counts: { total: 5, safe: 2, ambiguous: 1, noCandidate: 1, conflict: 1 },
  items: [
    item("safe-z", "赵安全", "safe", "赵候选母亲"),
    item("ambiguous", "钱歧义", "ambiguous", "钱候选甲"),
    item("safe-a", "孙安全", "safe", "孙候选母亲"),
    item("none", "李无候选", "no-candidate"),
    item("conflict", "周冲突", "conflict", "周建议母亲")
  ]
});

const mutationPreview = (): MutationPreview => ({
  id: "repair-draft",
  workspaceId: "workspace-1",
  version: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  expectedVersions: {},
  changes: [
    {
      id: "safe-z-explicit",
      disposition: "unchanged",
      entityType: "parentChild",
      entityId: "known-safe-z-edge",
      summary: "已知父亲-赵安全 → 赵安全：父亲",
      fieldChanges: [],
      originKind: "explicit",
      selectedByDefault: false,
      dependsOnChangeIds: []
    },
    {
      id: "safe-z-auto",
      disposition: "create",
      entityType: "parentChild",
      entityId: "safe-z-auto-edge",
      summary: "赵候选母亲 → 赵安全：母亲",
      fieldChanges: [],
      originKind: "spouse_default",
      selectedByDefault: true,
      dependsOnChangeIds: []
    },
    {
      id: "safe-a-explicit",
      disposition: "unchanged",
      entityType: "parentChild",
      entityId: "known-safe-a-edge",
      summary: "已知父亲-孙安全 → 孙安全：父亲",
      fieldChanges: [],
      originKind: "explicit",
      selectedByDefault: false,
      dependsOnChangeIds: []
    },
    {
      id: "safe-a-auto",
      disposition: "create",
      entityType: "parentChild",
      entityId: "safe-a-auto-edge",
      summary: "孙候选母亲 → 孙安全：母亲",
      fieldChanges: [],
      originKind: "spouse_default",
      selectedByDefault: true,
      dependsOnChangeIds: []
    }
  ],
  issues: [],
  canConfirm: true
});

function pageApi(scans: ParentCompletionScanDto[] = [mixedScan()]): FamilyAgentApi {
  const scan = vi.fn();
  for (const result of scans) scan.mockResolvedValueOnce({ ok: true, value: result });
  scan.mockResolvedValue({ ok: true, value: scans.at(-1)! });
  return {
    people: {
      list: vi.fn().mockResolvedValue({ ok: true, value: [person("current", "中心人物")] }),
      get: vi.fn(), save: vi.fn(), update: vi.fn(), setChildrenCompleteness: vi.fn(), getChildrenCountStatus: vi.fn()
    },
    relations: {
      addParentChild: vi.fn(), addMarriage: vi.fn(), divorce: vi.fn(), planRelativePath: vi.fn(),
      planParentCompletion: vi.fn(), scanParentCompletions: scan
    },
    mutations: {
      stage: vi.fn().mockResolvedValue({ ok: true, value: mutationPreview() }),
      confirm: vi.fn().mockResolvedValue({
        ok: true,
        value: { draftId: "repair-draft", operationGroupId: "repair-operation", changedEntityIds: ["safe-z-auto-edge", "safe-a-auto-edge"] }
      }),
      revise: vi.fn()
    },
    media: { select: vi.fn(), import: vi.fn(), attach: vi.fn(), listForPerson: vi.fn() },
    merges: {
      findDuplicateCandidates: vi.fn(), preview: vi.fn(), merge: vi.fn(),
      history: vi.fn().mockResolvedValue({ ok: true, value: [] }), canUnmerge: vi.fn(), unmerge: vi.fn()
    }
  } as unknown as FamilyAgentApi;
}

function renderPage(api: FamilyAgentApi): void {
  render(<PeoplePage workspace={{ id: "workspace-1", name: "测试谱册", path: "C:/hidden" }} api={api} />);
}

async function openRepairPanel(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "检查未完整父母关系" }));
  await screen.findByRole("heading", { name: "检查未完整父母关系" });
}

describe("ParentCompletionRepairPanel", () => {
  it("scans only when opened, preserves service row order, and shows counts, known parents, candidates, and reasons", async () => {
    const api = pageApi();
    renderPage(api);

    await screen.findByText("中心人物");
    expect(api.relations.scanParentCompletions).not.toHaveBeenCalled();
    expect(api.mutations.stage).not.toHaveBeenCalled();

    await openRepairPanel();

    await waitFor(() => expect(api.relations.scanParentCompletions).toHaveBeenCalledTimes(1));
    expect(screen.getByText("总计 5")).toBeVisible();
    expect(screen.getByText("可安全补全 2")).toBeVisible();
    expect(screen.getByText("歧义 1")).toBeVisible();
    expect(screen.getByText("无候选 1")).toBeVisible();
    expect(screen.getByText("冲突 1")).toBeVisible();
    const rows = within(screen.getByRole("list", { name: "未完整父母关系列表" })).getAllByRole("heading", { level: 3 });
    expect(rows.map((row) => row.textContent)).toEqual([
      "赵安全", "钱歧义", "孙安全", "李无候选", "周冲突"
    ]);
    expect(screen.getByText("当前已知父亲：已知父亲-赵安全")).toBeVisible();
    expect(screen.getByText("候选母亲：赵候选母亲")).toBeVisible();
    expect(screen.getAllByText("已确认婚姻中唯一的配偶候选")).toHaveLength(2);
    expect(screen.getByText("钱歧义存在多个配偶候选，婚姻和出生时间不足以唯一判断")).toBeVisible();
    expect(api.mutations.stage).not.toHaveBeenCalled();
    expect(api.mutations.confirm).not.toHaveBeenCalled();
  });

  it("selects only safe rows by default, stages one draft, and re-scans to the updated empty state after confirmation", async () => {
    const empty: ParentCompletionScanDto = {
      counts: { total: 0, safe: 0, ambiguous: 0, noCandidate: 0, conflict: 0 },
      items: []
    };
    const api = pageApi([mixedScan(), empty]);
    renderPage(api);
    await openRepairPanel();

    const safeZ = await screen.findByRole("checkbox", { name: "选择修复 赵安全" });
    const safeA = screen.getByRole("checkbox", { name: "选择修复 孙安全" });
    const ambiguous = screen.getByRole("checkbox", { name: "选择修复 钱歧义" });
    const none = screen.getByRole("checkbox", { name: "选择修复 李无候选" });
    const conflict = screen.getByRole("checkbox", { name: "选择修复 周冲突" });
    expect(safeZ).toBeChecked();
    expect(safeA).toBeChecked();
    for (const checkbox of [ambiguous, none, conflict]) {
      expect(checkbox).not.toBeChecked();
      expect(checkbox).toBeDisabled();
    }

    fireEvent.click(safeZ);
    expect(safeZ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "全选安全项" }));
    expect(safeZ).toBeChecked();
    expect(safeA).toBeChecked();
    for (const checkbox of [ambiguous, none, conflict]) expect(checkbox).not.toBeChecked();
    expect(api.mutations.stage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "生成修复预览" }));

    await waitFor(() => expect(api.mutations.stage).toHaveBeenCalledTimes(1));
    expect(api.mutations.stage).toHaveBeenCalledWith({
      intents: [
        {
          type: "parentFamily.add",
          knownParentId: "known-safe-z",
          childId: "safe-z",
          parentRole: "father",
          completionPolicy: "spouse-default",
          sourceDescription: "历史未完整父母关系批量修复"
        },
        {
          type: "parentFamily.add",
          knownParentId: "known-safe-a",
          childId: "safe-a",
          parentRole: "father",
          completionPolicy: "spouse-default",
          sourceDescription: "历史未完整父母关系批量修复"
        }
      ]
    });
    expect(await screen.findByRole("dialog", { name: "确认写入" })).toBeVisible();
    expect(screen.getAllByText("人工录入")).toHaveLength(2);
    expect(screen.getAllByText("系统自动补全")).toHaveLength(2);
    expect(api.mutations.confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认写入" }));
    await waitFor(() => expect(api.mutations.confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.relations.scanParentCompletions).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("没有需要检查的未完整父母关系。")).toBeVisible();
    expect(screen.queryByText("赵安全")).not.toBeInTheDocument();
  });

  it("makes stale scan results inert during a pending refresh and discards the old preview before accepting the new generation", async () => {
    const pending = deferred<Awaited<ReturnType<FamilyAgentApi["relations"]["scanParentCompletions"]>>>();
    const api = pageApi();
    vi.mocked(api.relations.scanParentCompletions)
      .mockReset()
      .mockResolvedValueOnce({ ok: true, value: mixedScan() })
      .mockReturnValueOnce(pending.promise);
    renderPage(api);
    await openRepairPanel();
    await screen.findByText("总计 5");

    fireEvent.click(screen.getByRole("button", { name: "生成修复预览" }));
    expect(await screen.findByRole("dialog", { name: "确认写入" })).toBeVisible();
    expect(api.mutations.stage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "刷新未完整父母关系" }));

    expect(screen.queryByRole("dialog", { name: "确认写入" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择修复 赵安全" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "选择修复 孙安全" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "全选安全项" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "生成修复预览" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "全选安全项" }));
    fireEvent.click(screen.getByRole("button", { name: "生成修复预览" }));
    expect(api.mutations.stage).toHaveBeenCalledTimes(1);

    pending.resolve({
      ok: true,
      value: { counts: { total: 0, safe: 0, ambiguous: 0, noCandidate: 0, conflict: 0 }, items: [] }
    });
    expect(await screen.findByText("没有需要检查的未完整父母关系。")).toBeVisible();
    expect(screen.queryByText("赵安全")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "确认写入" })).not.toBeInTheDocument();
  });

  it("maps a known mother repair to a mother parent-family intent without fixing or reversing the role", async () => {
    const motherItem = item("mother-safe", "母系孩子", "safe", "候选父亲");
    motherItem.knownParentName = "已知母亲-母系孩子";
    motherItem.parentRole = "mother";
    motherItem.plan.explicit.parentName = motherItem.knownParentName;
    motherItem.plan.explicit.parentRole = "mother";
    motherItem.plan.suggested!.parentRole = "father";
    const api = pageApi([{
      counts: { total: 1, safe: 1, ambiguous: 0, noCandidate: 0, conflict: 0 },
      items: [motherItem]
    }]);
    renderPage(api);
    await openRepairPanel();

    expect(await screen.findByText("当前已知母亲：已知母亲-母系孩子")).toBeVisible();
    expect(screen.getByText("候选父亲：候选父亲")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "生成修复预览" }));

    await waitFor(() => expect(api.mutations.stage).toHaveBeenCalledWith({ intents: [expect.objectContaining({
      knownParentId: "known-mother-safe",
      childId: "mother-safe",
      parentRole: "mother"
    })] }));
  });

  it("exposes the repair surface as a named region and leaves MutationReviewDialog as the only modal", async () => {
    const api = pageApi();
    renderPage(api);
    await openRepairPanel();

    expect(screen.getByRole("region", { name: "检查未完整父母关系" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "修复未完整父母关系" })).not.toBeInTheDocument();
    const close = screen.getByRole("button", { name: "关闭修复面板" });
    expect(close.tabIndex).toBe(0);
    close.focus();
    expect(close).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "生成修复预览" }));
    const dialogs = await screen.findAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveAccessibleName("确认写入");
    expect(dialogs[0]).toHaveAttribute("aria-modal", "true");
  });

  it("shows an explicit empty state and scans again only on manual refresh", async () => {
    const empty: ParentCompletionScanDto = {
      counts: { total: 0, safe: 0, ambiguous: 0, noCandidate: 0, conflict: 0 },
      items: []
    };
    const api = pageApi([empty, mixedScan()]);
    renderPage(api);
    await openRepairPanel();

    expect(await screen.findByText("没有需要检查的未完整父母关系。")).toBeVisible();
    expect(api.relations.scanParentCompletions).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.relations.scanParentCompletions).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "刷新未完整父母关系" }));
    await waitFor(() => expect(api.relations.scanParentCompletions).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("总计 5")).toBeVisible();
  });
});
