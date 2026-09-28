import { expect, test, _electron as electron } from "@playwright/test";
import { resolve } from "node:path";

test("exposes the controlled conversation entry surface without mounting the Task 14 route", async () => {
  const app = await electron.launch({ args: [resolve("out/main/index.js")] });
  try {
    const window = await app.firstWindow();
    expect(await window.evaluate(() => ({
      authorize: typeof window.desktopApi.chat.authorize,
      stageMutation: typeof window.desktopApi.chat.stageMutation,
      ask: typeof window.desktopApi.chat.ask,
      confirm: typeof window.desktopApi.chat.confirm,
      revise: typeof window.desktopApi.chat.revise,
      saveKey: typeof window.desktopApi.modelSettings.saveKey,
      exposedKeyReader: "readKey" in window.desktopApi.modelSettings
    }))).toEqual({
      authorize: "function", stageMutation: "function", ask: "function", confirm: "function", revise: "function", saveKey: "function", exposedKeyReader: false
    });
    await expect(window.getByRole("heading", { name: "家谱智能体" })).toBeVisible();
    await expect(window.getByRole("heading", { name: "家谱问答" })).toHaveCount(0);
  } finally { await app.close(); }
});
