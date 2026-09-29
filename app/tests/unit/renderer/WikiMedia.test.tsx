// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WikiEditor } from "../../../src/renderer/src/features/wiki/WikiEditor";
import { WikiPage } from "../../../src/renderer/src/features/wiki/WikiPage";
import { MediaGallery } from "../../../src/renderer/src/features/people/MediaGallery";

afterEach(cleanup);

describe("wiki and media components", () => {
  it("saves free-form wiki text and explicit links without creating family facts", async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, value: { id: "wiki-1" } });
    render(<WikiEditor api={{ create: save, update: vi.fn(), remove: vi.fn(), get: vi.fn() }} people={[{ id: "p1", displayName: "张敏" }]} sources={[{ id: "s1", title: "口述史" }]} />);
    fireEvent.change(screen.getByLabelText("词条标题"), { target: { value: "张氏家谱" } });
    fireEvent.change(screen.getByLabelText("词条正文"), { target: { value: "张敏迁居杭州的口述材料" } });
    fireEvent.click(screen.getByLabelText("关联人物：张敏"));
    fireEvent.click(screen.getByLabelText("关联来源：口述史"));
    fireEvent.click(screen.getByRole("button", { name: "保存词条" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ title: "张氏家谱", body: "张敏迁居杭州的口述材料", personIds: ["p1"], sourceIds: ["s1"] }));
  });

  it("renders registered image and audio assets, and imports through a token rather than a path", async () => {
    const media = {
      select: vi.fn().mockResolvedValue({ ok: true, value: { fileToken: "token", fileName: "song.mp3" } }),
      import: vi.fn().mockResolvedValue({ ok: true, value: { id: "audio-1" } }),
      attach: vi.fn().mockResolvedValue({ ok: true, value: null }),
      listForPerson: vi.fn()
    };
    render(<MediaGallery personId="p1" media={media} assets={[
      { id: "image-1", fileName: "portrait.jpg", mimeType: "image/jpeg", byteSize: 1, sha256: "a", url: "app-media://asset/image-1", caption: "肖像" },
      { id: "audio-1", fileName: "song.mp3", mimeType: "audio/mpeg", byteSize: 1, sha256: "b", url: "app-media://asset/audio-1", caption: "访谈" }
    ]} />);
    expect(screen.getByRole("img", { name: "肖像" })).toHaveAttribute("src", "app-media://asset/image-1");
    expect(screen.getByLabelText("播放：访谈")).toHaveAttribute("src", "app-media://asset/audio-1");
    fireEvent.change(screen.getByLabelText("媒体说明"), { target: { value: "新录音" } });
    fireEvent.click(screen.getByRole("button", { name: "添加媒体" }));
    await waitFor(() => expect(media.import).toHaveBeenCalledWith({ fileToken: "token" }));
    expect(media.attach).toHaveBeenCalledWith({ mediaAssetId: "audio-1", personId: "p1", caption: "新录音" });
  });

  it("owns media loading, refreshes after attach, and exposes typed failures", async () => {
    const media = {
      select: vi.fn().mockResolvedValue({ ok: true, value: { fileToken: "token", fileName: "photo.jpg" } }),
      import: vi.fn().mockResolvedValue({ ok: true, value: { id: "image-1" } }),
      attach: vi.fn().mockResolvedValue({ ok: true, value: null }),
      listForPerson: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: [] })
        .mockResolvedValueOnce({ ok: true, value: [{ id: "image-1", fileName: "photo.jpg", mimeType: "image/jpeg", byteSize: 1, sha256: "a", url: "app-media://asset/image-1" }] })
    };
    render(<MediaGallery personId="p1" media={media} assets={[]} />);
    await waitFor(() => expect(media.listForPerson).toHaveBeenCalledWith({ personId: "p1" }));
    expect(await screen.findByText("还没有媒体资料")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "添加媒体" }));
    expect(await screen.findByRole("img", { name: "photo.jpg" })).toBeVisible();
    expect(media.listForPerson).toHaveBeenCalledTimes(2);

    media.attach.mockResolvedValueOnce({ ok: false, error: { code: "INTERNAL", message: "无法关联媒体" } });
    fireEvent.click(screen.getByRole("button", { name: "添加媒体" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法关联媒体");
  });

  it("offers an explicit media refresh and sanitizes rejected Wiki operations", async () => {
    const media = {
      select: vi.fn(), import: vi.fn(), attach: vi.fn(),
      listForPerson: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: [] })
        .mockResolvedValueOnce({ ok: true, value: [{ id: "image-2", fileName: "new.jpg", mimeType: "image/jpeg", byteSize: 1, sha256: "b", url: "app-media://asset/image-2" }] })
    };
    const { unmount } = render(<MediaGallery personId="p1" media={media} />);
    await screen.findByText("还没有媒体资料");
    fireEvent.click(screen.getByRole("button", { name: "刷新媒体" }));
    expect(await screen.findByRole("img", { name: "new.jpg" })).toBeVisible();
    unmount();

    const api = { list: vi.fn().mockRejectedValue(new Error("C:\\private\\family.sqlite")) };
    render(<WikiPage api={api as never} query={{ searchWiki: vi.fn() } as never} people={[]} sources={[]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取 Wiki 词条");
    expect(screen.queryByText(/private|family\.sqlite/u)).not.toBeInTheDocument();
  });

  it("restores Wiki editor controls after a rejected save without exposing the thrown error", async () => {
    const api = { create: vi.fn().mockRejectedValue(new Error("secret family fact")), update: vi.fn(), remove: vi.fn() };
    render(<WikiEditor api={api as never} people={[]} sources={[]} />);
    fireEvent.change(screen.getByLabelText("词条标题"), { target: { value: "迁徙史" } });
    fireEvent.click(screen.getByRole("button", { name: "保存词条" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法保存词条");
    expect(screen.queryByText("secret family fact")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存词条" })).toBeEnabled();
  });

  it("lists, opens, searches, edits, and deletes Wiki entries with visible async states", async () => {
    const entry = { id: "wiki-1", slug: "history", title: "迁徙史", body: "迁居杭州", personIds: ["p1"], sourceIds: ["s1"], rowVersion: 1 };
    let resolveList!: (value: { ok: true; value: typeof entry[] }) => void;
    const listed = new Promise<{ ok: true; value: typeof entry[] }>((resolve) => { resolveList = resolve; });
    const api = {
      list: vi.fn().mockReturnValue(listed),
      create: vi.fn(), update: vi.fn().mockResolvedValue({ ok: true, value: { ...entry, title: "迁徙史校订", rowVersion: 2 } }),
      remove: vi.fn().mockResolvedValue({ ok: true, value: null }), get: vi.fn().mockResolvedValue({ ok: true, value: entry })
    };
    const query = { searchWiki: vi.fn().mockResolvedValue({ ok: true, value: [{ wikiEntryId: "wiki-1", title: "迁徙史", excerpt: "迁居杭州", sourceIds: ["s1"] }] }) };
    render(<WikiPage api={api as never} query={query as never} people={[{ id: "p1", displayName: "张敏" }]} sources={[{ id: "s1", title: "口述史" }]} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在加载词条");
    resolveList({ ok: true, value: [entry] });
    expect(await screen.findByRole("button", { name: /打开词条：迁徙史/ })).toBeVisible();
    fireEvent.change(screen.getByLabelText("搜索家族 Wiki"), { target: { value: "杭州" } });
    fireEvent.submit(screen.getByLabelText("搜索家族 Wiki").closest("form")!);
    await waitFor(() => expect(query.searchWiki).toHaveBeenCalledWith({ query: "杭州", limit: 50 }));
    fireEvent.click(screen.getByRole("button", { name: /打开词条：迁徙史/ }));
    expect(await screen.findByDisplayValue("迁居杭州")).toBeVisible();
    expect(screen.getByRole("button", { name: "删除词条" })).toBeVisible();
  });
});
