// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FamilyAgentApi, PersonDetailReadModel, PersonListItem, TreeProjectionDto, TreeViewDto, WorkspaceLineageReadModel } from "../../../src/shared/contracts";
import { TreeProjectionService } from "../../../src/main/domain/projection/tree-projection-service";
import { ViewpointProvider } from "../../../src/renderer/src/app/ViewpointContext";
import { FamilyTreePage, normalizeTreeSelection } from "../../../src/renderer/src/features/tree/FamilyTreePage";

vi.mock("@xyflow/react", async () => {
  const ReactModule = await import("react");
  return {
    ReactFlow: ({ nodes, edges, nodeTypes, onNodeClick, onEdgeClick, onPaneClick }: {
      nodes: Array<{ id: string; type: string; data: unknown; selected?: boolean }>;
      edges: Array<{ id: string; data?: unknown; selected?: boolean }>;
      nodeTypes: Record<string, React.ComponentType<{ id: string; data: unknown; selected?: boolean }>>;
      onNodeClick?(event: React.MouseEvent, node: unknown): void;
      onEdgeClick?(event: React.MouseEvent, edge: unknown): void;
      onPaneClick?(): void;
    }) => ReactModule.createElement("div", { "aria-label": "家谱图" },
      ...nodes.map((node) => ReactModule.createElement("div", {
        key: node.id,
        "data-testid": `flow-node:${node.id}`,
        onClick: (event: React.MouseEvent) => onNodeClick?.(event, node)
      }, ReactModule.createElement(nodeTypes[node.type], { id: node.id, data: node.data, selected: node.selected }))),
      ...edges.map((edge) => ReactModule.createElement("button", {
        key: edge.id,
        type: "button",
        "aria-label": `关系线：${edge.id}`,
        onClick: (event: React.MouseEvent) => onEdgeClick?.(event, edge)
      })),
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

const emptyGeneration = {
  declared: null,
  computed: null,
  displayed: null,
  source: "none" as const,
  conflict: false
};

const lineage = (
  id: string,
  name: string,
  memberships: Array<{ personId: string; isPrimary: boolean; role?: "blood" | "married_in" | "associated" }>
): WorkspaceLineageReadModel => ({
  id,
  name,
  founderPersonId: memberships[0]?.personId ?? "founder",
  description: null,
  memberCount: memberships.length,
  rowVersion: 1,
  memberships: memberships.map((membership, index) => ({
    id: `${id}-member-${index}`,
    lineageId: id,
    personId: membership.personId,
    role: membership.role ?? "blood",
    isPrimary: membership.isPrimary,
    declaredGeneration: null,
    generationMarker: null,
    generation: emptyGeneration,
    rowVersion: 1
  }))
});

const projectionFor = (
  view: TreeViewDto,
  ids: string[],
  names: Readonly<Record<string, string>>,
  options: { subjectId?: string; lineageId?: string; count?: number; viewpointId?: string } = {}
): TreeProjectionDto => ({
  viewpointId: options.viewpointId ?? null,
  labels: {},
  scope: {
    view,
    subjectId: view === "full" ? null : options.subjectId ?? null,
    lineageId: view === "lineage" ? options.lineageId ?? null : null,
    visiblePersonCount: options.count ?? ids.length
  },
  topology: {
    key: `${view}:${options.subjectId ?? "all"}:${options.lineageId ?? "none"}`,
    nodes: ids.map((id) => ({
      id: `person:${id}`,
      kind: "person" as const,
      personId: id,
      display: {
        displayName: names[id] ?? id,
        birthYear: null,
        deathYear: null,
        generation: null,
        generationMarker: null,
        lineageRole: null
      }
    })),
    edges: []
  }
});

describe("FamilyTreePage context drawer", () => {
  it("normalizes relationship selections against the latest tree projection", () => {
    const projection: TreeProjectionDto = {
      viewpointId: null,
      labels: {},
      scope: { view: "full", subjectId: null, lineageId: null, visiblePersonCount: 1 },
      topology: {
        key: "updated",
        nodes: [
          { id: "person:a", kind: "person", personId: "a", display: { displayName: "甲", birthYear: null, deathYear: null, generation: null, generationMarker: null, lineageRole: null } },
          { id: "union:m", kind: "union", unionId: "m", parentIds: ["a", "c"], childIds: ["child"], marriageId: "m", display: { kind: "marriage", marriageStatus: "active", marriageStart: null, marriageEnd: null, warnings: [] } }
        ],
        edges: [{ id: "m-child", source: "union:m", target: "person:child", kind: "unionChild", unionId: "m", parentIds: ["a", "c"], childId: "child", marriageId: "m", marriageStatus: "active" }]
      }
    };

    expect(normalizeTreeSelection({ kind: "marriage", unionId: "m", marriageId: "m", parentIds: ["a", "b"] }, projection)).toEqual({
      kind: "marriage", unionId: "m", marriageId: "m", parentIds: ["a", "c"]
    });
    expect(normalizeTreeSelection({ kind: "parentChild", unionId: "m", marriageId: "m", parentIds: ["a", "b"], childId: "child" }, projection)).toEqual({
      kind: "parentChild", unionId: "m", marriageId: "m", parentIds: ["a", "c"], childId: "child"
    });
    expect(normalizeTreeSelection({ kind: "person", personId: "a" }, projection)).toEqual({ kind: "person", personId: "a" });
    expect(normalizeTreeSelection({ kind: "person", personId: "removed" }, projection)).toBeNull();
    expect(normalizeTreeSelection({ kind: "marriage", unionId: "deleted", marriageId: "deleted", parentIds: ["a", "b"] }, projection)).toBeNull();
  });

  it("opens a real person detail, supports editing and quick relative creation, refreshes, and closes with Escape", async () => {
    const people = [person("a", "甲"), person("b", "乙")];
    let currentDetail: PersonDetailReadModel = { person: people[0]!, aliases: [], parents: [], children: [], marriages: [] };
    const baseProjection = new TreeProjectionService({
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
    }).full(Number.POSITIVE_INFINITY);
    const projection: TreeProjectionDto = {
      ...baseProjection,
      scope: { view: "full", subjectId: null, lineageId: null, visiblePersonCount: people.length }
    };
    const projectTree = vi.fn().mockResolvedValue({ ok: true, value: projection });
    const onDataChanged = vi.fn();
    const apiTarget = {
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
    const api = new Proxy(apiTarget, { has: () => false });

    render(
      <ViewpointProvider workspaceId="workspace" visiblePersonIds={[]} validPersonIds={people.map(({ id }) => id)} fallbackViewpointId="a" query={api.query}>
        <FamilyTreePage api={api} people={people} lineages={[]} onDataChanged={onDataChanged} />
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

  it("edits a selected marriage and opens the child-centered editor from a parent-child edge", async () => {
    const people = [person("a", "甲"), person("b", "乙"), person("c", "丙"), person("child", "孩子")];
    const detailA: PersonDetailReadModel = {
      person: people[0]!, aliases: [], parents: [], children: [],
      marriages: [{ id: "m", spouse: people[1]!, status: "active", start: null, end: null, rowVersion: 3 }]
    };
    const detailChild: PersonDetailReadModel = {
      person: people[3]!, aliases: [], children: [], marriages: [],
      parents: [
        { relationId: "pc-a", person: people[0]!, role: "father", rowVersion: 1, originKind: "explicit", inferredFromMarriageId: null },
        { relationId: "pc-b", person: people[1]!, role: "mother", rowVersion: 1, originKind: "spouse_default", inferredFromMarriageId: "m" }
      ]
    };
    const projection: TreeProjectionDto = {
      viewpointId: "a",
      labels: {},
      scope: { view: "full", subjectId: null, lineageId: null, visiblePersonCount: people.length },
      topology: {
        key: "tree",
        nodes: [
          ...people.map((entry) => ({ id: `person:${entry.id}`, kind: "person" as const, personId: entry.id, display: { displayName: entry.displayName, birthYear: null, deathYear: null, generation: null, generationMarker: null, lineageRole: null } })),
          { id: "union:m", kind: "union", unionId: "m", parentIds: ["a", "b"], childIds: ["child"], marriageId: "m", display: { kind: "marriage", marriageStatus: "active", marriageStart: null, marriageEnd: null, warnings: [] } }
        ],
        edges: [
          { id: "a-m", source: "person:a", target: "union:m", kind: "parentUnion", unionId: "m", parentIds: ["a", "b"], childId: null, marriageId: "m", marriageStatus: "active" },
          { id: "m-child", source: "union:m", target: "person:child", kind: "unionChild", unionId: "m", parentIds: ["a", "b"], childId: "child", marriageId: "m", marriageStatus: "active" }
        ]
      }
    };
    const stage = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        id: "draft", workspaceId: "workspace", version: 1, expiresAt: "2099-01-01T00:00:00.000Z", expectedVersions: { m: 3 }, canConfirm: true, issues: [],
        changes: [{ id: "change", disposition: "update", entityType: "marriage", entityId: "m", summary: "更正甲与乙的婚姻", fieldChanges: [], originKind: "explicit", selectedByDefault: true, dependsOnChangeIds: [] }]
      }
    });
    const confirm = vi.fn().mockResolvedValue({ ok: true, value: { draftId: "draft", operationGroupId: "operation", changedEntityIds: ["m"] } });
    const projectTree = vi.fn().mockResolvedValue({ ok: true, value: projection });
    const onDataChanged = vi.fn();
    const api = {
      projectTree,
      query: { projectTree, calculateRelationship: vi.fn() },
      people: {
        list: vi.fn().mockResolvedValue({ ok: true, value: people }),
        get: vi.fn(async ({ personId }: { personId: string }) => ({ ok: true as const, value: personId === "child" ? detailChild : detailA })),
        save: vi.fn(), update: vi.fn(),
        getChildrenCountStatus: vi.fn().mockResolvedValue({ ok: true, value: { count: 0, completeness: "partial" } })
      },
      relations: { planParentCompletion: vi.fn().mockResolvedValue({ ok: false, error: { message: "not used" } }) },
      media: { listForPerson: vi.fn().mockResolvedValue({ ok: true, value: [] }) },
      mutations: { stage, confirm, revise: vi.fn() }
    } as unknown as FamilyAgentApi & { projectTree: typeof projectTree };

    render(
      <ViewpointProvider workspaceId="workspace" visiblePersonIds={[]} validPersonIds={people.map(({ id }) => id)} fallbackViewpointId="a" query={api.query}>
        <FamilyTreePage api={api} people={people} lineages={[]} onDataChanged={onDataChanged} />
      </ViewpointProvider>
    );

    fireEvent.click(await screen.findByTestId("flow-node:union:m"));
    expect(await screen.findByRole("heading", { name: "婚姻关系" })).toBeVisible();
    expect(screen.getByText("甲 与 乙")).toBeVisible();
    fireEvent.change(screen.getByLabelText("配偶二"), { target: { value: "c" } });
    fireEvent.click(screen.getByRole("button", { name: "预览婚姻更正" }));
    await waitFor(() => expect(stage).toHaveBeenCalledWith({ intents: [expect.objectContaining({
      type: "marriage.correct",
      marriageId: "m",
      replacement: expect.objectContaining({ spouseAId: "a", spouseBId: "c" })
    })] }));
    fireEvent.click(await screen.findByRole("button", { name: "确认写入" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(onDataChanged).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "关系线：m-child" }));
    expect(await screen.findByRole("heading", { name: "亲子关系" })).toBeVisible();
    expect(screen.getByText("当前孩子：孩子")).toBeVisible();
    expect(await screen.findByRole("button", { name: "移除父亲 甲" })).toBeVisible();
    expect(screen.getByRole("button", { name: "移除母亲 乙" })).toBeVisible();
  });
});

describe("FamilyTreePage scope controls", () => {
  const people = [person("subject", "闫明"), person("viewpoint", "淼淼")];
  const names = Object.fromEntries(people.map(({ id, displayName }) => [id, displayName]));

  const renderPage = (
    projectTree: ReturnType<typeof vi.fn>,
    options: {
      people?: PersonListItem[];
      lineages?: WorkspaceLineageReadModel[];
      onOpenLineageSettings?(): void;
    } = {}
  ) => render(
    <ViewpointProvider
      workspaceId="scope-workspace"
      visiblePersonIds={[]}
      validPersonIds={(options.people ?? people).map(({ id }) => id)}
      fallbackViewpointId={(options.people ?? people).find(({ id }) => id === "viewpoint")?.id ?? null}
      query={{ calculateRelationship: vi.fn() }}
    >
      <FamilyTreePage
        api={{ projectTree }}
        people={options.people ?? people}
        lineages={options.lineages ?? []}
        onOpenLineageSettings={options.onOpenLineageSettings}
      />
    </ViewpointProvider>
  );

  it("renders the approved tab order and keeps scope subject independent from kinship viewpoint", async () => {
    const projectTree = vi.fn(async (input: { view: TreeViewDto; subjectId?: string; viewpointId?: string; lineageId?: string }) => ({
      ok: true as const,
      value: projectionFor(input.view, [input.subjectId ?? "subject"], names, {
        subjectId: input.subjectId,
        lineageId: input.lineageId,
        viewpointId: input.viewpointId,
        count: input.view === "core" ? 12 : 2
      })
    }));
    renderPage(projectTree);

    const tabNames = within(screen.getByRole("navigation", { name: "家谱视图" }))
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(tabNames).toEqual(["全谱", "本家支系", "核心亲属", "子孙后代"]);
    await waitFor(() => expect(projectTree).toHaveBeenLastCalledWith({ view: "full", viewpointId: "viewpoint" }));

    expect(screen.getByLabelText("围绕谁查看")).toHaveValue("subject");
    fireEvent.click(screen.getByRole("button", { name: "核心亲属" }));
    await waitFor(() => expect(projectTree).toHaveBeenLastCalledWith({
      view: "core",
      subjectId: "subject",
      viewpointId: "viewpoint"
    }));
    expect(await screen.findByText("正在显示闫明的父母、祖父母、兄弟姐妹、配偶和子女，共 12 人。结果基于当前已确认关系。")).toBeVisible();

    fireEvent.change(screen.getByLabelText("当前视角"), { target: { value: "subject" } });
    await waitFor(() => expect(projectTree).toHaveBeenLastCalledWith({
      view: "core",
      subjectId: "subject",
      viewpointId: "subject"
    }));
    expect(screen.getByLabelText("围绕谁查看")).toHaveValue("subject");

    fireEvent.change(screen.getByLabelText("围绕谁查看"), { target: { value: "viewpoint" } });
    await waitFor(() => expect(projectTree).toHaveBeenLastCalledWith({
      view: "core",
      subjectId: "viewpoint",
      viewpointId: "subject"
    }));
    expect(screen.getByLabelText("当前视角")).toHaveValue("subject");
  });

  it("shows an actionable state instead of guessing when the subject has no primary lineage", async () => {
    const projectTree = vi.fn(async () => ({ ok: true as const, value: projectionFor("full", ["subject"], names) }));
    const onOpenLineageSettings = vi.fn();
    renderPage(projectTree, {
      lineages: [lineage("lineage-a", "闫氏", [{ personId: "subject", isPrimary: false }])],
      onOpenLineageSettings
    });
    await waitFor(() => expect(projectTree).toHaveBeenCalled());
    projectTree.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "本家支系" }));
    expect(await screen.findByText("尚未为 闫明 设置主要本家支系")).toBeVisible();
    expect(projectTree).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "前往设置本家支系" }));
    expect(onOpenLineageSettings).toHaveBeenCalledTimes(1);
  });

  it("defaults one primary lineage, permits another membership, and requires a choice for conflicting primaries", async () => {
    const projectTree = vi.fn(async (input: { view: TreeViewDto; subjectId?: string; viewpointId?: string; lineageId?: string }) => ({
      ok: true as const,
      value: projectionFor(input.view, [input.subjectId ?? "subject"], names, input)
    }));
    const { unmount } = renderPage(projectTree, {
      lineages: [
        lineage("lineage-a", "闫氏", [{ personId: "subject", isPrimary: true }]),
        lineage("lineage-b", "李氏", [{ personId: "subject", isPrimary: false }])
      ]
    });
    fireEvent.click(screen.getByRole("button", { name: "本家支系" }));
    await waitFor(() => expect(projectTree).toHaveBeenLastCalledWith(expect.objectContaining({
      view: "lineage",
      subjectId: "subject",
      lineageId: "lineage-a"
    })));
    expect(screen.getByLabelText("选择本家支系")).toHaveValue("lineage-a");
    fireEvent.change(screen.getByLabelText("选择本家支系"), { target: { value: "lineage-b" } });
    await waitFor(() => expect(projectTree).toHaveBeenLastCalledWith(expect.objectContaining({ lineageId: "lineage-b" })));
    unmount();

    window.localStorage.clear();
    const conflictingProjectTree = vi.fn(async (input: { view: TreeViewDto; subjectId?: string; viewpointId?: string; lineageId?: string }) => ({
      ok: true as const,
      value: projectionFor(input.view, [input.subjectId ?? "subject"], names, input)
    }));
    renderPage(conflictingProjectTree, {
      lineages: [
        lineage("lineage-a", "闫氏", [{ personId: "subject", isPrimary: true }]),
        lineage("lineage-b", "李氏", [{ personId: "subject", isPrimary: true }])
      ]
    });
    await waitFor(() => expect(conflictingProjectTree).toHaveBeenCalled());
    conflictingProjectTree.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "本家支系" }));
    expect(await screen.findByText("闫明存在多个主要本家支系，请选择一个并前往设置中修正。")).toBeVisible();
    expect(conflictingProjectTree).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("选择本家支系"), { target: { value: "lineage-b" } });
    await waitFor(() => expect(conflictingProjectTree).toHaveBeenLastCalledWith(expect.objectContaining({
      view: "lineage",
      subjectId: "subject",
      lineageId: "lineage-b"
    })));
  });

  it("guides empty workspaces without sending an invalid scoped request", async () => {
    const projectTree = vi.fn(async () => ({ ok: true as const, value: projectionFor("full", [], {}) }));
    renderPage(projectTree, { people: [] });
    await waitFor(() => expect(projectTree).toHaveBeenCalledWith({ view: "full" }));
    projectTree.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "核心亲属" }));
    expect(await screen.findByText("请先选择“围绕谁查看”")).toBeVisible();
    expect(projectTree).not.toHaveBeenCalled();
  });

  it("ignores stale responses and retries only the current valid request", async () => {
    let resolveCore: ((value: unknown) => void) | null = null;
    const corePending = new Promise((resolve) => { resolveCore = resolve; });
    const projectTree = vi.fn((input: { view: TreeViewDto; subjectId?: string; viewpointId?: string }) => {
      if (input.view === "core") return corePending;
      if (input.view === "descendants") return Promise.resolve({
        ok: true as const,
        value: projectionFor("descendants", ["viewpoint"], names, { subjectId: input.subjectId })
      });
      return Promise.resolve({ ok: true as const, value: projectionFor("full", ["subject"], names) });
    });
    renderPage(projectTree);
    await screen.findByRole("group", { name: "人物：闫明" });

    fireEvent.click(screen.getByRole("button", { name: "核心亲属" }));
    fireEvent.click(screen.getByRole("button", { name: "子孙后代" }));
    expect(await screen.findByRole("group", { name: "人物：淼淼" })).toBeVisible();
    resolveCore?.({ ok: true, value: projectionFor("core", ["subject"], names, { subjectId: "subject" }) });
    await Promise.resolve();
    expect(screen.queryByRole("group", { name: "人物：闫明" })).not.toBeInTheDocument();

    projectTree.mockImplementation(async (input: { view: TreeViewDto; subjectId?: string }) => input.view === "core"
      ? { ok: false as const, error: { code: "INTERNAL" as const, message: "范围读取失败" } }
      : { ok: true as const, value: projectionFor(input.view, ["viewpoint"], names, { subjectId: input.subjectId }) });
    fireEvent.click(screen.getByRole("button", { name: "核心亲属" }));
    expect(await screen.findByText("范围读取失败")).toBeVisible();
    const callsBeforeRetry = projectTree.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(projectTree.mock.calls.length).toBe(callsBeforeRetry + 1));
    expect(projectTree).toHaveBeenLastCalledWith(expect.objectContaining({ view: "core", subjectId: "subject" }));
  });
});
