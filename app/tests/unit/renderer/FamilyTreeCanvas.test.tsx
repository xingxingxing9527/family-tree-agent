// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TreeProjection, TreeProjectionTopology } from "../../../src/main/domain/projection/tree-projection-service";
import { layoutWithElk } from "../../../src/renderer/src/features/tree/layout-with-elk";
import { FamilyTreeCanvas } from "../../../src/renderer/src/features/tree/FamilyTreeCanvas";
import { FamilyTreePage } from "../../../src/renderer/src/features/tree/FamilyTreePage";
import { TreeProjectionService } from "../../../src/main/domain/projection/tree-projection-service";

vi.mock("@xyflow/react", async () => {
  const ReactModule = await import("react");
  return {
    ReactFlow: ({ nodes, edges, nodeTypes }: {
      nodes: Array<{ id: string; type: string; data: unknown }>;
      edges: Array<{ id: string }>;
      nodeTypes: Record<string, React.ComponentType<{ id: string; data: unknown }>>;
    }) => ReactModule.createElement("div", { "aria-label": "家谱图" },
      ...nodes.map((node) => ReactModule.createElement(nodeTypes[node.type], { key: node.id, id: node.id, data: node.data })),
      ...edges.map((edge) => ReactModule.createElement("span", { key: edge.id, "data-edge-id": edge.id }))
    ),
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    Position: { Top: "top", Bottom: "bottom" }
  };
});

afterEach(cleanup);

const topology: TreeProjectionTopology = {
  key: "family",
  nodes: [
    {
      id: "person:parent-a",
      kind: "person",
      personId: "parent-a",
      display: { displayName: "甲", birthYear: 1960, deathYear: null, generation: null }
    },
    {
      id: "person:parent-b",
      kind: "person",
      personId: "parent-b",
      display: { displayName: "乙", birthYear: 1962, deathYear: null, generation: null }
    },
    {
      id: "marriage:one",
      kind: "union",
      unionId: "marriage:one",
      display: { kind: "marriage", marriageStatus: "divorced", warnings: [] }
    },
    {
      id: "person:child",
      kind: "person",
      personId: "child",
      display: { displayName: "孩子", birthYear: 1990, deathYear: null, generation: null }
    }
  ],
  edges: [
    { id: "parent:a", source: "person:parent-a", target: "marriage:one", kind: "parentUnion", marriageStatus: "divorced" },
    { id: "parent:b", source: "person:parent-b", target: "marriage:one", kind: "parentUnion", marriageStatus: "divorced" },
    { id: "child:one", source: "marriage:one", target: "person:child", kind: "unionChild", marriageStatus: "divorced" }
  ]
};

describe("family tree layout", () => {
  it("precomputes a layered parent-union-child layout with ELK", async () => {
    const laidOut = await layoutWithElk(topology);
    const position = (id: string) => laidOut.nodes.find((node) => node.id === id)!.position;

    expect(position("person:parent-a").y).toBeLessThan(position("marriage:one").y);
    expect(position("person:parent-b").y).toBeLessThan(position("marriage:one").y);
    expect(position("marriage:one").y).toBeLessThan(position("person:child").y);
    expect(laidOut.edges.map((edge) => edge.id)).toEqual(["parent:a", "parent:b", "child:one"]);
  });
});

describe("FamilyTreeCanvas", () => {
  const projection = (viewpointId: string, label: string): TreeProjection => ({
    topology: {
      ...topology,
      nodes: topology.nodes.map((node) => node.kind === "person" && node.personId === "parent-a"
        ? {
            ...node,
            display: {
              ...node.display,
              generation: { declared: null, computed: 1, displayed: 1, source: "computed", conflict: false }
            }
          }
        : node)
    },
    viewpointId,
    labels: { "parent-a": label, "parent-b": "母亲", child: "本人" }
  });

  it("renders high-contrast person cards and an ended marriage without duplicating people", async () => {
    render(<FamilyTreeCanvas projection={projection("child", "父亲")} />);

    const parentCard = await screen.findByRole("group", { name: "人物：甲" });
    expect(screen.getAllByText("甲")).toHaveLength(1);
    expect(parentCard).toHaveStyle({ backgroundColor: "#ffffff", color: "#0f172a" });
    expect(screen.getByText("甲")).toHaveStyle({ fontSize: "15px" });
    expect(screen.getByText("父亲")).toBeVisible();
    expect(screen.getByText("第 1 代（系统推导）")).toBeVisible();
    expect(screen.getByRole("group", { name: "家庭联合：已结束婚姻" })).toHaveClass("family-union-node", "ended");
    expect(screen.getByText("已结束婚姻")).toBeVisible();
  });

  it("updates viewpoint-only labels without running ELK again for the same topology", async () => {
    const stableTopology = topology;
    const first: TreeProjection = { topology: stableTopology, viewpointId: "child", labels: { "parent-a": "父亲" } };
    const second: TreeProjection = { topology: stableTopology, viewpointId: "parent-b", labels: { "parent-a": "配偶" } };
    const layout = vi.fn(layoutWithElk);
    const { rerender } = render(<FamilyTreeCanvas projection={first} layout={layout} />);

    expect(await screen.findByText("父亲")).toBeVisible();
    await waitFor(() => expect(layout).toHaveBeenCalledTimes(1));
    rerender(<FamilyTreeCanvas projection={second} layout={layout} />);

    expect(await screen.findByText("配偶")).toBeVisible();
    expect(layout).toHaveBeenCalledTimes(1);
  });
});

describe("FamilyTreePage", () => {
  it("offers full, branch, ancestor and descendant views while keeping viewpoint separate", async () => {
    const service = new TreeProjectionService({
      people: [
        { id: "a", displayName: "甲", birthYear: null, deathYear: null, generation: null },
        { id: "b", displayName: "乙", birthYear: null, deathYear: null, generation: null },
        { id: "child", displayName: "孩子", birthYear: null, deathYear: null, generation: null },
        { id: "isolated", displayName: "旁支", birthYear: null, deathYear: null, generation: null }
      ],
      unions: [{
        id: "parents:a:b",
        kind: "coParents",
        parentIds: ["a", "b"],
        marriageId: null,
        marriageStatus: null,
        childIds: ["child"],
        warnings: []
      }]
    }, (viewpointId, targetId) => viewpointId === targetId ? "本人" : "亲属");
    render(<FamilyTreePage
      service={service}
      people={[{ id: "a", displayName: "甲" }, { id: "child", displayName: "孩子" }, { id: "isolated", displayName: "旁支" }]}
      initialViewpointId="a"
    />);

    expect(screen.getByRole("button", { name: "全谱" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("group", { name: "人物：旁支" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("查看人物"), { target: { value: "child" } });
    fireEvent.click(screen.getByRole("button", { name: "祖先" }));

    await waitFor(() => expect(screen.queryByRole("group", { name: "人物：旁支" })).not.toBeInTheDocument());
    expect(screen.getByRole("group", { name: "人物：甲" })).toBeVisible();
    expect(screen.getByRole("button", { name: "祖先" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("当前视角"), { target: { value: "child" } });
    expect(await screen.findByText("本人")).toBeVisible();

    for (const view of ["分支", "后代", "全谱"]) {
      fireEvent.click(screen.getByRole("button", { name: view }));
      expect(screen.getByRole("button", { name: view })).toHaveAttribute("aria-pressed", "true");
    }
  });
});
