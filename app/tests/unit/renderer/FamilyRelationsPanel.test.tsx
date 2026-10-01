// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FamilyAgentApi,
  ParentCompletionCandidateDto,
  ParentCompletionPlanDto,
  PersonDetailReadModel,
  PersonListItem,
  RelatedPersonReadModel
} from "../../../src/shared/contracts";
import type { MutationApi, MutationIntent, MutationPreview } from "../../../src/shared/mutations";
import { FamilyRelationsPanel } from "../../../src/renderer/src/features/relations/FamilyRelationsPanel";
import { PeoplePage } from "../../../src/renderer/src/features/people/PeoplePage";

afterEach(cleanup);

const person = (
  id: string,
  displayName: string,
  gender: PersonListItem["gender"] = "unknown"
): PersonListItem => ({
  id,
  personCode: `P-${id}`,
  displayName,
  aliases: [],
  gender,
  birth: null,
  death: null,
  notes: null,
  rowVersion: 1
});

const current = person("current", "中心人物", "male");
const secondCurrent = person("current-b", "第二人物", "female");
const father = person("father", "现有父亲", "male");
const mother = person("mother", "候选母亲", "female");
const daughter = person("daughter", "女儿一", "female");
const son = person("son", "儿子二", "male");
const spouseOne = person("spouse-1", "配偶甲", "female");
const spouseTwo = person("spouse-2", "配偶乙", "female");
const replacement = person("replacement", "更正父亲", "male");
const allPeople = [current, secondCurrent, father, mother, daughter, son, spouseOne, spouseTwo, replacement];

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const related = (
  relationId: string,
  entry: PersonListItem,
  role: RelatedPersonReadModel["role"],
  originKind: RelatedPersonReadModel["originKind"] = "explicit",
  inferredFromMarriageId: string | null = null
): RelatedPersonReadModel => ({
  relationId,
  person: entry,
  role,
  rowVersion: 3,
  originKind,
  inferredFromMarriageId
});

const detail = (patch: Partial<PersonDetailReadModel> = {}): PersonDetailReadModel => ({
  person: current,
  aliases: [],
  parents: [],
  children: [],
  marriages: [],
  ...patch
});

const preview = (): MutationPreview => ({
  id: "draft-1",
  workspaceId: "workspace-1",
  version: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  expectedVersions: {},
  changes: [{
    id: "change-1",
    disposition: "create",
    entityType: "parentChild",
    entityId: "edge-1",
    summary: "待确认关系",
    fieldChanges: [],
    originKind: "explicit",
    selectedByDefault: true,
    dependsOnChangeIds: []
  }],
  issues: [],
  canConfirm: true
});

const noCandidatePlan = (input: { knownParentId: string; childId: string; parentRole: "father" | "mother" }): ParentCompletionPlanDto => ({
  status: "no_candidate",
  basis: null,
  explicit: {
    parentId: input.knownParentId,
    parentName: allPeople.find((entry) => entry.id === input.knownParentId)?.displayName ?? "明确父母",
    childId: input.childId,
    childName: allPeople.find((entry) => entry.id === input.childId)?.displayName ?? "孩子",
    parentRole: input.parentRole
  },
  candidates: [],
  issues: [{
    code: "PARENT_COMPLETION_NO_CANDIDATE",
    severity: "info",
    message: "另一位父母尚未确认",
    evidenceIds: []
  }],
  evidence: []
});

const ambiguousCandidates: ParentCompletionCandidateDto[] = [
  {
    personId: "candidate-a",
    personName: "候选配偶甲",
    intervalRelation: "unknown",
    marriageEpisodes: [{
      id: "marriage-a",
      status: "divorced",
      start: { calendar: "solar", year: 2010, month: 1, day: null, leapMonth: false, precision: "month" },
      end: { calendar: "solar", year: 2015, month: 12, day: null, leapMonth: false, precision: "month" },
      rowVersion: 1
    }],
    reason: "孩子出生日期不足以排除该婚姻",
    evidenceIds: ["marriage-a"]
  },
  {
    personId: "candidate-b",
    personName: "候选配偶乙",
    intervalRelation: "unknown",
    marriageEpisodes: [{ id: "marriage-b", status: "active", start: null, end: null, rowVersion: 1 }],
    reason: "婚姻日期缺失",
    evidenceIds: ["marriage-b"]
  }
];

