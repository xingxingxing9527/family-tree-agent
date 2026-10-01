// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppResult, FamilyAgentApi, PersonDetailReadModel, PersonDraft } from "../../../src/shared/contracts";
import type { MutationApi } from "../../../src/shared/mutations";
import { PersonEditor } from "../../../src/renderer/src/features/people/PersonEditor";

afterEach(cleanup);

const savedDetail: PersonDetailReadModel = {
  person: {
    id: "person-1",
    displayName: "张敏",
    gender: "female",
    birth: null,
    death: null,
    notes: null,
    rowVersion: 2
  },
  aliases: [],
  parents: [],
  children: [],
  marriages: []
};

function createPeopleApi(
  updateResult: AppResult<{ entityId: string | null; saved: boolean; warnings: Array<{ code: string; message: string }> }> = {
    ok: true,
    value: { entityId: "person-1", saved: true, warnings: [] }
  }
): FamilyAgentApi["people"] {
  return {
    list: vi.fn(),
    get: vi.fn().mockResolvedValue({ ok: true, value: savedDetail }),
    save: vi.fn().mockResolvedValue({ ok: true, value: { entityId: "person-1", saved: true, warnings: [] } }),
    update: vi.fn().mockResolvedValue(updateResult)
  };
}

function createMutationApi(): MutationApi {
  return {
    stage: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        id: "draft-1", workspaceId: "workspace-1", version: 1, expiresAt: "2099-01-01T00:00:00.000Z", expectedVersions: { "person-1": 1 },
        changes: [{ id: "change-1", disposition: "update", entityType: "person", entityId: "person-1", summary: "更新人物资料", fieldChanges: [] }],
        issues: [], canConfirm: true
      }
    }),
    confirm: vi.fn(),
    revise: vi.fn()
  };
}

const existingDraft: PersonDraft = {
  displayName: "张敏",
  aliases: [],
  gender: "female",
  birth: null,
  death: null,
  notes: "原备注",
  sourceDescription: "族谱手录"
};

describe("PersonEditor", () => {
  it("requires year and month after a calendar is chosen while leaving day optional", () => {
    render(<PersonEditor api={createPeopleApi()} />);

    fireEvent.change(screen.getByLabelText("出生日期历法"), { target: { value: "solar" } });

    expect(screen.getByLabelText("出生年份")).toBeRequired();
    expect(screen.getByLabelText("出生月份")).toBeRequired();
    expect(screen.getByLabelText("出生日期")).not.toBeRequired();
  });

  it("shows the leap-month control only for lunar dates", () => {
    render(<PersonEditor api={createPeopleApi()} />);

    expect(screen.queryByLabelText("出生日期为闰月")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("出生日期历法"), { target: { value: "solar" } });
    expect(screen.queryByLabelText("出生日期为闰月")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("出生日期历法"), { target: { value: "lunar" } });
    expect(screen.getByLabelText("出生日期为闰月")).toBeInTheDocument();
  });

  it("keeps unsaved values and displays a conflict banner after a stale update", async () => {
    const api = createPeopleApi({
      ok: false,
      error: { code: "CONFLICT", message: "该人物已被其他修改更新" }
    });
    render(<PersonEditor api={api} personId="person-1" expectedVersion={1} initialValue={existingDraft} />);

    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "尚未保存的新备注" } });
    fireEvent.click(screen.getByRole("button", { name: "保存人物" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("该人物已被其他修改更新");
    expect(screen.getByLabelText("备注")).toHaveValue("尚未保存的新备注");
  });

  it("requires explicit return or confirmation when domain warnings are returned", async () => {
    const api = createPeopleApi({
      ok: true,
      value: {
        entityId: null,
        saved: false,
        warnings: [{ code: "PARENT_AGE_WARNING", message: "年龄差可能异常" }]
      }
    });
    render(<PersonEditor api={api} personId="person-1" expectedVersion={1} initialValue={existingDraft} />);

    fireEvent.click(screen.getByRole("button", { name: "保存人物" }));

    expect(await screen.findByText("年龄差可能异常")).toBeVisible();
    expect(screen.getByRole("button", { name: "返回修改" })).toBeVisible();
    expect(screen.getByRole("button", { name: "确认保存" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    await waitFor(() => expect(api.update).toHaveBeenLastCalledWith(expect.objectContaining({ confirmWarnings: true })));
  });

  it("refreshes persisted detail after a successful save", async () => {
    const api = createPeopleApi();
    const onSaved = vi.fn();
    render(<PersonEditor api={api} personId="person-1" expectedVersion={1} initialValue={existingDraft} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole("button", { name: "保存人物" }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith({ personId: "person-1" }));
    expect(onSaved).toHaveBeenCalledWith(savedDetail);
  });

  it("stages Web edits for review before calling the legacy person gateway", async () => {
    const api = createPeopleApi();
    const mutations = createMutationApi();
    render(<PersonEditor api={api} mutations={mutations} personId="person-1" expectedVersion={1} initialValue={existingDraft} />);

    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "待确认的新备注" } });
    fireEvent.click(screen.getByRole("button", { name: "保存人物" }));

    expect(await screen.findByRole("dialog", { name: "确认写入" })).toBeVisible();
    expect(mutations.stage).toHaveBeenCalledWith({ intents: [expect.objectContaining({ type: "person.update", personId: "person-1", expectedVersion: 1 })] });
    expect(api.update).not.toHaveBeenCalled();
  });

  it("marks primary and secondary copy with the established readable color roles", () => {
    render(<PersonEditor api={createPeopleApi()} />);

    expect(screen.getByRole("heading", { name: "新增人物" })).toHaveClass("text-primary");
    expect(screen.getByText("日期一旦填写，历法、年份和月份均为必填项。", { exact: false })).toHaveClass("text-secondary");
    expect(screen.getByLabelText("姓名")).toHaveClass("field-control");
  });

  it("recovers from a rejected save without exposing its exception", async () => {
    const api = createPeopleApi();
    vi.mocked(api.update).mockRejectedValue(new Error("C:\\private\\family.sqlite 张敏"));
    render(<PersonEditor api={api} personId="person-1" expectedVersion={1} initialValue={existingDraft} />);
    fireEvent.click(screen.getByRole("button", { name: "保存人物" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法保存人物");
    expect(screen.queryByText(/private|family\.sqlite/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存人物" })).toBeEnabled();
  });
});
