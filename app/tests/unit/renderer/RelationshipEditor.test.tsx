// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FamilyAgentApi, PersonListItem } from "../../../src/shared/contracts";
import type { MutationApi } from "../../../src/shared/mutations";
import { RelationshipEditor } from "../../../src/renderer/src/features/relations/RelationshipEditor";
import { MarriageHistory } from "../../../src/renderer/src/features/relations/MarriageHistory";

afterEach(cleanup);

const people: PersonListItem[] = [
  { id: "parent-1", displayName: "张国强", aliases: [], gender: "male", birth: null, death: null, notes: null, rowVersion: 1 },
  { id: "child-1", displayName: "张敏", aliases: [], gender: "female", birth: null, death: null, notes: null, rowVersion: 1 },
  { id: "child-2", displayName: "张伟", aliases: [], gender: "male", birth: null, death: null, notes: null, rowVersion: 1 }
];

function createApis(): { peopleApi: FamilyAgentApi["people"]; relationsApi: FamilyAgentApi["relations"] } {
  return {
    peopleApi: {
      list: vi.fn().mockResolvedValue({ ok: true, value: people }),
      get: vi.fn(),
      save: vi.fn(),
      update: vi.fn()
    },
    relationsApi: {
      addParentChild: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { entityId: null, saved: false, warnings: [{ code: "PARENT_AGE_WARNING", message: "年龄差可能异常" }] } })
        .mockResolvedValueOnce({ ok: true, value: { entityId: "relation-2", saved: true, warnings: [] } }),
      addMarriage: vi.fn(),
      divorce: vi.fn()
    }
  };
}

function createMutationApi(): MutationApi {
  return {
    stage: vi.fn().mockImplementation(async ({ intents }) => ({ ok: true, value: {
      id: "draft-1", workspaceId: "workspace-1", version: 1, expiresAt: "2099-01-01T00:00:00.000Z", expectedVersions: {},
      changes: [{ id: "change-1", disposition: intents[0].type.includes("divorce") ? "update" : "create", entityType: intents[0].type, entityId: "entity-1", summary: "待确认关系", fieldChanges: [] }],
      issues: [], canConfirm: true
    } })),
    confirm: vi.fn(),
    revise: vi.fn()
  };
}

describe("RelationshipEditor", () => {
  it("stages Web parent-child entry before the legacy relationship gateway", async () => {
    const { peopleApi, relationsApi } = createApis();
    const mutations = createMutationApi();
    render(<RelationshipEditor people={people} peopleApi={peopleApi} relationsApi={relationsApi} mutations={mutations} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("父母人物"), { target: { value: "parent-1" } });
    fireEvent.change(screen.getByLabelText("子女人物"), { target: { value: "child-1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存亲子关系" }));

    expect(await screen.findByRole("dialog", { name: "确认写入" })).toBeVisible();
    expect(mutations.stage).toHaveBeenCalledWith({ intents: [expect.objectContaining({ type: "parentChild.add", draft: expect.objectContaining({ parentId: "parent-1", childId: "child-1" }) })] });
    expect(relationsApi.addParentChild).not.toHaveBeenCalled();
  });

  it("keeps the advanced pairwise marriage flow on the staged mutation path", async () => {
    const { peopleApi, relationsApi } = createApis();
    const mutations = createMutationApi();
    render(<RelationshipEditor people={people} peopleApi={peopleApi} relationsApi={relationsApi} mutations={mutations} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("配偶一"), { target: { value: "parent-1" } });
    fireEvent.change(screen.getByLabelText("配偶二"), { target: { value: "child-1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存婚姻" }));

    expect(await screen.findByRole("dialog", { name: "确认写入" })).toBeVisible();
    expect(mutations.stage).toHaveBeenCalledWith({ intents: [{
      type: "marriage.add",
      draft: {
        spouseAId: "parent-1",
        spouseBId: "child-1",
        start: null,
        sourceDescription: "表单录入"
      }
    }] });
    expect(relationsApi.addMarriage).not.toHaveBeenCalled();
  });

  it("discards a warning preview when visible draft fields change instead of confirming the old hidden draft", async () => {
    const { peopleApi, relationsApi } = createApis();
    render(<RelationshipEditor people={people} peopleApi={peopleApi} relationsApi={relationsApi} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("父母人物"), { target: { value: "parent-1" } });
    fireEvent.change(screen.getByLabelText("子女人物"), { target: { value: "child-1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存亲子关系" }));

    expect(await screen.findByText("年龄差可能异常")).toBeVisible();
    expect(screen.getByRole("button", { name: "返回修改" })).toBeVisible();
    expect(screen.getByRole("button", { name: "确认保存" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("子女人物"), { target: { value: "child-2" } });

    expect(screen.queryByRole("button", { name: "确认保存" })).not.toBeInTheDocument();
    expect(screen.queryByText("年龄差可能异常")).not.toBeInTheDocument();
    expect(relationsApi.addParentChild).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "保存亲子关系" }));
    await waitFor(() => expect(relationsApi.addParentChild).toHaveBeenCalledTimes(2));
    expect(relationsApi.addParentChild).toHaveBeenLastCalledWith({
      draft: { parentId: "parent-1", childId: "child-2", parentRole: "father", sourceDescription: "表单录入" },
      confirmWarnings: false
    });
    expect(relationsApi.addParentChild).not.toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ childId: "child-1" }),
      confirmWarnings: true
    }));
  });

  it("recovers from rejected relationship and divorce operations", async () => {
    const { peopleApi, relationsApi } = createApis();
    vi.mocked(relationsApi.addParentChild).mockReset().mockRejectedValue(new Error("private family fact"));
    const { unmount } = render(<RelationshipEditor people={people} peopleApi={peopleApi} relationsApi={relationsApi} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("父母人物"), { target: { value: "parent-1" } });
    fireEvent.change(screen.getByLabelText("子女人物"), { target: { value: "child-1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存亲子关系" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法保存关系");
    expect(screen.queryByText("private family fact")).not.toBeInTheDocument();
    unmount();

    vi.mocked(relationsApi.divorce).mockRejectedValue(new Error("private family fact"));
    render(<MarriageHistory marriages={[{ id: "marriage-1", spouse: people[1]!, status: "active", start: null, end: null, rowVersion: 1 }]} api={relationsApi} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "登记离婚" }));
    fireEvent.click(screen.getByRole("button", { name: "确认离婚" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法登记离婚");
  });

  it("stages a Web divorce before the legacy relationship gateway", async () => {
    const { relationsApi } = createApis();
    const mutations = createMutationApi();
    render(<MarriageHistory marriages={[{ id: "marriage-1", spouse: people[1]!, status: "active", start: null, end: null, rowVersion: 3 }]} api={relationsApi} mutations={mutations} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "登记离婚" }));
    fireEvent.click(screen.getByRole("button", { name: "确认离婚" }));

    expect(await screen.findByRole("dialog", { name: "确认写入" })).toBeVisible();
    expect(mutations.stage).toHaveBeenCalledWith({ intents: [{ type: "marriage.divorce", marriageId: "marriage-1", endDate: null, expectedVersion: 3 }] });
    expect(relationsApi.divorce).not.toHaveBeenCalled();
  });
});