const ambiguousPlan = (input: { knownParentId: string; childId: string; parentRole: "father" | "mother" }): ParentCompletionPlanDto => ({
  ...noCandidatePlan(input),
  status: "ambiguous",
  candidates: ambiguousCandidates,
  issues: [{
    code: "PARENT_COMPLETION_AMBIGUOUS",
    severity: "warning",
    message: "存在多个可能的另一位父母",
    evidenceIds: ["marriage-a", "marriage-b"]
  }]
});

const uniquePlan = (input: { knownParentId: string; childId: string; parentRole: "father" | "mother" }): ParentCompletionPlanDto => ({
  ...noCandidatePlan(input),
  status: "suggested",
  basis: "unique_spouse",
  suggested: {
    parentId: spouseOne.id,
    parentName: spouseOne.displayName,
    childId: input.childId,
    childName: allPeople.find((entry) => entry.id === input.childId)?.displayName ?? "孩子",
    parentRole: input.parentRole === "father" ? "mother" : "father",
    inferredFromMarriageId: "marriage-unique"
  },
  candidates: [{
    personId: spouseOne.id,
    personName: spouseOne.displayName,
    intervalRelation: "inside",
    marriageEpisodes: [{ id: "marriage-unique", status: "active", start: null, end: null, rowVersion: 1 }],
    reason: "唯一已确认配偶",
    evidenceIds: ["marriage-unique"]
  }],
  issues: []
});

function createHarness(plan: (input: { knownParentId: string; childId: string; parentRole: "father" | "mother" }) => ParentCompletionPlanDto = noCandidatePlan) {
  const peopleApi: FamilyAgentApi["people"] = {
    list: vi.fn().mockResolvedValue({ ok: true, value: allPeople }),
    get: vi.fn(),
    save: vi.fn(),
    update: vi.fn(),
    setChildrenCompleteness: vi.fn(),
    getChildrenCountStatus: vi.fn()
  };
  const relationsApi: FamilyAgentApi["relations"] = {
    addParentChild: vi.fn(),
    addMarriage: vi.fn(),
    divorce: vi.fn(),
    planRelativePath: vi.fn(),
    planParentCompletion: vi.fn().mockImplementation(async (input) => ({ ok: true, value: plan(input) })),
    scanParentCompletions: vi.fn()
  };
  const mutations: MutationApi = {
    stage: vi.fn().mockResolvedValue({ ok: true, value: preview() }),
    confirm: vi.fn(),
    revise: vi.fn()
  };
  return { peopleApi, relationsApi, mutations };
}

function renderPanel(
  personDetail: PersonDetailReadModel = detail(),
  plan?: (input: { knownParentId: string; childId: string; parentRole: "father" | "mother" }) => ParentCompletionPlanDto,
  onRequestQuickCreate = vi.fn()
) {
  const harness = createHarness(plan);
  render(
    <FamilyRelationsPanel
      detail={personDetail}
      peopleApi={harness.peopleApi}
      relationsApi={harness.relationsApi}
      mutations={harness.mutations}
      onChanged={vi.fn()}
      onRequestQuickCreate={onRequestQuickCreate}
    />
  );
  return { ...harness, onRequestQuickCreate };
}

