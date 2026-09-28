// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WikiEditor } from "../../../src/renderer/src/features/wiki/WikiEditor";
import { MediaGallery } from "../../../src/renderer/src/features/people/MediaGallery";

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
});
