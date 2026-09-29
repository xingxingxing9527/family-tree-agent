// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../../src/renderer/src/App";
import type { DesktopApi, WorkspaceSummary } from "../../../src/shared/contracts";

const workspaceA: WorkspaceSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "甲谱",
  directory: "opaque-a",
  originPersonId: "person-a",
  lastOpenedAt: "2026-09-15T01:00:00.000Z",
  schemaVersion: 4
};
const workspaceB: WorkspaceSummary = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "乙谱",
  directory: "opaque-b",
  originPersonId: "person-b",
  lastOpenedAt: "2026-09-14T01:00:00.000Z",
  schemaVersion: 4
};

function desktopApi(workspaces: WorkspaceSummary[]) {
  let activeId: string | null = null;
  const open = vi.fn(async ({ id }: { id: string }) => {
    const workspace = workspaces.find((entry) => entry.id === id);
    if (!workspace) return { ok: false as const, error: { code: "NOT_FOUND" as const, message: "not found" } };
    activeId = id;
    return { ok: true as const, value: workspace };
  });
  const api = {
    app: { getVersion: vi.fn().mockResolvedValue("1.0.0") },
    workspaces: {
      list: vi.fn().mockResolvedValue({ ok: true, value: workspaces }),
      create: vi.fn(), open, close: vi.fn().mockResolvedValue({ ok: true, value: null })
    },
    people: {
      list: vi.fn(async () => ({ ok: true, value: activeId === workspaceB.id
        ? [{ id: "person-b", displayName: "乙家人", aliases: [], gender: "unknown", birth: null, death: null, notes: null, rowVersion: 1 }]
        : [{ id: "person-a", displayName: "甲家人", aliases: [], gender: "unknown", birth: null, death: null, notes: null, rowVersion: 1 }] })),
      get: vi.fn(), save: vi.fn(), update: vi.fn()
    },
    relations: { addParentChild: vi.fn(), addMarriage: vi.fn(), divorce: vi.fn() },
    imports: { selectFile: vi.fn(), parse: vi.fn(), commit: vi.fn(), exportTemplate: vi.fn() },
    merges: { findDuplicateCandidates: vi.fn(), preview: vi.fn(), merge: vi.fn(), history: vi.fn().mockResolvedValue({ ok: true, value: [] }), canUnmerge: vi.fn(), unmerge: vi.fn() },
    media: { select: vi.fn(), import: vi.fn(), attach: vi.fn(), listForPerson: vi.fn() },
    wiki: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }), create: vi.fn(), update: vi.fn(), remove: vi.fn(), get: vi.fn() },
    query: {
      workspaceSnapshot: vi.fn(async () => ({ ok: true, value: { workspaceId: activeId, people: [], sources: [], lineages: [] } })),
      projectTree: vi.fn().mockResolvedValue({ ok: true, value: { topology: { key: "empty", nodes: [], edges: [] }, viewpointId: null, labels: {} } }),
      searchPeople: vi.fn().mockResolvedValue({ ok: true, value: [] }), getPerson: vi.fn(), listRelatives: vi.fn(), calculateRelationship: vi.fn(), summarizeLineage: vi.fn(), searchWiki: vi.fn()
    },
    chat: { authorize: vi.fn(), stageMutation: vi.fn(), ask: vi.fn(), confirm: vi.fn(), revise: vi.fn() },
    modelSettings: { status: vi.fn().mockResolvedValue({ ok: true, value: { configured: false } }), saveKey: vi.fn(), clearKey: vi.fn() },
    dataManagement: { listAudit: vi.fn().mockResolvedValue({ ok: true, value: [] }), undoOperationGroup: vi.fn(), createBackup: vi.fn(), listRestoreTargets: vi.fn().mockResolvedValue({ ok: true, value: workspaces }), selectRestoreFile: vi.fn(), inspectBackup: vi.fn(), restoreBackup: vi.fn(), exportWorkspace: vi.fn() }
  } as unknown as DesktopApi;
  return { api, open };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  window.localStorage.clear();
  window.location.hash = "";
});
afterEach(cleanup);

