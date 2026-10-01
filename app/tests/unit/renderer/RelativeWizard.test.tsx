// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FamilyAgentApi, PersonListItem } from "../../../src/shared/contracts";
import { RelativeWizard } from "../../../src/renderer/src/features/relations/RelativeWizard";

afterEach(cleanup);

const people: PersonListItem[] = [
  { id: "anchor", personCode: "P000001", displayName: "王小明", aliases: [], gender: "male", birth: null, death: null, notes: null, rowVersion: 1 },
  { id: "parent", personCode: "P000002", displayName: "王建国", aliases: [], gender: "male", birth: null, death: null, notes: null, rowVersion: 1 },
  { id: "grandparent", personCode: "P000003", displayName: "王守义", aliases: [], gender: "male", birth: null, death: null, notes: null, rowVersion: 1 },
  { id: "target", personCode: "P000004", displayName: "王建军", aliases: [], gender: "male", birth: null, death: null, notes: null, rowVersion: 1 }
];

describe("RelativeWizard", () => {
  it("shows the named path and forwards only base intents to staged review", async () => {
    const intent = { type: "parentChild.add" as const, draft: { parentId: "grandparent", childId: "target", parentRole: "father" as const, sourceDescription: "更多亲属向导：叔伯/舅舅" } };
    const relationsApi = { planRelativePath: vi.fn().mockResolvedValue({ ok: true, value: {
      templateId: "uncle", resolvedIntermediaryIds: { parent: "parent", grandparent: "grandparent" }, requiredSelections: [], intents: [intent],
      resultingPath: { personIds: ["anchor", "parent", "grandparent", "target"], forwardTerm: "叔伯/舅舅", reverseTerm: "侄子女/外甥子女" }
    } }) } as unknown as FamilyAgentApi["relations"];
    const onStage = vi.fn();
    render(<RelativeWizard people={people} relationsApi={relationsApi} onStage={onStage} />);

    fireEvent.change(screen.getByLabelText("视角人物"), { target: { value: "anchor" } });
    fireEvent.change(screen.getByLabelText("新增亲属人物"), { target: { value: "target" } });
    fireEvent.change(screen.getByLabelText("关系类型"), { target: { value: "uncle" } });
    fireEvent.click(screen.getByRole("button", { name: "规划关系路径" }));

    expect(await screen.findByText("王小明 → 王建国 → 王守义 → 王建军")).toBeVisible();
    expect(screen.getByText(/互称/)).toHaveTextContent("叔伯/舅舅");
    fireEvent.click(screen.getByRole("button", { name: "进入写入预览" }));
    expect(onStage).toHaveBeenCalledWith([intent]);
  });

  it("asks the administrator to choose a missing intermediary and replans", async () => {
    const required = {
      templateId: "grandparent", resolvedIntermediaryIds: {}, intents: [],
      requiredSelections: [{ role: "parent", label: "视角人物的父母", candidateIds: ["parent"], reason: "路径中缺少父母人物" }],
      resultingPath: { personIds: ["anchor", "target"], forwardTerm: "祖父母", reverseTerm: "孙子女" }
    };
    const complete = { ...required, resolvedIntermediaryIds: { parent: "parent" }, requiredSelections: [], intents: [{ type: "parentChild.add" as const, draft: { parentId: "parent", childId: "anchor", parentRole: "father" as const, sourceDescription: "更多亲属向导：祖父母" } }], resultingPath: { ...required.resultingPath, personIds: ["anchor", "parent", "target"] } };
    const planRelativePath = vi.fn().mockResolvedValueOnce({ ok: true, value: required }).mockResolvedValueOnce({ ok: true, value: complete });
    const relationsApi = { planRelativePath } as unknown as FamilyAgentApi["relations"];
    render(<RelativeWizard people={people} relationsApi={relationsApi} onStage={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("视角人物"), { target: { value: "anchor" } });
    fireEvent.change(screen.getByLabelText("新增亲属人物"), { target: { value: "target" } });
    fireEvent.change(screen.getByLabelText("关系类型"), { target: { value: "grandparent" } });
    fireEvent.click(screen.getByRole("button", { name: "规划关系路径" }));
    expect(await screen.findByLabelText("中间人：视角人物的父母")).toBeVisible();
    fireEvent.change(screen.getByLabelText("中间人：视角人物的父母"), { target: { value: "parent" } });
    fireEvent.click(screen.getByRole("button", { name: "更新关系路径" }));

    await waitFor(() => expect(planRelativePath).toHaveBeenLastCalledWith(expect.objectContaining({ selectedIntermediaryIds: { parent: "parent" } })));
    expect(await screen.findByText("王小明 → 王建国 → 王建军")).toBeVisible();
  });
});
