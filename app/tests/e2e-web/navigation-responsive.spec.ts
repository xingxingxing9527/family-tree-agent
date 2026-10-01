import { expect, test } from "@playwright/test";
import { ensureFamily, openArea } from "./helpers";

test("navigation and responsive shell stay readable without page overflow", async ({ page, request }) => {
  const workspace = await ensureFamily(request);
  for (const width of [736, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await openArea(page, workspace.id, "tree");
    const primary = page.getByRole("navigation", { name: "一级导航" });
    await expect(primary.getByRole("link")).toHaveText(["家谱树", "人物", "录入", "问答"]);
    await expect(page.getByRole("navigation", { name: "次级导航" }).getByRole("link")).toHaveText(["家族 Wiki", "设置与数据"]);
    await expect(page.getByRole("button", { name: "切换谱册" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const colors = await primary.getByRole("link", { name: "家谱树" }).evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor, opacity: style.opacity };
    });
    expect(colors.opacity).toBe("1");
    expect(colors.color).not.toBe(colors.background);
  }
});
