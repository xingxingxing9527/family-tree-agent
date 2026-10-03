// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TreeProjection, TreeProjectionTopology } from "../../../src/main/domain/projection/tree-projection-service";
import { layoutWithElk } from "../../../src/renderer/src/features/tree/layout-with-elk";
import { FamilyTreeCanvas } from "../../../src/renderer/src/features/tree/FamilyTreeCanvas";
import { FamilyTreePage } from "../../../src/renderer/src/features/tree/FamilyTreePage";
import { TreeProjectionService } from "../../../src/main/domain/projection/tree-projection-service";
import { ViewpointProvider } from "../../../src/renderer/src/app/ViewpointContext";
import type { KinshipDisplayLabelDto } from "../../../src/shared/contracts";

vi.mock("@xyflow/react", async () => {
  const ReactModule = await import("react");
  return {
    ReactFlow: ({ nodes, edges, nodeTypes, onNodeClick, onEdgeClick, onPaneClick }: {
      nodes: Array<{ id: string; type: string; data: unknown; selected?: boolean }>;
      edges: Array<{ id: string; data?: unknown; selected?: boolean }>;
      nodeTypes: Record<string, React.ComponentType<{ id: string; data: unknown }>>;
      onNodeClick?(event: React.MouseEvent, node: unknown): void;
      onEdgeClick?(event: React.MouseEvent, edge: unknown): void;
      onPaneClick?(): void;
    }) => ReactModule.createElement("div", { "aria-label": "家谱图" },
      ...nodes.map((node) => ReactModule.createElement("div", {
        key: node.id,
        "data-testid": `flow-node:${node.id}`,
        "data-selected": node.selected ? "true" : "false",
        onClick: (event: React.MouseEvent) => onNodeClick?.(event, node)
      }, ReactModule.createElement(nodeTypes[node.type], { id: node.id, data: node.data, selected: node.selected }))),
      ...edges.map((edge) => ReactModule.createElement("button", {
        key: edge.id,
        type: "button",
        "aria-label": `关系线：${edge.id}`,
        "data-selected": edge.selected ? "true" : "false",
        onClick: (event: React.MouseEvent) => onEdgeClick?.(event, edge)
      })),
      ReactModule.createElement("button", { type: "button", onClick: () => onPaneClick?.() }, "画布空白")
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
      display: { displayName: "甲", birthYear: 1960, deathYear: null, generation: null, generationMarker: null, lineageRole: "blood" }
    },
    {
      id: "person:parent-b",
      kind: "person",
      personId: "parent-b",
      display: { displayName: "乙", birthYear: 1962, deathYear: null, generation: null, generationMarker: null, lineageRole: "married_in" }
    },
    {
      id: "marriage:one",
      kind: "union",
      unionId: "marriage:one",
      parentIds: ["parent-a", "parent-b"],
      childIds: ["child"],
      marriageId: "one",
      display: {
        kind: "marriage",
        marriageStatus: "divorced",
        marriageStart: { calendar: "solar", year: 1980, month: 1, day: null, leapMonth: false, precision: "month" },
        marriageEnd: { calendar: "lunar", year: 1990, month: 2, day: 3, leapMonth: true, precision: "day" },
        warnings: []
      }
    },
    {
      id: "person:child",
      kind: "person",
      personId: "child",
      display: { displayName: "孩子", birthYear: 1990, deathYear: null, generation: null, generationMarker: null, lineageRole: "blood" }
    }
  ],
  edges: [
    { id: "parent:a", source: "person:parent-a", target: "marriage:one", kind: "parentUnion", unionId: "marriage:one", parentIds: ["parent-a", "parent-b"], childId: null, marriageId: "one", marriageStatus: "divorced" },
    { id: "parent:b", source: "person:parent-b", target: "marriage:one", kind: "parentUnion", unionId: "marriage:one", parentIds: ["parent-a", "parent-b"], childId: null, marriageId: "one", marriageStatus: "divorced" },
    { id: "child:one", source: "marriage:one", target: "person:child", kind: "unionChild", unionId: "marriage:one", parentIds: ["parent-a", "parent-b"], childId: "child", marriageId: "one", marriageStatus: "divorced" }
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
    expect(laidOut.edges.filter((edge) => edge.id.startsWith("parent:")).every((edge) => edge.data?.visualRole === "marriage")).toBe(true);
    expect(laidOut.edges.find((edge) => edge.id === "child:one")?.data?.visualRole).toBe("descent");
    const centerY = (id: string, height: number) => position(id).y + height / 2;
    expect(centerY("marriage:one", 72)).toBe(centerY("person:parent-a", 116));
    expect(centerY("marriage:one", 72)).toBe(centerY("person:parent-b", 116));
  });

  it("uses compact rendered node geometry so layout spacing matches the cards", async () => {
    const laidOut = await layoutWithElk(topology);
    const person = laidOut.nodes.find((node) => node.id === "person:parent-a")!;
    const union = laidOut.nodes.find((node) => node.id === "marriage:one")!;

    expect(person.style).toMatchObject({ width: 180, height: 116 });
    expect(union.style).toMatchObject({ width: 112, height: 72 });
    const top = Math.min(...laidOut.nodes.map((node) => node.position.y));
    const bottom = Math.max(...laidOut.nodes.map((node) => node.position.y + Number(node.style?.height ?? 0)));
    expect(bottom - top).toBeLessThanOrEqual(400);
  });

  it("keeps adjacent spouse families from overlapping after horizontal alignment", async () => {
    const crowdedTopology: TreeProjectionTopology = {
      key: "adjacent-families",
      nodes: [
        { id: "person:a", kind: "person", personId: "a", display: { displayName: "甲", birthYear: null, deathYear: null, generation: null, generationMarker: null, lineageRole: "blood" } },
        { id: "person:b", kind: "person", personId: "b", display: { displayName: "乙", birthYear: null, deathYear: null, generation: null, generationMarker: null, lineageRole: "married_in" } },
        { id: "marriage:first", kind: "union", unionId: "marriage:first", display: { kind: "marriage", marriageStatus: "active", marriageStart: null, marriageEnd: null, warnings: [] } },
        { id: "person:first-child", kind: "person", personId: "first-child", display: { displayName: "孩子一", birthYear: null, deathYear: null, generation: null, generationMarker: null, lineageRole: "blood" } },
        { id: "person:c", kind: "person", personId: "c", display: { displayName: "丙", birthYear: null, deathYear: null, generation: null, generationMarker: null, lineageRole: "blood" } },
        { id: "person:d", kind: "person", personId: "d", display: { displayName: "丁", birthYear: null, deathYear: null, generation: null, generationMarker: null, lineageRole: "married_in" } },
        { id: "marriage:second", kind: "union", unionId: "marriage:second", display: { kind: "marriage", marriageStatus: "active", marriageStart: null, marriageEnd: null, warnings: [] } },
        { id: "person:second-child", kind: "person", personId: "second-child", display: { displayName: "孩子二", birthYear: null, deathYear: null, generation: null, generationMarker: null, lineageRole: "blood" } }
      ],
      edges: [
        { id: "first:a", source: "person:a", target: "marriage:first", kind: "parentUnion", marriageStatus: "active" },
        { id: "first:b", source: "person:b", target: "marriage:first", kind: "parentUnion", marriageStatus: "active" },
        { id: "first:child", source: "marriage:first", target: "person:first-child", kind: "unionChild", marriageStatus: "active" },
        { id: "second:c", source: "person:c", target: "marriage:second", kind: "parentUnion", marriageStatus: "active" },
        { id: "second:d", source: "person:d", target: "marriage:second", kind: "parentUnion", marriageStatus: "active" },
        { id: "second:child", source: "marriage:second", target: "person:second-child", kind: "unionChild", marriageStatus: "active" }
      ]
    };

    const laidOut = await layoutWithElk(crowdedTopology);
    const boxes = laidOut.nodes.map((node) => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: Number(node.style?.width),
      height: Number(node.style?.height)
    }));
    const overlaps: string[] = [];
    for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
        const left = boxes[leftIndex]!;
        const right = boxes[rightIndex]!;
        if (left.x < right.x + right.width && left.x + left.width > right.x
          && left.y < right.y + right.height && left.y + left.height > right.y) {
          overlaps.push(`${left.id} / ${right.id}`);
        }
      }
    }

    expect(overlaps).toEqual([]);
  });

  it("keeps a cousin outside another cousin's marriage corridor", async () => {
    const personNode = (index: number): TreeProjectionTopology["nodes"][number] => ({
      id: `person:p${index}`,
      kind: "person",
      personId: `p${index}`,
      display: { displayName: `人物${index}`, birthYear: null, deathYear: null, generation: null, generationMarker: null, lineageRole: "blood" }
    });
    const marriageNode = (index: number): TreeProjectionTopology["nodes"][number] => ({
      id: `marriage:u${index}`,
      kind: "union",
      unionId: `marriage:u${index}`,
      display: { kind: "marriage", marriageStatus: "active", marriageStart: null, marriageEnd: null, warnings: [] }
    });
    const childEdge = (union: number, person: number): TreeProjectionTopology["edges"][number] => ({
      id: `child:u${union}:p${person}`,
      source: `marriage:u${union}`,
      target: `person:p${person}`,
      kind: "unionChild",
      marriageStatus: "active"
    });
    const parentEdge = (person: number, union: number): TreeProjectionTopology["edges"][number] => ({
      id: `parent:p${person}:u${union}`,
      source: `person:p${person}`,
      target: `marriage:u${union}`,
      kind: "parentUnion",
      marriageStatus: "active"
    });
    const cousinTopology: TreeProjectionTopology = {
      key: "cousin-beside-marriage",
      nodes: [
        ...Array.from({ length: 25 }, (_, index) => personNode(index)),
        ...Array.from({ length: 9 }, (_, index) => marriageNode(index))
      ],
      edges: [
        childEdge(1, 6), childEdge(2, 9), childEdge(2, 22), childEdge(3, 4), childEdge(3, 18), childEdge(4, 17),
        childEdge(6, 2), childEdge(6, 19), childEdge(7, 12), childEdge(7, 13), childEdge(8, 3), childEdge(8, 7), childEdge(8, 8), childEdge(8, 14), childEdge(8, 15),
        parentEdge(0, 7), parentEdge(1, 6), parentEdge(3, 6), parentEdge(5, 1), parentEdge(6, 3), parentEdge(7, 1), parentEdge(8, 7),
        parentEdge(9, 0), parentEdge(10, 0), parentEdge(11, 5), parentEdge(13, 5), parentEdge(14, 4), parentEdge(15, 2), parentEdge(16, 2),
        parentEdge(20, 8), parentEdge(21, 8), parentEdge(23, 4), parentEdge(24, 3)
      ]
    };

    const laidOut = await layoutWithElk(cousinTopology);
    const boxes = new Map(laidOut.nodes.map((node) => [node.id, {
      x: node.position.x,
      y: node.position.y,
      width: Number(node.style?.width),
      height: Number(node.style?.height)
    }]));
    const union = boxes.get("marriage:u3")!;
    const keke = boxes.get("person:p24")!;
    const cousin = boxes.get("person:p17")!;
    const centerX = (box: { x: number; width: number }) => box.x + box.width / 2;
    const corridorLeft = Math.min(centerX(union), centerX(keke));
    const corridorRight = Math.max(centerX(union), centerX(keke));

    expect(centerX(cousin) < corridorLeft || centerX(cousin) > corridorRight).toBe(true);
    expect(union.y + union.height / 2).toBe(keke.y + keke.height / 2);
    const allBoxes = [...boxes.entries()];
    const overlaps = allBoxes.flatMap(([leftId, left], leftIndex) => allBoxes.slice(leftIndex + 1).flatMap(([rightId, right]) => (
      left.x < right.x + right.width && left.x + left.width > right.x
      && left.y < right.y + right.height && left.y + left.height > right.y
        ? [`${leftId} / ${rightId}`]
        : []
    )));
    expect(overlaps).toEqual([]);
  });

  it("keeps sibling families' children in separate horizontal intervals", async () => {
    const personNode = (index: number): TreeProjectionTopology["nodes"][number] => ({
      id: `person:p${index}`,
      kind: "person",
      personId: `p${index}`,
      display: { displayName: `人物${index}`, birthYear: null, deathYear: null, generation: null, generationMarker: null, lineageRole: null }
    });
    const unionNode = (index: number, kind: "marriage" | "coParents" = "marriage"): TreeProjectionTopology["nodes"][number] => ({
      id: `union:u${index}`,
      kind: "union",
      unionId: `union:u${index}`,
      display: { kind, marriageStatus: kind === "marriage" ? "active" : null, marriageStart: null, marriageEnd: null, warnings: [] }
    });
    const edge = (
      kind: "parentUnion" | "unionChild",
      source: string,
      target: string,
      index: number
    ): TreeProjectionTopology["edges"][number] => ({
      id: `${kind}:${index}`,
      source,
      target,
      kind,
      marriageStatus: target === "union:u10" || source === "union:u10" ? null : "active"
    });
    const childPairs = [
      [1, 0], [1, 16], [1, 17], [2, 8], [3, 12], [3, 29], [4, 6], [4, 24], [5, 23],
      [7, 3], [7, 25], [8, 18], [8, 19], [9, 5], [9, 9], [9, 10], [9, 20], [9, 21], [10, 1], [10, 11]
    ] as const;
    const parentPairs = [
      [1, 8], [2, 7], [4, 1], [5, 7], [7, 2], [8, 4], [9, 2], [10, 8], [11, 1], [12, 0],
      [13, 10], [14, 0], [15, 6], [19, 6], [20, 5], [21, 3], [22, 3], [26, 9], [27, 9], [28, 10], [30, 5], [31, 4]
    ] as const;
    let edgeIndex = 0;
    const interleavedTopology: TreeProjectionTopology = {
      key: "sibling-family-child-intervals",
      nodes: [
        ...Array.from({ length: 32 }, (_, index) => personNode(index)),
        ...Array.from({ length: 11 }, (_, index) => unionNode(index, index === 10 ? "coParents" : "marriage"))
      ],
      edges: [
        ...childPairs.map(([union, person]) => edge("unionChild", `union:u${union}`, `person:p${person}`, edgeIndex++)),
        ...parentPairs.map(([person, union]) => edge("parentUnion", `person:p${person}`, `union:u${union}`, edgeIndex++))
      ]
    };

    const laidOut = await layoutWithElk(interleavedTopology);
    const centerX = (id: string): number => {
      const node = laidOut.nodes.find((candidate) => candidate.id === id)!;
      return node.position.x + Number(node.style?.width) / 2;
    };
    const interval = (ids: string[]): [number, number] => {
      const centers = ids.map(centerX);
      return [Math.min(...centers), Math.max(...centers)];
    };
    const firstFamily = interval(["person:p0", "person:p16", "person:p17"]);
    const secondFamily = interval(["person:p18", "person:p19"]);

    expect(firstFamily[1] < secondFamily[0] || secondFamily[1] < firstFamily[0]).toBe(true);
  });
});

