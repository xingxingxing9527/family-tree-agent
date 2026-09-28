// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MergeApi } from "../../../src/shared/contracts";
import { MergeHistory } from "../../../src/renderer/src/features/people/MergeHistory";

afterEach(cleanup);
const active = { id: "merge-1", primaryPersonId: "primary", secondaryPersonId: "secondary", status: "active" as const, createdAt: "2026-09-16T00:00:00.000Z" };
function api(check: ReturnType<typeof vi.fn>): MergeApi {
  return { history: vi.fn().mockResolvedValue({ ok: true, value: [active] }), canUnmerge: check, findDuplicateCandidates: vi.fn(), preview: vi.fn(), merge: vi.fn(), unmerge: vi.fn() } as unknown as MergeApi;
}
describe("MergeHistory", () => {
  it("shows checking then a reversible action only after main process approval", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const check = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<MergeHistory api={api(check)} />);
    expect(await screen.findByText("检查中")).toBeVisible();
    expect(screen.queryByRole("button", { name: "检查并撤销" })).not.toBeInTheDocument();
    finish({ ok: true, value: { allowed: true, blockingEntityIds: [], reasons: [] } });
    expect(await screen.findByText("可撤销")).toBeVisible();
    expect(screen.getByRole("button", { name: "撤销合并" })).toBeVisible();
  });
  it("shows blocked entity IDs and reasons without offering reversal", async () => {
    render(<MergeHistory api={api(vi.fn().mockResolvedValue({ ok: true, value: { allowed: false, blockingEntityIds: ["media-1"], reasons: [{ entityId: "media-1", entityType: "media_person", expectedVersion: 1, actualVersion: 2 }] } }))} />);
    expect(await screen.findByText(/不可撤销：media-1/)).toBeVisible();
    expect(screen.getByText(/media_person/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "撤销合并" })).not.toBeInTheDocument();
  });
  it("shows a check error state without calling unmerge", async () => {
    const mergeApi = api(vi.fn().mockResolvedValue({ ok: false, error: { code: "INTERNAL", message: "检查失败" } }));
    render(<MergeHistory api={mergeApi} />);
    expect(await screen.findByText(/检查失败/)).toBeVisible();
    await waitFor(() => expect(mergeApi.unmerge).not.toHaveBeenCalled());
  });
});
