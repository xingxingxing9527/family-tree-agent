// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiProvider, useApi } from "../../../src/renderer/src/app/ApiContext";
import { WorkspaceProvider } from "../../../src/renderer/src/app/WorkspaceContext";
import type { FamilyAgentApi } from "../../../src/shared/contracts";

function apiWithWorkspaceList(list: FamilyAgentApi["workspaces"]["list"]): FamilyAgentApi {
  return {
    workspaces: {
      list,
      create: vi.fn(),
      open: vi.fn(),
      close: vi.fn()
    }
  } as unknown as FamilyAgentApi;
}

function ApiProbe(): React.JSX.Element {
  const api = useApi();
  return <output aria-label="api-kind">{typeof api.workspaces.list}</output>;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  delete (window as Partial<Window>).desktopApi;
});
afterEach(cleanup);

describe("ApiContext", () => {
  it("supplies the exact API instance to renderer consumers", () => {
    const api = apiWithWorkspaceList(vi.fn());
    render(<ApiProvider api={api}><ApiProbe /></ApiProvider>);

    expect(screen.getByLabelText("api-kind")).toHaveTextContent("function");
  });

  it("uses the provider API without window.desktopApi", async () => {
    const list = vi.fn().mockResolvedValue({ ok: true, value: [] });
    const api = apiWithWorkspaceList(list);

    render(<ApiProvider api={api}><WorkspaceProvider><ApiProbe /></WorkspaceProvider></ApiProvider>);

    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    expect(window.desktopApi).toBeUndefined();
  });

  it("throws a clear error outside ApiProvider", () => {
    expect(() => render(<ApiProbe />)).toThrow("FamilyAgent API is unavailable");
  });
});