describe("FamilyTreeCanvas", () => {
  const label = (
    formalTerm: string,
    regionalTerm: string | null = null,
    pathDescription = formalTerm
  ): KinshipDisplayLabelDto => ({
    formalTerm,
    regionalTerm,
    displayTerm: regionalTerm ?? formalTerm,
    pathDescription,
    formalRuleId: "test-rule",
    locale: "zh-CN-henan-gongyi",
    regionalRuleVersion: "zh-CN-henan-gongyi-v1"
  });
  const projection = (viewpointId: string, relationship: KinshipDisplayLabelDto): TreeProjection => ({
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
    labels: { "parent-a": relationship, "parent-b": label("母亲"), child: label("本人") }
  });

  it("renders high-contrast person cards and an ended marriage without duplicating people", async () => {
    render(<FamilyTreeCanvas projection={projection("child", label("父亲"))} ageLabels={{ "parent-a": "约 66 岁" }} />);

    const parentCard = await screen.findByRole("group", { name: "人物：甲" });
    expect(screen.getAllByText("甲")).toHaveLength(1);
    expect(parentCard).toHaveStyle({ backgroundColor: "#ffffff", color: "#0f172a" });
    expect(screen.getByText("甲")).toHaveStyle({ fontSize: "15px" });
    expect(screen.getByText("父亲")).toBeVisible();
    expect(parentCard).toHaveTextContent("本层子女");
    expect(screen.getByRole("group", { name: "人物：乙" })).toHaveTextContent("配偶");
    expect(parentCard).toHaveTextContent("第 1 代（系统推导）");
    expect(parentCard).toHaveTextContent("1960– · 约 66 岁");
    expect(screen.getByRole("group", { name: "家庭联合：已结束婚姻" })).toHaveClass("family-union-node", "ended");
    expect(screen.getByText("已结束婚姻")).toBeVisible();
    expect(screen.getByText("开始：公历 1980年1月")).toBeVisible();
    expect(screen.getByText("结束：农历 1990年闰2月3日")).toBeVisible();
  });

  it("shows an accessible gender treatment on every person card", async () => {
    const base = projection("child", label("父亲"));
    const gendered: TreeProjection = {
      ...base,
      topology: {
        ...base.topology,
        nodes: base.topology.nodes.map((node) => node.kind !== "person" ? node : ({
          ...node,
          display: {
            ...node.display,
            gender: node.personId === "parent-a" ? "male" : node.personId === "parent-b" ? "female" : "unknown"
          }
        }))
      } as TreeProjectionTopology
    };

    render(<FamilyTreeCanvas projection={gendered} />);

    const male = await screen.findByRole("group", { name: "人物：甲" });
    const female = screen.getByRole("group", { name: "人物：乙" });
    const unknown = screen.getByRole("group", { name: "人物：孩子" });
    expect(male).toHaveClass("gender-male");
    expect(female).toHaveClass("gender-female");
    expect(unknown).toHaveClass("gender-unknown");
    expect(within(male).getByText("男")).toBeVisible();
    expect(within(female).getByText("女")).toBeVisible();
    expect(within(unknown).getByText("未知")).toBeVisible();
  });

  it("shows the regional term and a formal secondary line without exposing the path on cards", async () => {
    render(<FamilyTreeCanvas projection={projection("child", label("姨祖母", "姨奶奶", "祖母的姐姐"))} />);

    const regionalCard = await screen.findByRole("group", { name: "人物：甲" });
    expect(regionalCard).toHaveTextContent("姨奶奶");
    expect(regionalCard).toHaveTextContent("正式关系：姨祖母");
    expect(regionalCard).not.toHaveTextContent("祖母的姐姐");
    const formalOnlyCard = screen.getByRole("group", { name: "人物：乙" });
    expect(within(formalOnlyCard).getAllByText("母亲")).toHaveLength(1);
    expect(formalOnlyCard).not.toHaveTextContent("正式关系");
  });

  it("updates viewpoint-only labels without running ELK again for the same topology", async () => {
    const stableTopology = topology;
    const first: TreeProjection = { topology: stableTopology, viewpointId: "child", labels: { "parent-a": label("父亲") } };
    const second: TreeProjection = { topology: stableTopology, viewpointId: "parent-b", labels: { "parent-a": label("配偶") } };
    const layout = vi.fn(layoutWithElk);
    const { rerender } = render(<FamilyTreeCanvas projection={first} layout={layout} />);

    expect(await screen.findByText("父亲")).toBeVisible();
    await waitFor(() => expect(layout).toHaveBeenCalledTimes(1));
    rerender(<FamilyTreeCanvas projection={second} layout={layout} />);

    expect(await screen.findByRole("group", { name: "人物：甲" })).toHaveTextContent("配偶");
    expect(layout).toHaveBeenCalledTimes(1);
  });

  it("reports explicit person, marriage and parent-child selections", async () => {
    const onSelectionChange = vi.fn();
    render(<FamilyTreeCanvas projection={projection("child", label("父亲"))} onSelectionChange={onSelectionChange} />);

    fireEvent.click(await screen.findByTestId("flow-node:person:parent-a"));
    expect(onSelectionChange).toHaveBeenLastCalledWith({ kind: "person", personId: "parent-a" });

    fireEvent.click(screen.getByTestId("flow-node:marriage:one"));
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      kind: "marriage",
      unionId: "marriage:one",
      marriageId: "one",
      parentIds: ["parent-a", "parent-b"]
    });

    fireEvent.click(screen.getByRole("button", { name: "关系线：parent:a" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      kind: "marriage",
      unionId: "marriage:one",
      marriageId: "one",
      parentIds: ["parent-a", "parent-b"]
    });

    fireEvent.click(screen.getByRole("button", { name: "关系线：child:one" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      kind: "parentChild",
      unionId: "marriage:one",
      parentIds: ["parent-a", "parent-b"],
      childId: "child",
      marriageId: "one"
    });

    fireEvent.click(screen.getByRole("button", { name: "画布空白" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
  });

  it("activates a focused person node with the keyboard and reflects controlled selection", async () => {
    const onSelectionChange = vi.fn();
    const selected = { kind: "person" as const, personId: "parent-a" };
    render(<FamilyTreeCanvas projection={projection("child", label("父亲"))} selection={selected} onSelectionChange={onSelectionChange} />);

    const flowNode = await screen.findByTestId("flow-node:person:parent-a");
    expect(flowNode).toHaveAttribute("data-selected", "true");
    const card = screen.getByRole("group", { name: "人物：甲" });
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onSelectionChange).toHaveBeenLastCalledWith(selected);
  });

  it("shows an unresolved remarriage assignment instead of guessing", async () => {
    const unresolved: TreeProjection = {
      topology: {
        ...topology,
        nodes: topology.nodes.map((node) => node.kind === "union" ? {
          ...node,
          display: { ...node.display, kind: "unassigned", marriageStatus: null, marriageStart: null, marriageEnd: null, warnings: ["ambiguous marriage episode"] }
        } : node),
        edges: topology.edges.map((edge) => ({ ...edge, marriageStatus: null }))
      },
      viewpointId: null,
      labels: {}
    };
    render(<FamilyTreeCanvas projection={unresolved} />);

    expect(await screen.findByRole("group", { name: "家庭联合：待分配家庭" })).toHaveTextContent("子女归属待确认");
  });

  it("describes an incomplete parent record without implying marital status", async () => {
    const incomplete: TreeProjection = {
      topology: {
        key: "one-recorded-parent",
        nodes: [
          topology.nodes[0]!,
          {
            id: "single:parent-a",
            kind: "union",
            unionId: "single:parent-a",
            display: { kind: "singleParent", marriageStatus: null, marriageStart: null, marriageEnd: null, warnings: [] }
          },
          topology.nodes[3]!
        ],
        edges: [
          { id: "single:parent", source: "person:parent-a", target: "single:parent-a", kind: "parentUnion", marriageStatus: null },
          { id: "single:child", source: "single:parent-a", target: "person:child", kind: "unionChild", marriageStatus: null }
        ]
      },
      viewpointId: null,
      labels: {}
    };

    render(<FamilyTreeCanvas projection={incomplete} />);

    expect(await screen.findByRole("group", { name: "家庭联合：仅录入一位父母" })).toBeVisible();
    expect(screen.queryByText("单亲家庭")).not.toBeInTheDocument();
  });
});

describe("FamilyTreePage", () => {
  it("offers the four approved tree views while keeping viewpoint separate", async () => {
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
        marriageStart: null,
        marriageEnd: null,
        childIds: ["child"],
        warnings: []
      }]
    }, (viewpointId, targetId) => ({
      formalTerm: viewpointId === targetId ? "本人" : "亲属",
      regionalTerm: null,
      displayTerm: viewpointId === targetId ? "本人" : "亲属",
      pathDescription: viewpointId === targetId ? "本人" : "亲属",
      formalRuleId: "test-rule",
      locale: "zh-CN-henan-gongyi",
      regionalRuleVersion: "zh-CN-henan-gongyi-v1"
    }));
    const people = [
      { id: "a", displayName: "甲", aliases: [], gender: "unknown" as const, birth: null, death: null, notes: null, rowVersion: 1 },
      { id: "child", displayName: "孩子", aliases: [], gender: "unknown" as const, birth: null, death: null, notes: null, rowVersion: 1 },
      { id: "isolated", displayName: "旁支", aliases: [], gender: "unknown" as const, birth: null, death: null, notes: null, rowVersion: 1 }
    ];
    const api = { projectTree: vi.fn(async (input: { view: "full" | "lineage" | "core" | "descendants"; subjectId?: string; viewpointId?: string; collapseDepth?: number; lineageId?: string }) => {
      const unlabelled = service.full(input.collapseDepth ?? Number.POSITIVE_INFINITY);
      const projection = input.viewpointId ? service.withViewpoint(unlabelled, input.viewpointId) : unlabelled;
      return { ok: true as const, value: {
        ...projection,
        scope: {
          view: input.view,
          subjectId: input.view === "full" ? null : input.subjectId ?? null,
          lineageId: input.view === "lineage" ? input.lineageId ?? null : null,
          visiblePersonCount: 4
        }
      } };
    }) };
    window.localStorage.clear();
    render(<ViewpointProvider workspaceId="workspace" visiblePersonIds={[]} validPersonIds={people.map((person) => person.id)} fallbackViewpointId="a" query={{ calculateRelationship: vi.fn() }}>
      <FamilyTreePage api={api} people={people} lineages={[{
        id: "lineage-a",
        name: "甲支",
        founderPersonId: "a",
        description: null,
        memberCount: 1,
        rowVersion: 1,
        memberships: [{
          id: "membership-a",
          lineageId: "lineage-a",
          personId: "a",
          role: "blood",
          isPrimary: true,
          declaredGeneration: null,
          generationMarker: null,
          generation: { declared: null, computed: 1, displayed: 1, source: "computed", conflict: false },
          rowVersion: 1
        }]
      }]} />
    </ViewpointProvider>);

    expect(screen.getByRole("button", { name: "全谱" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("group", { name: "人物：旁支" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("围绕谁查看"), { target: { value: "child" } });
    fireEvent.click(screen.getByRole("button", { name: "核心亲属" }));
    await waitFor(() => expect(api.projectTree).toHaveBeenLastCalledWith(expect.objectContaining({ view: "core", subjectId: "child" })));
    expect(screen.getByRole("button", { name: "核心亲属" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("当前视角"), { target: { value: "child" } });
    expect(await screen.findByText("本人")).toBeVisible();

    for (const view of ["本家支系", "子孙后代", "全谱"]) {
      fireEvent.click(screen.getByRole("button", { name: view }));
      expect(screen.getByRole("button", { name: view })).toHaveAttribute("aria-pressed", "true");
    }
  });
});
