// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppResult, RelationshipResultDto } from "../../../src/shared/contracts";
import { ViewpointProvider, useViewpoint } from "../../../src/renderer/src/app/ViewpointContext";
import { ChatPanel, type ChatAnswer } from "../../../src/renderer/src/features/chat/ChatPanel";
import { PersonNode } from "../../../src/renderer/src/features/tree/PersonNode";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom" }
}));

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

const relationshipResult = (primaryTerm: string | null): AppResult<RelationshipResultDto> => ({
  ok: true,
  value: {
    primaryTerm,
    reverseTerm: null,
    description: "关系路径",
    ruleVersion: "test",
    signature: {
      steps: [], generationDelta: 0, lineageSide: "self", bloodAffinity: "blood",
      viewpointGender: "unknown", targetGender: "unknown", relativeAgeOrder: "unknown",
      pathPersonIds: [], pathRelationIds: []
    },
    alternatives: [],
    uncertainty: []
  }
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function LabelsHarness({ personIds }: { personIds: string[] }): React.JSX.Element {
  const viewpoint = useViewpoint();
  return <>{personIds.map((personId) => <span data-testid={`label-${personId}`} key={personId}>{viewpoint.relationshipLabels[personId] ?? "none"}</span>)}</>;
}

function ViewpointHarness(): React.JSX.Element {
  const viewpoint = useViewpoint();
  return (
    <div>
      <span data-testid="viewpoint">{viewpoint.viewpointId ?? "none"}</span>
      <span data-testid="target-label">{viewpoint.relationshipLabels.target ?? "none"}</span>
      <button type="button" onClick={() => viewpoint.setViewpointId("child")}>切换视角</button>
    </div>
  );
}

describe("ViewpointProvider", () => {
  it("restores and persists a viewpoint per workspace and only calls read-only relationship queries", async () => {
    window.localStorage.setItem("family-agent:viewpoint:workspace-a", "parent");
    window.localStorage.setItem("family-agent:viewpoint:workspace-b", "other-workspace-person");
    const calculateRelationship = vi.fn(async ({ viewpointId, targetId }: { viewpointId: string; targetId: string }) => ({
      ok: true as const,
      value: {
        primaryTerm: `${viewpointId}->${targetId}`,
        reverseTerm: `${targetId}->${viewpointId}`,
        description: "关系路径",
        ruleVersion: "test",
        signature: {
          steps: [], generationDelta: 0, lineageSide: "self" as const, bloodAffinity: "blood" as const,
          viewpointGender: "unknown" as const, targetGender: "unknown" as const, relativeAgeOrder: "unknown" as const,
          pathPersonIds: [viewpointId, targetId], pathRelationIds: []
        },
        alternatives: [],
        uncertainty: []
      }
    }));
    const mutation = vi.fn();
    const api = { calculateRelationship, saveFact: mutation };

    render(
      <ViewpointProvider workspaceId="workspace-a" visiblePersonIds={["target"]} query={api}>
        <ViewpointHarness />
      </ViewpointProvider>
    );

    expect(screen.getByTestId("viewpoint")).toHaveTextContent("parent");
    expect(await screen.findByText("parent->target")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "切换视角" }));

    await waitFor(() => expect(screen.getByTestId("target-label")).toHaveTextContent("child->target"));
    expect(window.localStorage.getItem("family-agent:viewpoint:workspace-a")).toBe("child");
    expect(window.localStorage.getItem("family-agent:viewpoint:workspace-b")).toBe("other-workspace-person");
    expect(calculateRelationship).toHaveBeenCalledWith({ viewpointId: "child", targetId: "target" });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("clears a stale projected label when the active viewpoint has no relationship term", async () => {
    const query = {
      calculateRelationship: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          primaryTerm: null,
          reverseTerm: null,
          description: "未找到关系",
          ruleVersion: "test",
          signature: {
            steps: [], generationDelta: 0, lineageSide: "unknown", bloodAffinity: "blood",
            viewpointGender: "unknown", targetGender: "unknown", relativeAgeOrder: "unknown",
            pathPersonIds: ["viewpoint"], pathRelationIds: []
          },
          alternatives: [], uncertainty: ["未找到可用关系路径"]
        }
      })
    };
    const props = {
      id: "person:target",
      data: {
        node: {
          id: "person:target",
          kind: "person",
          personId: "target",
          display: { displayName: "目标", birthYear: null, deathYear: null, generation: null }
        },
        relationshipLabel: "旧称谓"
      }
    };

    render(
      <ViewpointProvider workspaceId="workspace-a" visiblePersonIds={["target"]} query={query}>
        {React.createElement(PersonNode, props as never)}
        <ViewpointHarness />
      </ViewpointProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "切换视角" }));

    await waitFor(() => expect(query.calculateRelationship).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("旧称谓")).not.toBeInTheDocument());
  });

  it("clears labels immediately and ignores an older viewpoint response", async () => {
    window.localStorage.setItem("family-agent:viewpoint:workspace-a", "parent");
    const pending = new Map<string, ReturnType<typeof deferred<AppResult<RelationshipResultDto>>>>();
    const query = {
      calculateRelationship: vi.fn(({ viewpointId }: { viewpointId: string; targetId: string }) => {
        const request = deferred<AppResult<RelationshipResultDto>>();
        pending.set(viewpointId, request);
        return request.promise;
      })
    };

    render(
      <ViewpointProvider workspaceId="workspace-a" visiblePersonIds={["target"]} query={query}>
        <ViewpointHarness />
      </ViewpointProvider>
    );
    await waitFor(() => expect(pending.has("parent")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "切换视角" }));
    expect(screen.getByTestId("target-label")).toHaveTextContent("none");
    await waitFor(() => expect(pending.has("child")).toBe(true));

    pending.get("child")!.resolve(relationshipResult("child->target"));
    await waitFor(() => expect(screen.getByTestId("target-label")).toHaveTextContent("child->target"));
    pending.get("parent")!.resolve(relationshipResult("parent->target"));
    await waitFor(() => expect(screen.getByTestId("target-label")).toHaveTextContent("child->target"));
  });

  it("keeps successful target labels when another target query rejects", async () => {
    window.localStorage.setItem("family-agent:viewpoint:workspace-a", "parent");
    const query = {
      calculateRelationship: vi.fn(async ({ targetId }: { viewpointId: string; targetId: string }) => {
        if (targetId === "bad") throw new Error("query unavailable");
        return relationshipResult("good->target");
      })
    };

    render(
      <ViewpointProvider workspaceId="workspace-a" visiblePersonIds={["bad", "good"]} query={query}>
        <LabelsHarness personIds={["bad", "good"]} />
      </ViewpointProvider>
    );

    await waitFor(() => expect(screen.getByTestId("label-good")).toHaveTextContent("good->target"));
    expect(screen.getByTestId("label-bad")).toHaveTextContent("none");
  });

  it("clears labels when visible people change and ignores the old batch", async () => {
    window.localStorage.setItem("family-agent:viewpoint:workspace-a", "parent");
    const pending = new Map<string, ReturnType<typeof deferred<AppResult<RelationshipResultDto>>>>();
    const query = {
      calculateRelationship: vi.fn(({ targetId }: { viewpointId: string; targetId: string }) => {
        const request = deferred<AppResult<RelationshipResultDto>>();
        pending.set(targetId, request);
        return request.promise;
      })
    };

    const rendered = render(
      <ViewpointProvider workspaceId="workspace-a" visiblePersonIds={["old"]} query={query}>
        <LabelsHarness personIds={["old", "new"]} />
      </ViewpointProvider>
    );
    await waitFor(() => expect(pending.has("old")).toBe(true));
    pending.get("old")!.resolve(relationshipResult("old-label"));
    await waitFor(() => expect(screen.getByTestId("label-old")).toHaveTextContent("old-label"));

    rendered.rerender(
      <ViewpointProvider workspaceId="workspace-a" visiblePersonIds={["new"]} query={query}>
        <LabelsHarness personIds={["old", "new"]} />
      </ViewpointProvider>
    );
    expect(screen.getByTestId("label-old")).toHaveTextContent("none");
    await waitFor(() => expect(pending.has("new")).toBe(true));
    pending.get("new")!.resolve(relationshipResult("new-label"));
    await waitFor(() => expect(screen.getByTestId("label-new")).toHaveTextContent("new-label"));
  });

  it("invalidates old labels when the workspace changes", async () => {
    window.localStorage.setItem("family-agent:viewpoint:workspace-a", "parent");
    window.localStorage.setItem("family-agent:viewpoint:workspace-b", "other");
    const pending = new Map<string, ReturnType<typeof deferred<AppResult<RelationshipResultDto>>>>();
    const query = {
      calculateRelationship: vi.fn(({ viewpointId }: { viewpointId: string; targetId: string }) => {
        const request = deferred<AppResult<RelationshipResultDto>>();
        pending.set(viewpointId, request);
        return request.promise;
      })
    };

    const rendered = render(
      <ViewpointProvider workspaceId="workspace-a" visiblePersonIds={["target"]} query={query}>
        <LabelsHarness personIds={["target"]} />
      </ViewpointProvider>
    );
    await waitFor(() => expect(pending.has("parent")).toBe(true));
    pending.get("parent")!.resolve(relationshipResult("parent-label"));
    await waitFor(() => expect(screen.getByTestId("label-target")).toHaveTextContent("parent-label"));

    rendered.rerender(
      <ViewpointProvider workspaceId="workspace-b" visiblePersonIds={["target"]} query={query}>
        <LabelsHarness personIds={["target"]} />
      </ViewpointProvider>
    );
    expect(screen.getByTestId("label-target")).toHaveTextContent("none");
    await waitFor(() => expect(pending.has("other")).toBe(true));
    pending.get("other")!.resolve(relationshipResult("other-label"));
    await waitFor(() => expect(screen.getByTestId("label-target")).toHaveTextContent("other-label"));
  });
});

describe("ChatPanel", () => {
  it("offers the four structured question classes and renders evidence", () => {
    const answer: ChatAnswer = {
      conclusion: "张敏有两个孩子。",
      matchedPeople: [
        { id: "person-1", displayName: "张敏", hint: "1988 年生" },
        { id: "person-2", displayName: "张敏", hint: "1990 年生" }
      ],
      sources: [{ id: "source-1", title: "族谱手录" }],
      relationshipPath: ["张国强", "张敏"]
    };
    const onQuickAction = vi.fn();

    render(<ChatPanel answer={answer} onQuickAction={onQuickAction} />);

    for (const label of ["人物属性", "成员统计", "关系查询", "支系世代"]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }
    fireEvent.click(screen.getByRole("button", { name: "关系查询" }));
    expect(onQuickAction).toHaveBeenCalledWith("relationship");
    expect(screen.getByText("张敏有两个孩子。")).toBeVisible();
    expect(screen.getAllByText("张敏")).toHaveLength(2);
    expect(screen.getByText("族谱手录")).toBeVisible();
    expect(screen.getByText("张国强 → 张敏")).toBeVisible();
  });
});
