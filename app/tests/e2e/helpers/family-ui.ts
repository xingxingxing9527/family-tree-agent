import { expect, type Page } from "@playwright/test";

export interface PersonFixture { name: string; gender: "男" | "女"; year: string; month: string; }

export async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.getByLabel("谱册名称").fill(name);
  await page.getByRole("button", { name: "新建并打开谱册" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const match = page.url().match(/#\/workspace\/([^/]+)\//u);
  if (!match?.[1]) throw new Error("workspace route did not contain an id");
  return match[1];
}

export async function openArea(page: Page, label: "家谱树" | "人物库" | "录入中心" | "家族 Wiki" | "设置与数据"): Promise<void> {
  await page.getByRole("navigation", { name: "一级导航" }).getByRole("link", { name: label }).click();
}

export async function addPerson(page: Page, person: PersonFixture): Promise<void> {
  await page.getByRole("button", { name: "新增人物" }).click();
  await page.getByLabel("姓名").fill(person.name);
  await page.getByLabel("性别").selectOption({ label: person.gender });
  await page.getByLabel("出生日期历法").selectOption("solar");
  await page.getByLabel("出生年份").fill(person.year);
  await page.getByLabel("出生月份").fill(person.month);
  await page.getByLabel("来源说明").fill("端到端核对录入");
  await page.getByRole("button", { name: "保存人物" }).click();
  await expect(page.getByRole("heading", { name: person.name })).toBeVisible();
}

export async function addParentChild(page: Page, parent: string, child: string, role: "父亲" | "母亲"): Promise<void> {
  await page.getByLabel("父母人物").selectOption({ label: parent });
  await page.getByLabel("子女人物").selectOption({ label: child });
  await page.getByLabel("父母角色").selectOption({ label: role });
  await page.getByLabel("亲子关系来源").fill("端到端核对录入");
  await page.getByRole("button", { name: "保存亲子关系" }).click();
  await expect(page.getByText("亲子关系已保存", { exact: true })).toBeVisible();
}

export async function addMarriage(page: Page, spouseA: string, spouseB: string): Promise<void> {
  await page.getByLabel("配偶一").selectOption({ label: spouseA });
  await page.getByLabel("配偶二").selectOption({ label: spouseB });
  await page.getByLabel("婚姻来源").fill("端到端核对录入");
  await page.getByRole("button", { name: "保存婚姻" }).click();
  await expect(page.getByText("婚姻已保存", { exact: true })).toBeVisible();
}

export async function chooseSearchResult(page: Page, query: string, resultName: string): Promise<void> {
  await page.getByLabel("搜索当前谱册人物").fill(query);
  await page.locator(".global-search").getByRole("button", { name: "搜索" }).click();
  const results = page.locator('section[aria-label="人物搜索结果"]');
  await expect(results).toBeVisible();
  await results.getByRole("button", { name: new RegExp(resultName, "u") }).click();
}

export async function createWikiEntry(page: Page, title: string, body: string): Promise<void> {
  await openArea(page, "家族 Wiki");
  await page.getByLabel("词条标题").fill(title);
  await page.getByLabel("词条正文").fill(body);
  await page.getByRole("button", { name: "保存词条" }).click();
  await expect(page.getByRole("button", { name: `打开词条：${title}` })).toBeVisible();
}

export async function attachMedia(page: Page, personName: string, caption: string): Promise<void> {
  await openArea(page, "人物库");
  await page.getByRole("button", { name: `查看${personName}` }).click();
  await expect(page.getByText("还没有媒体资料")).toBeVisible();
  await page.getByLabel("媒体说明").fill(caption);
  await page.getByRole("button", { name: "添加媒体" }).click();
  await expect(page.getByRole("img", { name: caption })).toBeVisible();
}

export async function returnHome(page: Page): Promise<void> {
  await page.getByRole("button", { name: "切换谱册" }).click();
  await expect(page.getByRole("heading", { name: "家谱智能体" })).toBeVisible();
}
