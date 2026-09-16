import { test, expect, _electron as electron } from "@playwright/test";
import { resolve } from "node:path";

test("launches with an isolated desktop API", async () => {
  const app = await electron.launch({ args: [resolve("out/main/index.js")] });
  const window = await app.firstWindow();

  await expect(window).toHaveTitle("家谱智能体");
  await expect(window.locator("body")).toContainText("家谱智能体");
  expect(await window.evaluate(() => typeof window.desktopApi.app.getVersion)).toBe("function");
  expect(await window.evaluate(() => typeof window.require)).toBe("undefined");
  expect(await window.evaluate(() => typeof window.process)).toBe("undefined");

  await app.close();
});
