// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../../../src/renderer/src/app/ErrorBoundary";

function Broken(): React.JSX.Element {
  throw new Error("C:\\Users\\private\\family.sqlite api-key-secret 张敏出生于1988年");
}

describe("ErrorBoundary", () => {
  it("shows a recoverable diagnostic without paths, keys, stacks, or family facts", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("界面暂时无法显示");
    expect(alert).toHaveTextContent(/诊断编号：[A-Z0-9-]+/);
    expect(alert).not.toHaveTextContent(/Users|sqlite|api-key|张敏|1988|stack/i);
    expect(screen.getByRole("button", { name: "返回首页" })).toBeVisible();
  });
});
