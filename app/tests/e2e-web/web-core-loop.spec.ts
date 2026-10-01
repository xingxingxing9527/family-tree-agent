import { expect, test, type Page } from "@playwright/test";
import { ensureFamily, openArea, rpc, stageAndConfirm } from "./helpers";

const people = [
  { name: "闭环王建国", gender: "male" },
  { name: "闭环赵秀兰", gender: "female" },
  { name: "闭环李华", gender: "female" },
  { name: "闭环王强", gender: "male" },
  { name: "闭环王小雨", gender: "female" }
] as const;

async function addPerson(page: Page, name: string, gender: string): Promise<void> {
  await page.getByRole("button", { name: "新增人物" }).click();
  await page.getByLabel("姓名", { exact: true }).fill(name);
  await page.getByLabel("性别", { exact: true }).selectOption(gender);
  await page.getByRole("button", { name: "保存人物" }).click();
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认写入" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function selectPerson(page: Page, label: string, name: string): Promise<void> {
  const select = page.getByLabel(label, { exact: true });
  const value = await select.locator("option").filter({ hasText: name }).getAttribute("value");
  if (!value) throw new Error(`Missing ${name} option for ${label}`);
  await select.selectOption(value);
}

async function confirmStagedWrite(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog).toBeVisible();
  for (const warning of await dialog.getByLabel(/^我已阅读 /u).all()) await warning.check();
  await dialog.getByRole("button", { name: "确认写入" }).click();
  await expect(dialog).toBeHidden();
}

async function addParentChild(page: Page, parent: string, child: string): Promise<void> {
  await selectPerson(page, "父母人物", parent);
  await selectPerson(page, "子女人物", child);
  await page.getByLabel("父母角色").selectOption("father");
  await page.getByLabel("亲子关系来源").fill("闭环亲子资料");
  await page.getByRole("button", { name: "保存亲子关系" }).click();
  await confirmStagedWrite(page);
  await expect(page.getByText("亲子关系已保存", { exact: true })).toBeVisible();
}

async function addMarriage(page: Page, spouseA: string, spouseB: string, source: string): Promise<void> {
  await selectPerson(page, "配偶一", spouseA);
  await selectPerson(page, "配偶二", spouseB);
  await page.getByLabel("婚姻来源").fill(source);
  await page.getByRole("button", { name: "保存婚姻" }).click();
  await confirmStagedWrite(page);
  await expect(page.getByText("婚姻已保存", { exact: true })).toBeVisible();
}

test("creates a five-person family with divorce, remarriage, tree evidence, question and export", async ({ page, request }) => {
  const workspace = await ensureFamily(request);
  await openArea(page, workspace.id, "people");
  for (const person of people) await addPerson(page, person.name, person.gender);

  await addParentChild(page, "闭环王建国", "闭环王强");
  await addParentChild(page, "闭环王建国", "闭环王小雨");
  await addMarriage(page, "闭环王建国", "闭环赵秀兰", "闭环原婚姻");
  await page.getByRole("button", { name: "查看闭环王建国" }).click();
  await page.getByRole("button", { name: "登记离婚" }).click();
  await page.getByRole("button", { name: "确认离婚" }).click();
  await confirmStagedWrite(page);
  await expect(page.getByText("已离婚", { exact: true })).toBeVisible();
  await addMarriage(page, "闭环王建国", "闭环李华", "闭环再婚");

  const snapshot = await rpc<{ people: Array<{ id: string; displayName: string }> }>(request, "query", "workspaceSnapshot");
  const id = (name: string): string => snapshot.people.find((person) => person.displayName === name)!.id;
  const father = id("闭环王建国");
  const formerSpouse = id("闭环赵秀兰");
  const currentSpouse = id("闭环李华");
  const son = id("闭环王强");
  const daughter = id("闭环王小雨");

  const lineage = await stageAndConfirm(request, [{ type: "lineage.create", name: "闭环王氏", founderPersonId: father, description: "Web E2E" }]);
  const lineageId = lineage.changedEntityIds[0]!;
  await stageAndConfirm(request, [
    { type: "lineageMembership.add", lineageId, personId: father, lineageRole: "blood", isPrimary: true, declaredGeneration: 1, generationMarker: null },
    { type: "lineageMembership.add", lineageId, personId: son, lineageRole: "blood", isPrimary: true, declaredGeneration: 2, generationMarker: null },
    { type: "lineageMembership.add", lineageId, personId: daughter, lineageRole: "blood", isPrimary: true, declaredGeneration: 2, generationMarker: null },
    { type: "lineageMembership.add", lineageId, personId: formerSpouse, lineageRole: "married_in", isPrimary: true, declaredGeneration: 1, generationMarker: null },
    { type: "lineageMembership.add", lineageId, personId: currentSpouse, lineageRole: "married_in", isPrimary: true, declaredGeneration: 1, generationMarker: null }
  ]);

  await openArea(page, workspace.id, "tree");
  await expect(page.getByRole("group", { name: "人物：闭环王建国" })).toContainText("本层子女");
  await expect(page.getByRole("group", { name: "人物：闭环赵秀兰" })).toContainText("配偶");
  await expect(page.getByRole("group", { name: "家庭联合：已结束婚姻" }).first()).toBeVisible();
  await expect(page.getByRole("group", { name: "家庭联合：婚姻" }).first()).toBeVisible();

  await page.getByRole("link", { name: "问答" }).click();
  await page.getByLabel("回答视角").selectOption(father);
  await page.getByLabel("问题人物").selectOption(daughter);
  await page.getByRole("button", { name: "关系查询" }).click();
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByRole("button", { name: "同意并发送" }).click();
  await expect(page.getByLabel("家谱问答").getByText("女儿；关系路径已列出。", { exact: true })).toBeVisible();
  await expect(page.getByText("闭环王建国 → 闭环王小雨")).toBeVisible();
  await expect(page.getByText("闭环亲子资料").first()).toBeVisible();

  await page.getByRole("link", { name: "录入" }).click();
  await page.getByRole("button", { name: "表格导入" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前家谱表格" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("当前家谱");
});