describe("complete application shell", () => {
  it("renders the six first-level areas for a validated packaged-app hash route", async () => {
    const { api } = desktopApi([workspaceA]);
    window.desktopApi = api;
    window.location.hash = `#/workspace/${workspaceA.id}/tree`;

    render(<App />);

    const navigation = await screen.findByRole("navigation", { name: "一级导航" });
    for (const label of ["首页", "家谱树", "人物库", "录入中心", "家族 Wiki", "设置与数据"]) {
      expect(navigation).toHaveTextContent(label);
    }
    expect(screen.getByText("甲谱")).toBeVisible();
  });

  it("opens the deep-linked workspace before rendering workspace-scoped data", async () => {
    const { api, open } = desktopApi([workspaceA, workspaceB]);
    window.desktopApi = api;
    window.location.hash = `#/workspace/${workspaceB.id}/people`;

    render(<App />);

    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(open.mock.calls[0]?.[0]).toEqual({ id: workspaceB.id });
    expect((await screen.findAllByText("乙谱")).some((element) => element.isConnected)).toBe(true);
    expect(screen.queryByText("甲家人")).not.toBeInTheDocument();
  });

  it("keeps a global-search person selected when navigation mounts the people area", async () => {
    const { api } = desktopApi([workspaceA]);
    const person = { id: "person-a", displayName: "甲家人", aliases: [], gender: "unknown" as const, birth: null, death: null, notes: null, rowVersion: 1 };
    vi.mocked(api.query.workspaceSnapshot).mockResolvedValue({ ok: true, value: { workspaceId: workspaceA.id, people: [person], sources: [], lineages: [] } });
    vi.mocked(api.query.searchPeople).mockResolvedValue({ ok: true, value: [{ ...person, parentHints: [] }] });
    vi.mocked(api.people.get).mockResolvedValue({ ok: true, value: { person, aliases: [], parents: [], children: [], marriages: [] } });
    vi.mocked(api.chat.authorize).mockResolvedValue({ ok: true, value: { authorizationToken: "token" } });
    vi.mocked(api.chat.ask).mockResolvedValue({ ok: true, value: { answer: "本人", matchedPersonIds: [person.id], sourceIds: [], relationship: null, toolTrace: [] } });
    window.desktopApi = api;
    window.location.hash = `#/workspace/${workspaceA.id}/tree`;
    render(<App />);

    const search = await screen.findByLabelText("搜索当前谱册人物");
    fireEvent.change(search, { target: { value: "甲家人" } });
    fireEvent.submit(search.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: /甲家人/u }));
    fireEvent.click(await screen.findByRole("button", { name: "关系查询" }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.click(await screen.findByRole("button", { name: "同意并发送" }));

    await waitFor(() => expect(api.chat.authorize).toHaveBeenCalled());
    expect(vi.mocked(api.chat.authorize).mock.calls[0]?.[0]).toMatchObject({ payload: { viewpointId: person.id, selectedPersonId: person.id } });
  });

  it("opens and navigates to a different restore target before showing its refreshed shell", async () => {
    const { api, open } = desktopApi([workspaceA, workspaceB]);
    vi.mocked(api.dataManagement.selectRestoreFile).mockResolvedValue({ ok: true, value: {
      selected: true,
      fileToken: "33333333-3333-4333-8333-333333333333",
      fileName: "other-workspace.zip"
    } });
    vi.mocked(api.dataManagement.inspectBackup).mockResolvedValue({ ok: true, value: {
      restoreToken: "44444444-4444-4444-8444-444444444444",
      targetWorkspaceId: workspaceB.id,
      verified: true,
      expiresAt: "2026-09-15T02:00:00.000Z",
      manifest: {
        formatVersion: 1,
        workspaceId: workspaceB.id,
        workspaceName: workspaceB.name,
        schemaVersion: 4,
        createdAt: "2026-09-15T01:30:00.000Z",
        counts: { people: 1, parentChild: 0, marriages: 0, wikiEntries: 0, auditRows: 1, mediaAssets: 0 }
      }
    } });
    vi.mocked(api.dataManagement.restoreBackup).mockResolvedValue({ ok: true, value: { restored: true, automaticSnapshotVerified: true, cleanupPending: false } });
    window.desktopApi = api;
    window.location.hash = `#/workspace/${workspaceA.id}/settings`;
    render(<App />);

    await screen.findByRole("heading", { name: "设置与数据" });
    fireEvent.click(screen.getByRole("button", { name: "选择备份文件" }));
    await screen.findByText("other-workspace.zip");
    fireEvent.change(screen.getByLabelText("恢复目标谱册"), { target: { value: workspaceB.id } });
    fireEvent.click(screen.getByRole("button", { name: "验证备份" }));
    await screen.findByText("验证通过");
    fireEvent.click(screen.getByLabelText("我确认用已验证备份替换乙谱"));
    fireEvent.click(screen.getByRole("button", { name: "替换目标谱册" }));

    await waitFor(() => expect(open).toHaveBeenCalledWith({ id: workspaceB.id }));
    await waitFor(() => expect(window.location.hash).toBe(`#/workspace/${workspaceB.id}/settings`));
    expect((await screen.findAllByText("乙谱")).some((element) => element.isConnected)).toBe(true);
  });
});
