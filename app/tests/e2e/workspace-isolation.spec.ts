import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import extract from "extract-zip";
import { expect, test, _electron as electron } from "@playwright/test";
import { addPerson, attachMedia, createWikiEntry, createWorkspace, openArea, returnHome } from "./helpers/family-ui";

test("keeps people, media, Wiki, tree, search and backup isolated across workspace deep links", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "family-agent-isolation-"));
  const mediaPath = join(root, "portrait.jpg");
  const backupPath = join(root, "workspace-a.zip");
  await writeFile(mediaPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]));
  const app = await electron.launch({
    args: [resolve("out/main/index.js"), `--user-data-dir=${join(root, "profile")}`],
    env: { ...process.env, FAMILY_AGENT_E2E_MEDIA_PATH: mediaPath, FAMILY_AGENT_E2E_BACKUP_PATH: backupPath }
  });

  try {
    const window = await app.firstWindow();
    const workspaceA = await createWorkspace(window, "甲谱");
    await addPerson(window, { name: "甲家人", gender: "男", year: "1970", month: "1" });
    await attachMedia(window, "甲家人", "甲谱肖像");
    await createWikiEntry(window, "甲谱家史", "只属于甲谱的故事");
    await returnHome(window);

    const workspaceB = await createWorkspace(window, "乙谱");
    await addPerson(window, { name: "乙家人", gender: "女", year: "1980", month: "2" });
    await attachMedia(window, "乙家人", "乙谱肖像");
    await createWikiEntry(window, "乙谱家史", "只属于乙谱的故事");

    await window.evaluate(() => { window.location.hash = "#/workspace/33333333-3333-4333-8333-333333333333/people"; });
    await expect(window.getByRole("heading", { name: "找不到这个谱册" })).toBeVisible();
    await expect(window.getByText("甲家人")).toHaveCount(0);
    await expect(window.getByText("乙家人")).toHaveCount(0);

    await window.evaluate((id) => { window.location.hash = `#/workspace/${id}/people`; }, workspaceA);
    await expect(window.locator(".workspace-identity strong")).toHaveText("甲谱");
    await expect(window.getByRole("button", { name: "查看甲家人" })).toBeVisible();
    await expect(window.getByRole("button", { name: "查看乙家人" })).toHaveCount(0);
    await window.getByRole("button", { name: "查看甲家人" }).click();
    await expect(window.getByRole("img", { name: "甲谱肖像" })).toBeVisible();
    await expect(window.getByText("乙谱肖像")).toHaveCount(0);

    await window.getByLabel("搜索当前谱册人物").fill("乙家人");
    await window.locator(".global-search").getByRole("button", { name: "搜索" }).click();
    await expect(window.locator('section[aria-label="人物搜索结果"]')).toContainText("没有匹配人物");
    await window.locator('section[aria-label="人物搜索结果"]').getByRole("button", { name: "关闭" }).click();

    await openArea(window, "家谱树");
    await expect(window.locator(".tree-person-node").filter({ hasText: "甲家人" })).toBeVisible();
    await expect(window.locator(".tree-person-node").filter({ hasText: "乙家人" })).toHaveCount(0);
    await openArea(window, "家族 Wiki");
    await expect(window.getByRole("button", { name: "打开词条：甲谱家史" })).toBeVisible();
    await expect(window.getByRole("button", { name: "打开词条：乙谱家史" })).toHaveCount(0);

    await openArea(window, "设置与数据");
    await window.getByRole("button", { name: "创建备份" }).click();
    await expect(window.getByText("备份已创建并验证", { exact: true })).toBeVisible();
    const extracted = join(root, "extracted-a");
    await extract(backupPath, { dir: extracted });
    const manifest = JSON.parse(await readFile(join(extracted, "backup-manifest.json"), "utf8")) as { workspaceId: string; workspaceName: string; counts: { people: number; wikiEntries: number; mediaAssets: number } };
    expect(manifest).toMatchObject({ workspaceId: workspaceA, workspaceName: "甲谱", counts: { people: 1, wikiEntries: 1, mediaAssets: 1 } });

    await window.evaluate((id) => { window.location.hash = `#/workspace/${id}/wiki`; }, workspaceB);
    await expect(window.locator(".workspace-identity strong")).toHaveText("乙谱");
    await expect(window.getByRole("button", { name: "打开词条：乙谱家史" })).toBeVisible();
    await expect(window.getByRole("button", { name: "打开词条：甲谱家史" })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
