// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProvider, useWorkspace } from "../../../src/renderer/src/app/WorkspaceContext";
import type { AppResult, DesktopApi, WorkspaceSummary } from "../../../src/shared/contracts";

const workspaceA: WorkspaceSummary = {
  id: "11111111-1111-4111-8111-111111111111", name: "甲谱", directory: "opaque-a",
  originPersonId: null, lastOpenedAt: null, schemaVersion: 4
};
const workspaceB: WorkspaceSummary = {
  id: "22222222-2222-4222-8222-222222222222", name: "乙谱", directory: "opaque-b",
  originPersonId: null, lastOpenedAt: null, schemaVersion: 4
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function Harness(): React.JSX.Element {
  const state = useWorkspace();
  return <>
    <output aria-label="loading">{state.loading ? "loading" : "idle"}</output>
    <output aria-label="switching">{state.switching ? "switching" : "idle"}</output>
    <output aria-label="active">{state.activeWorkspace?.id ?? "none"}</output>
    <output aria-label="workspaces">{state.workspaces.map((workspace) => workspace.id).join(",")}</output>
    <button onClick={() => void state.createWorkspace("甲谱")}>create</button>
    <button onClick={() => void state.openWorkspace(workspaceB.id)}>open-b</button>
  </>;
}

function installApi(overrides: Partial<DesktopApi["workspaces"]>): DesktopApi["workspaces"] {
  const workspaces = {
    list: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    create: vi.fn().mockResolvedValue({ ok: true, value: workspaceA }),
    open: vi.fn(async ({ id }: { id: string }) => ({ ok: true as const, value: id === workspaceB.id ? workspaceB : workspaceA })),
    close: vi.fn().mockResolvedValue({ ok: true, value: null }),
    ...overrides
  } as DesktopApi["workspaces"];
  window.desktopApi = { workspaces } as DesktopApi;
  return workspaces;
}

beforeEach(() => { (globalThis as typeof globalThis & { React: typeof React }).React = React; });
afterEach(cleanup);

describe("WorkspaceContext request ownership", () => {
  it("settles loading and preserves a created workspace when the initial list resolves last", async () => {
    const listing = deferred<AppResult<WorkspaceSummary[]>>();
    installApi({ list: vi.fn(() => listing.promise) });
    render(<WorkspaceProvider><Harness /></WorkspaceProvider>);

    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await waitFor(() => expect(screen.getByLabelText("active")).toHaveTextContent(workspaceA.id));
    await act(async () => { listing.resolve({ ok: true, value: [] }); await listing.promise; });

    await waitFor(() => expect(screen.getByLabelText("loading")).toHaveTextContent("idle"));
    expect(screen.getByLabelText("active")).toHaveTextContent(workspaceA.id);
    expect(screen.getByLabelText("workspaces")).toHaveTextContent(workspaceA.id);
  });

  it("does not let an earlier create completion override a later explicit open", async () => {
    const creating = deferred<AppResult<WorkspaceSummary>>();
    const api = installApi({
      list: vi.fn().mockResolvedValue({ ok: true, value: [workspaceB] }),
      create: vi.fn(() => creating.promise)
    });
    render(<WorkspaceProvider><Harness /></WorkspaceProvider>);
    await waitFor(() => expect(screen.getByLabelText("loading")).toHaveTextContent("idle"));

    fireEvent.click(screen.getByRole("button", { name: "create" }));
    fireEvent.click(screen.getByRole("button", { name: "open-b" }));
    await waitFor(() => expect(screen.getByLabelText("active")).toHaveTextContent(workspaceB.id));
    await act(async () => { creating.resolve({ ok: true, value: workspaceA }); await creating.promise; });

    await waitFor(() => expect(screen.getByLabelText("switching")).toHaveTextContent("idle"));
    expect(screen.getByLabelText("active")).toHaveTextContent(workspaceB.id);
    expect(api.open).not.toHaveBeenCalledWith({ id: workspaceA.id });
  });
});
