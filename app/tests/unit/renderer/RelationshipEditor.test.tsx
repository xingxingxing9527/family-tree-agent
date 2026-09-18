// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, PersonListItem } from "../../../src/shared/contracts";
import { RelationshipEditor } from "../../../src/renderer/src/features/relations/RelationshipEditor";

afterEach(cleanup);

const people: PersonListItem[] = [
  { id: "parent-1", displayName: "张国强", aliases: [], gender: "male", birth: null, death: null, notes: null, rowVersion: 1 },
  { id: "child-1", displayName: "张敏", aliases: [], gender: "female", birth: null, death: null, notes: null, rowVersion: 1 },
  { id: "child-2", displayName: "张伟", aliases: [], gender: "male", birth: null, death: null, notes: null, rowVersion: 1 }
];

function createApis(): { peopleApi: DesktopApi["people"]; relationsApi: DesktopApi["relations"] } {
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

describe("RelationshipEditor", () => {
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
});
