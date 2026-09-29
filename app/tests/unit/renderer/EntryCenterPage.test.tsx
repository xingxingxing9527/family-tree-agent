// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryCenterPage } from "../../../src/renderer/src/features/import/EntryCenterPage";

afterEach(cleanup);

describe("EntryCenterPage", () => {
  it("turns a rejected online authorization into a sanitized recoverable state", async () => {
    const api = { chat: {
      authorize: vi.fn().mockRejectedValue(new Error("C:\\private\\family.sqlite 张敏")),
      stageMutation: vi.fn(), confirm: vi.fn()
    } } as never;
    render(<MemoryRouter><EntryCenterPage workspaceId="workspace" api={api} people={[]} onChanged={vi.fn()} /></MemoryRouter>);

    fireEvent.click(screen.getByRole("button", { name: "对话录入" }));
    fireEvent.change(screen.getByLabelText("家族资料描述"), { target: { value: "张敏是家中长女" } });
    fireEvent.click(screen.getByRole("button", { name: "生成变更草稿" }));
    fireEvent.click(screen.getByRole("button", { name: "同意并发送" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("在线录入暂时不可用，请稍后重试");
    expect(screen.queryByText(/private|family\.sqlite/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成变更草稿" })).toBeEnabled();
  });
});
