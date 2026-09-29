// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MergeApi } from "../../../src/shared/contracts";
import { MergeHistory } from "../../../src/renderer/src/features/people/MergeHistory";
import { MergePanel } from "../../../src/renderer/src/features/people/MergePanel";

afterEach(cleanup);
const active = { id: "merge-1", primaryPersonId: "primary", secondaryPersonId: "secondary", status: "active" as const, createdAt: "2026-09-16T00:00:00.000Z" };
function api(check: ReturnType<typeof vi.fn>): MergeApi {
  return { history: vi.fn().mockResolvedValue({ ok: true, value: [active] }), canUnmerge: check, findDuplicateCandidates: vi.fn(), preview: vi.fn(), merge: vi.fn(), unmerge: vi.fn() } as unknown as MergeApi;
}
function preparedRefresh() {
  const workspace = { id: "workspace-a", name: "甲谱", directory: "opaque", originPersonId: null, lastOpenedAt: null, schemaVersion: 4 };
  return {
    complete: vi.fn().mockResolvedValue({ status: "refreshed" as const, workspace }),
    retry: vi.fn().mockResolvedValue({ status: "refreshed" as const, workspace })
  };
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
    const prepared = preparedRefresh();
    const prepareMutation = vi.fn(() => prepared);
    render(<MergeHistory api={mergeApi} prepareMutation={prepareMutation} />);
    expect(await screen.findByText(/检查失败/)).toBeVisible();
    await waitFor(() => expect(mergeApi.unmerge).not.toHaveBeenCalled());
    expect(prepared.complete).not.toHaveBeenCalled();
  });
  it("keeps exact blocked details when the click-time recheck changes from allowed", async () => {
    const check = vi.fn().mockResolvedValueOnce({ ok: true, value: { allowed: true, blockingEntityIds: [], reasons: [] } }).mockResolvedValueOnce({ ok: true, value: { allowed: false, blockingEntityIds: ["missing-link"], reasons: [{ entityId: "missing-link", entityType: "wiki_person", expectedVersion: 3, actualVersion: null }] } });
    const mergeApi = api(check);
    render(<MergeHistory api={mergeApi} />);
    fireEvent.click(await screen.findByRole("button", { name: "撤销合并" }));
    expect(await screen.findByText(/wiki_person:missing-link.*expected 3.*actual missing/)).toBeVisible();
    expect(mergeApi.unmerge).not.toHaveBeenCalled();
  });

  it("requests the authoritative workspace refresh after an allowed unmerge", async () => {
    const mergeApi = api(vi.fn().mockResolvedValue({ ok: true, value: { allowed: true, blockingEntityIds: [], reasons: [] } }));
    vi.mocked(mergeApi.unmerge).mockResolvedValue({ ok: true, value: { id: active.id, status: "reversed" } });
    const prepared = preparedRefresh();
    const prepareMutation = vi.fn(() => prepared);
    render(<MergeHistory api={mergeApi} prepareMutation={prepareMutation} />);
    fireEvent.click(await screen.findByRole("button", { name: "撤销合并" }));
    await waitFor(() => expect(mergeApi.unmerge).toHaveBeenCalledWith({ mergeId: active.id }));
    await waitFor(() => expect(prepareMutation).toHaveBeenCalledWith());
    expect(prepared.complete).toHaveBeenCalledWith();
  });

  it("does not invoke mutation completion when unmerge fails", async () => {
    const mergeApi = api(vi.fn().mockResolvedValue({ ok: true, value: { allowed: true, blockingEntityIds: [], reasons: [] } }));
    vi.mocked(mergeApi.unmerge).mockResolvedValue({ ok: false, error: { code: "CONFLICT", message: "撤销冲突" } });
    const prepared = preparedRefresh();
    render(<MergeHistory api={mergeApi} prepareMutation={() => prepared} />);
    fireEvent.click(await screen.findByRole("button", { name: "撤销合并" }));
    expect(await screen.findByText("撤销冲突")).toBeVisible();
    expect(prepared.complete).not.toHaveBeenCalled();
  });

  it("keeps a committed unmerge distinct from a failed refresh and retries only the refresh", async () => {
    const mergeApi = api(vi.fn().mockResolvedValue({ ok: true, value: { allowed: true, blockingEntityIds: [], reasons: [] } }));
    vi.mocked(mergeApi.unmerge).mockResolvedValue({ ok: true, value: { id: active.id, status: "reversed" } });
    const prepared = preparedRefresh();
    prepared.complete.mockRejectedValue(new Error("C:\\private\\family.sqlite"));
    render(<MergeHistory api={mergeApi} prepareMutation={() => prepared} />);
    fireEvent.click(await screen.findByRole("button", { name: "撤销合并" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("撤销合并已提交，但界面刷新失败。请勿重复撤销合并");
    fireEvent.click(screen.getByRole("button", { name: "重新刷新界面" }));
    await waitFor(() => expect(prepared.retry).toHaveBeenCalledWith());
    expect(mergeApi.unmerge).toHaveBeenCalledTimes(1);
  });

  it("actually requests duplicate candidates from the merge panel", async () => {
    const mergeApi = api(vi.fn());
    vi.mocked(mergeApi.findDuplicateCandidates).mockResolvedValue({ ok: true, value: [] });
    render(<MergePanel personId="primary" api={mergeApi} onMerged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "查找疑似重复" }));
    await waitFor(() => expect(mergeApi.findDuplicateCandidates).toHaveBeenCalledWith({ personId: "primary" }));
    expect(screen.getByText("没有足够证据的候选项。")).toBeVisible();
  });

  it("renders a sanitized failure when merge history IPC rejects", async () => {
    const mergeApi = api(vi.fn());
    vi.mocked(mergeApi.history).mockRejectedValue(new Error("C:\\private\\family.sqlite"));
    render(<MergeHistory api={mergeApi} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取合并历史");
    expect(screen.queryByText(/private|family\.sqlite/u)).not.toBeInTheDocument();
  });
});
