import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("mounts controlled conversation entry in the isolated shell without exposing secrets", async () => {
  const userData = await mkdtemp(join(tmpdir(), "family-agent-conversation-surface-"));
  const app = await electron.launch({ args: [resolve("out/main/index.js"), `--user-data-dir=${userData}`] });
  try {
    const window = await app.firstWindow();
    expect(await window.evaluate(() => ({
      authorize: typeof window.desktopApi.chat.authorize,
      stageMutation: typeof window.desktopApi.chat.stageMutation,
      ask: typeof window.desktopApi.chat.ask,
      confirm: typeof window.desktopApi.chat.confirm,
      revise: typeof window.desktopApi.chat.revise,
      saveKey: typeof window.desktopApi.modelSettings.saveKey,
      workspaceSnapshot: typeof window.desktopApi.query.workspaceSnapshot,
      projectTree: typeof window.desktopApi.query.projectTree,
      wikiList: typeof window.desktopApi.wiki.list,
      exposedKeyReader: "readKey" in window.desktopApi.modelSettings
    }))).toEqual({
      authorize: "function", stageMutation: "function", ask: "function", confirm: "function", revise: "function", saveKey: "function",
      workspaceSnapshot: "function", projectTree: "function", wikiList: "function", exposedKeyReader: false
    });
    await window.getByLabel("谱册名称").fill("对话表面谱册");
    await window.getByRole("button", { name: "新建并打开谱册" }).click();
    await window.getByRole("navigation", { name: "一级导航" }).getByRole("link", { name: "录入中心" }).click();
    await expect(window.getByRole("heading", { name: "录入中心" })).toBeVisible();
    await expect(window.getByRole("heading", { name: "家谱问答" })).toBeVisible();
    await window.getByRole("button", { name: "对话录入" }).click();
    await expect(window.getByRole("heading", { name: "对话录入" })).toBeVisible();
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