function createPageApi() {
  const createdChild = person("new-child", "新建子女", "female");
  const currentDetail = detail();
  const createdDetail: PersonDetailReadModel = { person: createdChild, aliases: [], parents: [], children: [], marriages: [] };
  const mutationPreview: MutationPreview = {
    ...preview(),
    changes: [{
      id: "create-person-change",
      disposition: "create",
      entityType: "person",
      entityId: createdChild.id,
      summary: "创建人物 新建子女",
      fieldChanges: [],
      originKind: "explicit",
      selectedByDefault: true,
      dependsOnChangeIds: []
    }]
  };
  const api = {
    people: {
      list: vi.fn().mockResolvedValue({ ok: true, value: [current, daughter] }),
      get: vi.fn().mockImplementation(async ({ personId }: { personId: string }) => ({ ok: true, value: personId === createdChild.id ? createdDetail : currentDetail })),
      save: vi.fn(),
      update: vi.fn(),
      setChildrenCompleteness: vi.fn(),
      getChildrenCountStatus: vi.fn().mockResolvedValue({ ok: true, value: { count: 0, completeness: "partial" } })
    },
    relations: {
      addParentChild: vi.fn(), addMarriage: vi.fn(), divorce: vi.fn(), planRelativePath: vi.fn(),
      planParentCompletion: vi.fn(), scanParentCompletions: vi.fn()
    },
    mutations: {
      stage: vi.fn().mockResolvedValue({ ok: true, value: mutationPreview }),
      confirm: vi.fn().mockResolvedValue({ ok: true, value: { draftId: mutationPreview.id, operationGroupId: "group-1", changedEntityIds: [createdChild.id] } }),
      revise: vi.fn()
    },
    media: { select: vi.fn(), import: vi.fn(), attach: vi.fn(), listForPerson: vi.fn().mockResolvedValue({ ok: true, value: [] }) },
    merges: {
      findDuplicateCandidates: vi.fn(), preview: vi.fn(), merge: vi.fn(),
      history: vi.fn().mockResolvedValue({ ok: true, value: [] }), canUnmerge: vi.fn(), unmerge: vi.fn()
    }
  } as unknown as FamilyAgentApi;
  return { api, createdChild };
}

