import { expect, test } from "@playwright/test";
import { ensureFamily, openArea, rpc, stageAndConfirm } from "./helpers";

const personIntent = (displayName: string, notes: string) => ({
  type: "person.create",
  draft: {
    displayName,
    aliases: [],
    gender: "unknown",
    birth: null,
    death: null,
    notes,
    sourceDescription: "网页备份与撤销验证"
  }
});

test("creates, inspects and restores a browser backup, then undoes a confirmed write", async ({ page, request }, testInfo) => {
  const workspace = await ensureFamily(request);
  const initial = await rpc<{ people: Array<{ id: string }> }>(request, "query", "workspaceSnapshot");
  if (initial.people.length === 0) await stageAndConfirm(request, [personIntent("备份基准人物", "建立备份原点")]);
  await openArea(page, workspace.id, "settings");
  const backupPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "创建备份" }).click();
  const backup = await backupPromise;
  expect(backup.suggestedFilename()).toMatch(/\.zip$/u);
  const backupPath = testInfo.outputPath("family-backup.zip");
  await backup.saveAs(backupPath);
  await expect(page.getByText("备份已创建并验证", { exact: true })).toBeVisible();

  const postBackupName = `备份后人物-${Date.now()}`;
  await stageAndConfirm(request, [personIntent(postBackupName, "恢复后应消失")]);
  expect(await rpc<Array<unknown>>(request, "query", "searchPeople", { query: postBackupName, limit: 20 })).toHaveLength(1);

  await page.locator('input[type="file"][accept*=".zip"]').setInputFiles(backupPath);
  await expect(page.getByText("family-backup.zip", { exact: true })).toBeVisible();
  await page.getByLabel("恢复目标谱册").selectOption(workspace.id);
  await page.getByRole("button", { name: "验证备份" }).click();
  await expect(page.getByLabel("备份验证结果")).toContainText("验证通过");
  await page.getByLabel(`我确认用已验证备份替换${workspace.name}`).check();
  await page.getByRole("button", { name: "替换目标谱册" }).click();
  await expect(page.getByText("恢复完成，自动快照已验证", { exact: true })).toBeVisible();
  expect(await rpc<Array<unknown>>(request, "query", "searchPeople", { query: postBackupName, limit: 20 })).toEqual([]);

  const uniqueName = `待撤销人物-${Date.now()}`;
  const receipt = await stageAndConfirm(request, [personIntent(uniqueName, "撤销验证")]);
  // The write above uses the API request context, so refresh the already-open
  // settings page before asserting against its audit-history projection.
  await page.reload();
  await expect(page.getByRole("heading", { name: "设置与数据" })).toBeVisible();
  await page.getByRole("button", { name: `撤销 ${receipt.operationGroupId}` }).click();
  const dialog = page.getByRole("dialog", { name: "确认撤销操作" });
  await dialog.getByLabel(/我确认撤销以上/u).check();
  await dialog.getByRole("button", { name: "确认撤销" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/已撤销/u).first()).toBeVisible();

  const matches = await rpc<Array<{ id: string; displayName: string }>>(request, "query", "searchPeople", { query: uniqueName, limit: 20 });
  expect(matches).toEqual([]);
});
