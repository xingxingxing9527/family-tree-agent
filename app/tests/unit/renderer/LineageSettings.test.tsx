// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LineageApi, PersonListItem, WorkspaceLineageReadModel } from "../../../src/shared/contracts";
import { LineageSettings } from "../../../src/renderer/src/features/lineages/LineageSettings";

const people: PersonListItem[] = [
  { id: "founder", displayName: "始祖", aliases: [], gender: "male", birth: null, death: null, notes: null, rowVersion: 1 },
  { id: "member", displayName: "成员", aliases: [], gender: "unknown", birth: null, death: null, notes: null, rowVersion: 1 }
];
const generation = { declared: 3, computed: 2, displayed: 3, source: "declared" as const, conflict: true };
const lineages: WorkspaceLineageReadModel[] = [{
  id: "lineage-a",
  name: "长房",
  founderPersonId: "founder",
  description: "东支",
  memberCount: 2,
  rowVersion: 1,
  memberships: [{ id: "membership-founder", lineageId: "lineage-a", personId: "founder", role: "blood", isPrimary: false, declaredGeneration: null, generationMarker: null, generation: { declared: null, computed: 1, displayed: 1, source: "computed", conflict: false }, rowVersion: 1 }, {
    id: "membership-member", lineageId: "lineage-a", personId: "member", role: "blood", isPrimary: true, declaredGeneration: 3, generationMarker: "承", generation, rowVersion: 2
  }]
}];

function api(): LineageApi {
  const result = { ok: true as const, value: { entityId: "saved", saved: true, warnings: [] } };
  return {
    createLineage: vi.fn().mockResolvedValue(result),
    updateLineage: vi.fn().mockResolvedValue(result),
    archiveLineage: vi.fn().mockResolvedValue(result),
    addMembership: vi.fn().mockResolvedValue(result),
    updateMembership: vi.fn().mockResolvedValue(result),
    removeMembership: vi.fn().mockResolvedValue(result)
  };
}

afterEach(cleanup);

describe("LineageSettings", () => {
  it("creates the first lineage from an empty lineage state", async () => {
    const lineagesApi = api();
    const complete = vi.fn().mockResolvedValue({ status: "refreshed" });
    const onChanged = vi.fn();
    render(<LineageSettings lineages={[]} people={people} api={lineagesApi} prepareMutation={() => ({ complete, retry: complete })} onChanged={onChanged} />);

    expect(screen.getByText("当前谱册还没有支系记录。")).toBeVisible();
    fireEvent.change(screen.getByLabelText("支系名称"), { target: { value: "长房" } });
    fireEvent.change(screen.getByLabelText("支系始祖"), { target: { value: "founder" } });
    fireEvent.change(screen.getByLabelText("支系说明"), { target: { value: "东支" } });
    fireEvent.click(screen.getByRole("button", { name: "创建支系" }));

    await waitFor(() => expect(lineagesApi.createLineage).toHaveBeenCalledWith({ name: "长房", founderPersonId: "founder", description: "东支" }));
    expect(complete).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("shows generation-marker and declared/computed conflict and edits or removes the exact membership", async () => {
    const lineagesApi = api();
    const onChanged = vi.fn();
    render(<LineageSettings lineages={lineages} people={people} api={lineagesApi} onChanged={onChanged} />);

    const membership = screen.getByRole("listitem", { name: "成员在长房的归属" });
    expect(membership).toHaveTextContent("字辈：承");
    expect(membership).toHaveTextContent("世代冲突：声明第3代，计算第2代");
    fireEvent.click(within(membership).getByRole("button", { name: "编辑成员在长房的归属" }));
    fireEvent.change(within(membership).getByLabelText("归属角色"), { target: { value: "associated" } });
    fireEvent.change(within(membership).getByLabelText("声明世代"), { target: { value: "5" } });
    fireEvent.change(within(membership).getByLabelText("字辈"), { target: { value: "世" } });
    fireEvent.click(within(membership).getByLabelText("主归属"));
    fireEvent.click(within(membership).getByRole("button", { name: "保存归属" }));

    await waitFor(() => expect(lineagesApi.updateMembership).toHaveBeenCalledWith({
      membershipId: "membership-member",
      expectedVersion: 2,
      patch: { lineageRole: "associated", isPrimary: false, declaredGeneration: 5, generationMarker: "世" }
    }));
    fireEvent.click(within(membership).getByRole("button", { name: "移除成员在长房的归属" }));
    await waitFor(() => expect(lineagesApi.removeMembership).toHaveBeenCalledWith({ membershipId: "membership-member", expectedVersion: 2 }));
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});