describe("FamilyRelationsPanel", () => {
  it("fixes the current person, excludes them from candidates, and does not offer a second occupied parent slot", async () => {
    renderPanel(detail({ parents: [related("edge-father", father, "father")] }));

    const motherSelect = await screen.findByLabelText("选择母亲");
    expect(within(motherSelect).queryByRole("option", { name: /中心人物/u })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("选择父亲")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更正父亲 现有父亲" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "移除父亲 现有父亲" })).toBeEnabled();
    expect(screen.getByText("人工录入")).toBeVisible();
  });

  it("stages two selected children as two parent-family intents in one request after an explicit role choice", async () => {
    const { mutations, relationsApi } = renderPanel();
    expect(screen.getByRole("button", { name: "生成子女关系预览" })).toBeDisabled();

    fireEvent.click(await screen.findByRole("checkbox", { name: "选择子女 女儿一" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择子女 儿子二" }));
    fireEvent.click(screen.getByRole("radio", { name: "当前人物作为父亲" }));
    fireEvent.click(screen.getByRole("button", { name: "生成子女关系预览" }));

    await waitFor(() => expect(mutations.stage).toHaveBeenCalledTimes(1));
    expect(relationsApi.planParentCompletion).toHaveBeenCalledTimes(2);
    const intents = vi.mocked(mutations.stage).mock.calls[0]?.[0].intents;
    expect(intents).toEqual([
      {
        type: "parentFamily.add",
        knownParentId: "current",
        childId: "daughter",
        parentRole: "father",
        completionPolicy: "spouse-default",
        sourceDescription: "人物中心关系录入"
      },
      {
        type: "parentFamily.add",
        knownParentId: "current",
        childId: "son",
        parentRole: "father",
        completionPolicy: "spouse-default",
        sourceDescription: "人物中心关系录入"
      }
    ] satisfies MutationIntent[]);
    expect(screen.getAllByText(/另一位父母尚未确认/u)).toHaveLength(2);
  });

  it("stages a unique completion plan without asking the administrator to resolve it", async () => {
    const { mutations } = renderPanel(detail(), uniquePlan);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择子女 女儿一" }));
    fireEvent.click(screen.getByRole("radio", { name: "当前人物作为父亲" }));
    fireEvent.click(screen.getByRole("button", { name: "生成子女关系预览" }));

    await waitFor(() => expect(mutations.stage).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("heading", { name: "请选择另一位父母，或暂时跳过" })).not.toBeInTheDocument();
    expect(vi.mocked(mutations.stage).mock.calls[0]?.[0].intents).toEqual([{
      type: "parentFamily.add",
      knownParentId: current.id,
      childId: daughter.id,
      parentRole: "father",
      completionPolicy: "spouse-default",
      sourceDescription: "人物中心关系录入"
    }]);
  });

  it("clears the previous person's preview, correction and selections when the owner changes", async () => {
    const harness = createHarness();
    const onRequestQuickCreate = vi.fn();
    const view = render(<FamilyRelationsPanel
      detail={detail({ parents: [related("edge-father", father, "father")] })}
      peopleApi={harness.peopleApi}
      relationsApi={harness.relationsApi}
      mutations={harness.mutations}
      onChanged={vi.fn()}
      onRequestQuickCreate={onRequestQuickCreate}
    />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择子女 女儿一" }));
    fireEvent.click(screen.getByRole("radio", { name: "当前人物作为父亲" }));
    fireEvent.click(screen.getByRole("button", { name: "更正父亲 现有父亲" }));
    fireEvent.click(screen.getByRole("button", { name: "生成子女关系预览" }));
    expect(await screen.findByRole("dialog", { name: "确认写入" })).toBeVisible();

    view.rerender(<FamilyRelationsPanel
      detail={detail({ person: secondCurrent })}
      peopleApi={harness.peopleApi}
      relationsApi={harness.relationsApi}
      mutations={harness.mutations}
      onChanged={vi.fn()}
      onRequestQuickCreate={onRequestQuickCreate}
    />);

    expect(await screen.findByText("当前人物固定为：第二人物")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "确认写入" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "更正父亲关系" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择子女 女儿一" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "当前人物作为父亲" })).not.toBeChecked();
  });

  it("does not stage an old person's plan when its deferred result arrives after an owner change", async () => {
    const harness = createHarness();
    const pendingPlan = deferred<Awaited<ReturnType<FamilyAgentApi["relations"]["planParentCompletion"]>>>();
    vi.mocked(harness.relationsApi.planParentCompletion).mockReturnValue(pendingPlan.promise);
    const view = render(<FamilyRelationsPanel
      detail={detail()}
      peopleApi={harness.peopleApi}
      relationsApi={harness.relationsApi}
      mutations={harness.mutations}
      onChanged={vi.fn()}
    />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择子女 女儿一" }));
    fireEvent.click(screen.getByRole("radio", { name: "当前人物作为父亲" }));
    fireEvent.click(screen.getByRole("button", { name: "生成子女关系预览" }));
    await waitFor(() => expect(harness.relationsApi.planParentCompletion).toHaveBeenCalledTimes(1));

    view.rerender(<FamilyRelationsPanel
      detail={detail({ person: secondCurrent })}
      peopleApi={harness.peopleApi}
      relationsApi={harness.relationsApi}
      mutations={harness.mutations}
      onChanged={vi.fn()}
    />);
    await act(async () => {
      pendingPlan.resolve({ ok: true, value: noCandidatePlan({ knownParentId: current.id, childId: daughter.id, parentRole: "father" }) });
      await pendingPlan.promise;
      await Promise.resolve();
    });

    expect(harness.mutations.stage).not.toHaveBeenCalled();
    expect(screen.queryByText(/女儿一：另一位父母尚未确认/u)).not.toBeInTheDocument();
  });

  it("does not show an old person's deferred mutation preview after an owner change", async () => {
    const harness = createHarness();
    const pendingStage = deferred<Awaited<ReturnType<MutationApi["stage"]>>>();
    vi.mocked(harness.mutations.stage).mockReturnValue(pendingStage.promise);
    const view = render(<FamilyRelationsPanel
      detail={detail({ parents: [related("edge-father", father, "father")] })}
      peopleApi={harness.peopleApi}
      relationsApi={harness.relationsApi}
      mutations={harness.mutations}
      onChanged={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "移除父亲 现有父亲" }));
    await waitFor(() => expect(harness.mutations.stage).toHaveBeenCalledTimes(1));

    view.rerender(<FamilyRelationsPanel
      detail={detail({ person: secondCurrent })}
      peopleApi={harness.peopleApi}
      relationsApi={harness.relationsApi}
      mutations={harness.mutations}
      onChanged={vi.fn()}
    />);
    await act(async () => {
      pendingStage.resolve({ ok: true, value: preview() });
      await pendingStage.promise;
      await Promise.resolve();
    });

    expect(screen.queryByRole("dialog", { name: "确认写入" })).not.toBeInTheDocument();
    expect(screen.getByText("当前人物固定为：第二人物")).toBeVisible();
  });

  it("ignores a deferred quick-create callback owned by the previous person", async () => {
    const harness = createHarness();
    const onRequestQuickCreate = vi.fn();
    const lateCreated = deferred<PersonListItem>();
    const view = render(<FamilyRelationsPanel
      detail={detail()}
      peopleApi={harness.peopleApi}
      relationsApi={harness.relationsApi}
      mutations={harness.mutations}
      onChanged={vi.fn()}
      onRequestQuickCreate={onRequestQuickCreate}
    />);
    fireEvent.click(await screen.findByRole("button", { name: "快速新建子女" }));
    const request = onRequestQuickCreate.mock.calls[0]?.[0] as { purpose: string; onCreated(person: PersonListItem): void };
    void lateCreated.promise.then(request.onCreated);

    view.rerender(<FamilyRelationsPanel
      detail={detail({ person: secondCurrent })}
      peopleApi={harness.peopleApi}
      relationsApi={harness.relationsApi}
      mutations={harness.mutations}
      onChanged={vi.fn()}
      onRequestQuickCreate={onRequestQuickCreate}
    />);
    await act(async () => {
      lateCreated.resolve(person("late-child", "迟到子女"));
      await lateCreated.promise;
      await Promise.resolve();
    });

    expect(screen.queryByRole("checkbox", { name: "选择子女 迟到子女" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择子女 女儿一" })).not.toBeChecked();
  });

  it("shows ambiguous candidate names and marriage ranges and stages the administrator selection", async () => {
    const { mutations } = renderPanel(detail(), ambiguousPlan);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择子女 女儿一" }));
    fireEvent.click(screen.getByRole("radio", { name: "当前人物作为母亲" }));
    fireEvent.click(screen.getByRole("button", { name: "生成子女关系预览" }));

    expect(await screen.findByText("候选配偶甲")).toBeVisible();
    expect(screen.getByText(/2010年1月.*2015年12月/u)).toBeVisible();
    expect(screen.getByRole("radio", { name: "暂时跳过女儿一的另一位父母" })).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: "为女儿一选择候选配偶甲" }));
    fireEvent.click(screen.getByRole("button", { name: "生成关系预览" }));

    await waitFor(() => expect(mutations.stage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(mutations.stage).mock.calls[0]?.[0].intents).toEqual([
      expect.objectContaining({ type: "parentFamily.add", childId: "daughter", parentRole: "mother", selectedSpouseId: "candidate-a" })
    ]);
  });

  it("lets an administrator skip ambiguous completion while retaining the explicit relation", async () => {
    const { mutations } = renderPanel(detail(), ambiguousPlan);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择子女 女儿一" }));
    fireEvent.click(screen.getByRole("radio", { name: "当前人物作为父亲" }));
    fireEvent.click(screen.getByRole("button", { name: "生成子女关系预览" }));
    fireEvent.click(await screen.findByRole("radio", { name: "暂时跳过女儿一的另一位父母" }));
    fireEvent.click(screen.getByRole("button", { name: "生成关系预览" }));

    await waitFor(() => expect(mutations.stage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(mutations.stage).mock.calls[0]?.[0].intents).toEqual([
      expect.objectContaining({ type: "parentFamily.add", childId: "daughter", skipCompletion: true })
    ]);
  });

  it("stages removal without calling a direct relationship mutation", async () => {
    const personDetail = detail({
      parents: [related("edge-father", father, "father", "spouse_default", "marriage-source")]
    });
    const { mutations, relationsApi } = renderPanel(personDetail);

    fireEvent.click(screen.getByRole("button", { name: "移除父亲 现有父亲" }));

    await waitFor(() => expect(mutations.stage).toHaveBeenCalledWith({
      intents: [{ type: "parentChild.remove", relationId: "edge-father", expectedVersion: 3 }]
    }));
    expect(relationsApi.addParentChild).not.toHaveBeenCalled();
    expect(screen.getByText("系统自动补全")).toBeVisible();
    expect(screen.getByText(/来源婚姻.*marriage-source/u)).toBeVisible();
  });

  it("stages a correction as one remove-plus-replacement draft only after replacement is known", async () => {
    const personDetail = detail({ parents: [related("edge-father", father, "father")] });
    const { mutations } = renderPanel(personDetail);

    fireEvent.click(screen.getByRole("button", { name: "更正父亲 现有父亲" }));
    expect(mutations.stage).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByLabelText("父亲更正为"), { target: { value: "replacement" } });
    fireEvent.click(screen.getByRole("button", { name: "预览父亲更正" }));

    await waitFor(() => expect(mutations.stage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(mutations.stage).mock.calls[0]?.[0].intents).toEqual([
      { type: "parentChild.remove", relationId: "edge-father", expectedVersion: 3 },
      {
        type: "parentFamily.add",
        knownParentId: "replacement",
        childId: "current",
        parentRole: "father",
        completionPolicy: "spouse-default",
        skipCompletion: true,
        sourceDescription: "人物中心关系更正"
      }
    ]);
  });

  it("stages one marriage intent per complete spouse event with status and end", async () => {
    const { mutations } = renderPanel();
    fireEvent.change(await screen.findByLabelText("第1段婚姻配偶"), { target: { value: "spouse-1" } });
    fireEvent.change(screen.getByLabelText("第1段婚姻状态"), { target: { value: "divorced" } });
    fireEvent.change(screen.getByLabelText("第1段婚姻结束日期历法"), { target: { value: "solar" } });
    fireEvent.change(screen.getByLabelText("第1段婚姻结束年份"), { target: { value: "2018" } });
    fireEvent.change(screen.getByLabelText("第1段婚姻结束月份"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "新增婚姻事件" }));
    fireEvent.change(screen.getByLabelText("第2段婚姻配偶"), { target: { value: "spouse-2" } });
    fireEvent.change(screen.getByLabelText("第2段婚姻状态"), { target: { value: "active" } });
    fireEvent.click(screen.getByRole("button", { name: "生成婚姻关系预览" }));

    await waitFor(() => expect(mutations.stage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(mutations.stage).mock.calls[0]?.[0].intents).toEqual([
      {
        type: "marriage.add",
        draft: {
          spouseAId: "current",
          spouseBId: "spouse-1",
          status: "divorced",
          start: null,
          end: { calendar: "solar", year: 2018, month: 6, day: null, leapMonth: false, precision: "month" },
          sourceDescription: "人物中心关系录入"
        }
      },
      {
        type: "marriage.add",
        draft: {
          spouseAId: "current",
          spouseBId: "spouse-2",
          status: "active",
          start: null,
          end: null,
          sourceDescription: "人物中心关系录入"
        }
      }
    ]);
  });

  it("requires an end for divorced events and rejects two new active events before staging", async () => {
    const { mutations } = renderPanel();
    fireEvent.change(await screen.findByLabelText("第1段婚姻配偶"), { target: { value: "spouse-1" } });
    fireEvent.change(screen.getByLabelText("第1段婚姻状态"), { target: { value: "divorced" } });
    fireEvent.click(screen.getByRole("button", { name: "生成婚姻关系预览" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("已离婚的婚姻事件必须填写结束日期");
    expect(mutations.stage).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("第1段婚姻状态"), { target: { value: "active" } });
    fireEvent.click(screen.getByRole("button", { name: "新增婚姻事件" }));
    fireEvent.change(screen.getByLabelText("第2段婚姻配偶"), { target: { value: "spouse-2" } });
    fireEvent.change(screen.getByLabelText("第2段婚姻状态"), { target: { value: "active" } });
    fireEvent.click(screen.getByRole("button", { name: "生成婚姻关系预览" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("同一人物的新婚姻事件最多只能有一段当前婚姻");
    expect(mutations.stage).not.toHaveBeenCalled();
  });

  it("returns a quick-created person to the pending child selection", async () => {
    const onRequestQuickCreate = vi.fn();
    renderPanel(detail(), undefined, onRequestQuickCreate);
    fireEvent.click(screen.getByRole("button", { name: "快速新建子女" }));

    expect(onRequestQuickCreate).toHaveBeenCalledTimes(1);
    const request = onRequestQuickCreate.mock.calls[0]?.[0] as { purpose: string; onCreated(person: PersonListItem): void };
    expect(request.purpose).toBe("子女");
    act(() => request.onCreated(person("new-child", "新建子女")));

    expect(await screen.findByRole("checkbox", { name: "选择子女 新建子女" })).toBeChecked();
  });

  it("uses PeoplePage's existing staged PersonEditor for quick-create and returns the created ID", async () => {
    const { api } = createPageApi();
    render(<PeoplePage
      workspace={{ id: "workspace-1", name: "测试谱", directory: "opaque", originPersonId: current.id, lastOpenedAt: null, schemaVersion: 7 }}
      api={api}
      initialSelectedPersonId={current.id}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "快速新建子女" }));
    expect(screen.getByRole("heading", { name: "快速新建关系人物：子女" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "新建子女" } });
    fireEvent.click(screen.getByRole("button", { name: "保存人物" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认写入" }));

    expect(await screen.findByRole("checkbox", { name: "选择子女 新建子女" })).toBeChecked();
    expect(api.mutations.stage).toHaveBeenCalledWith({ intents: [expect.objectContaining({ type: "person.create" })] });
    expect(api.people.save).not.toHaveBeenCalled();
  });

  it("does not return a quick-created ID after loadPeople completes for a different selected person", async () => {
    const { api, createdChild } = createPageApi();
    const refresh = deferred<Awaited<ReturnType<FamilyAgentApi["people"]["list"]>>>();
    const onDataChanged = vi.fn();
    let pageListCalls = 0;
    vi.mocked(api.people.list).mockImplementation(async (input) => {
      const pageList = !Object.prototype.hasOwnProperty.call(input, "query");
      if (!pageList) return { ok: true, value: [current, secondCurrent, daughter] };
      pageListCalls += 1;
      if (pageListCalls === 1) return { ok: true, value: [current, secondCurrent, daughter] };
      return refresh.promise;
    });
    vi.mocked(api.people.get).mockImplementation(async ({ personId }) => ({
      ok: true,
      value: personId === createdChild.id
        ? detail({ person: createdChild })
        : personId === secondCurrent.id
          ? detail({ person: secondCurrent })
          : detail()
    }));
    render(<PeoplePage
      workspace={{ id: "workspace-1", name: "测试谱", directory: "opaque", originPersonId: current.id, lastOpenedAt: null, schemaVersion: 7 }}
      api={api}
      initialSelectedPersonId={current.id}
      onDataChanged={onDataChanged}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "快速新建子女" }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: createdChild.displayName } });
    fireEvent.click(screen.getByRole("button", { name: "保存人物" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认写入" }));
    await waitFor(() => expect(pageListCalls).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "查看第二人物" }));
    expect(await screen.findByText("当前人物固定为：第二人物")).toBeVisible();
    await act(async () => {
      refresh.resolve({ ok: true, value: [current, secondCurrent, daughter, createdChild] });
      await refresh.promise;
      await Promise.resolve();
    });

    expect(screen.queryByRole("checkbox", { name: "选择子女 新建子女" })).not.toBeInTheDocument();
    expect(onDataChanged).toHaveBeenCalledTimes(1);
  });

  it("refreshes once without refilling the old owner when quick-create confirmation resolves after switching people", async () => {
    const { api, createdChild } = createPageApi();
    const pendingConfirm = deferred<Awaited<ReturnType<MutationApi["confirm"]>>>();
    const onDataChanged = vi.fn();
    let pageListCalls = 0;
    vi.mocked(api.mutations.confirm).mockReturnValue(pendingConfirm.promise);
    vi.mocked(api.people.list).mockImplementation(async (input) => {
      if (Object.prototype.hasOwnProperty.call(input, "query")) {
        return { ok: true, value: [current, secondCurrent, daughter] };
      }
      pageListCalls += 1;
      return {
        ok: true,
        value: pageListCalls === 1
          ? [current, secondCurrent, daughter]
          : [current, secondCurrent, daughter, createdChild]
      };
    });
    vi.mocked(api.people.get).mockImplementation(async ({ personId }) => ({
      ok: true,
      value: personId === secondCurrent.id
        ? detail({ person: secondCurrent })
        : personId === createdChild.id
          ? detail({ person: createdChild })
          : detail()
    }));
    render(<PeoplePage
      workspace={{ id: "workspace-1", name: "测试谱", directory: "opaque", originPersonId: current.id, lastOpenedAt: null, schemaVersion: 7 }}
      api={api}
      initialSelectedPersonId={current.id}
      onDataChanged={onDataChanged}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "快速新建子女" }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: createdChild.displayName } });
    fireEvent.click(screen.getByRole("button", { name: "保存人物" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认写入" }));
    await waitFor(() => expect(api.mutations.confirm).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: `查看${secondCurrent.displayName}` }));
    expect(await screen.findByText(`当前人物固定为：${secondCurrent.displayName}`)).toBeVisible();
    await act(async () => {
      pendingConfirm.resolve({ ok: true, value: { draftId: "draft-1", operationGroupId: "group-1", changedEntityIds: [createdChild.id] } });
      await pendingConfirm.promise;
      await Promise.resolve();
    });

    await waitFor(() => expect(onDataChanged).toHaveBeenCalledTimes(1));
    expect(pageListCalls).toBe(2);
    expect(screen.getByRole("button", { name: `查看${createdChild.displayName}` })).toBeVisible();
    expect(api.people.get).not.toHaveBeenCalledWith({ personId: createdChild.id });
    expect(screen.queryByRole("heading", { name: /快速新建关系人物/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "确认写入" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: `选择子女 ${createdChild.displayName}` })).not.toBeInTheDocument();
    expect(screen.getByText(`当前人物固定为：${secondCurrent.displayName}`)).toBeVisible();
  });

  it("keeps the legacy pairwise editor in a default-collapsed advanced section", async () => {
    const { api } = createPageApi();
    render(<PeoplePage
      workspace={{ id: "workspace-1", name: "测试谱", directory: "opaque", originPersonId: current.id, lastOpenedAt: null, schemaVersion: 7 }}
      api={api}
      initialSelectedPersonId={current.id}
    />);

    const summary = await screen.findByText("高级关系录入");
    const advanced = summary.closest("details");
    expect(advanced).not.toBeNull();
    expect(advanced).not.toHaveAttribute("open");
    expect(within(advanced!).getByRole("heading", { name: "添加关系" })).toBeInTheDocument();
  });
});
