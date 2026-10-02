// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FamilyAgentApi, PersonDetailReadModel, PersonListItem } from "../../../src/shared/contracts";
import { TreeProjectionService } from "../../../src/main/domain/projection/tree-projection-service";
import { ViewpointProvider } from "../../../src/renderer/src/app/ViewpointContext";
import { FamilyTreePage } from "../../../src/renderer/src/features/tree/FamilyTreePage";

vi.mock("@xyflow/react", async () => {
  const ReactModule = await import("react");
  return {
    ReactFlow: ({ nodes, nodeTypes, onNodeClick, onPaneClick }: {
      nodes: Array<{ id: string; type: string; data: unknown; selected?: boolean }>;
      nodeTypes: Record<string, React.ComponentType<{ id: string; data: unknown; selected?: boolean }>>;
      onNodeClick?(event: React.MouseEvent, node: unknown): void;
      onPaneClick?(): void;
    }) => ReactModule.createElement("div", { "aria-label": "家谱图" },
      ...nodes.map((node) => ReactModule.createElement("div", {
        key: node.id,
        "data-testid": `flow-node:${node.id}`,
        onClick: (event: React.MouseEvent) => onNodeClick?.(event, node)
      }, ReactModule.createElement(nodeTypes[node.type], { id: node.id, data: node.data, selected: node.selected }))),
      ReactModule.createElement("button", { type: "button", onClick: () => onPaneClick?.() }, "画布空白")
    ),
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" }
  };
});

afterEach(cleanup);

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

describe("FamilyTreePage context drawer", () => {
  it("opens a real person detail, supports editing and quick relative creation, refreshes, and closes with Escape", async () => {
    const people = [person("a", "甲"), person("b", "乙")];
    let currentDetail: PersonDetailReadModel = { person: people[0]!, aliases: [], parents: [], children: [], marriages: [] };
    const projection = new TreeProjectionService({
      people: people.map((entry) => ({
        id: entry.id,
        displayName: entry.displayName,
        birthYear: null,
        deathYear: null,
        generation: null,
        generationMarker: null,
        lineageRole: "blood" as const
      })),
      unions: []
    }).full("a", Number.POSITIVE_INFINITY);
    const projectTree = vi.fn().mockResolvedValue({ ok: true, value: projection });
    const onDataChanged = vi.fn();
    const api = {
      projectTree,
      query: { projectTree, calculateRelationship: vi.fn() },
      people: {
        list: vi.fn().mockResolvedValue({ ok: true, value: people }),
        get: vi.fn(async () => ({ ok: true as const, value: currentDetail })),
        update: vi.fn(async (input: { patch: { displayName?: string } }) => {
          currentDetail = {
            ...currentDetail,
            person: { ...currentDetail.person, displayName: input.patch.displayName ?? currentDetail.person.displayName, rowVersion: currentDetail.person.rowVersion + 1 }
          };
          return { ok: true as const, value: { entityId: "a", saved: true, warnings: [] } };
        }),
        save: vi.fn(),
        getChildrenCountStatus: vi.fn().mockResolvedValue({ ok: true, value: { count: 0, completeness: "partial" } })
      },
      relations: {
        planParentCompletion: vi.fn().mockResolvedValue({ ok: false, error: { message: "not used" } })
      },
      media: { listForPerson: vi.fn().mockResolvedValue({ ok: true, value: [] }) },
      mutations: undefined
    } as unknown as FamilyAgentApi & { projectTree: typeof projectTree };

    render(
      <ViewpointProvider workspaceId="workspace" visiblePersonIds={[]} validPersonIds={people.map(({ id }) => id)} fallbackViewpointId="a" query={api.query}>
        <FamilyTreePage api={api} people={people} onDataChanged={onDataChanged} />
      </ViewpointProvider>
    );

    fireEvent.click(await screen.findByTestId("flow-node:person:a"));
    expect(await screen.findByRole("complementary", { name: "人物与关系编辑" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "甲" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "编辑人物" }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "甲（已修改）" } });
    fireEvent.click(screen.getByRole("button", { name: "保存人物" }));

    expect(await screen.findByRole("heading", { name: "甲（已修改）" })).toBeVisible();
    await waitFor(() => expect(onDataChanged).toHaveBeenCalled());
    expect(projectTree.mock.calls.length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: "新建人物并设为母亲" }));
    expect(await screen.findByRole("heading", { name: "快速新建关系人物：母亲" })).toBeVisible();
    expect(screen.getByLabelText("姓名")).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "人物与关系编辑" })).not.toBeInTheDocument();
  });
});

