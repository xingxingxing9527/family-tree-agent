import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ensureFamily, openArea, rpc, stageAndConfirm } from "./helpers";

interface Workspace { id: string; name: string }
interface Result<T> { ok: boolean; value?: T; error?: { message: string } }
interface PartialDate {
  calendar: "solar" | "lunar";
  year: number;
  month: number;
  day: number | null;
  leapMonth: boolean;
  precision: "month" | "day";
}
interface RelativeRow {
  relationId: string;
  kind: "parent" | "child" | "spouse";
  person: { id: string; displayName: string };
  parentRole: "father" | "mother" | null;
  originKind?: "explicit" | "spouse_default";
  inferredFromMarriageId?: string | null;
}

const solar = (year: number, month: number, day: number | null = null): PartialDate => ({
  calendar: "solar",
  year,
  month,
  day,
  leapMonth: false,
  precision: day === null ? "month" : "day"
});

async function freshFamily(request: APIRequestContext, _scenarioName: string): Promise<Workspace> {
  return ensureFamily(request);
}

async function createPerson(
  request: APIRequestContext,
  displayName: string,
  gender: "male" | "female" | "unknown" = "unknown",
  birth: PartialDate | null = null
): Promise<string> {
  const receipt = await stageAndConfirm(request, [{
    type: "person.create",
    draft: {
      displayName,
      aliases: [],
      gender,
      birth,
      death: null,
      notes: null,
      sourceDescription: "父母补全 Web 验收"
    }
  }]);
  const id = receipt.changedEntityIds[0];
  if (!id) throw new Error(`Missing created person id for ${displayName}`);
  return id;
}

async function createMarriage(
  request: APIRequestContext,
  spouseAId: string,
  spouseBId: string,
  options: { status?: "active" | "divorced"; start?: PartialDate | null; end?: PartialDate | null } = {}
): Promise<string> {
  const receipt = await stageAndConfirm(request, [{
    type: "marriage.add",
    draft: {
      spouseAId,
      spouseBId,
      status: options.status ?? "active",
      start: options.start ?? null,
      end: options.end ?? null,
      sourceDescription: "父母补全 Web 验收婚姻"
    }
  }]);
  const id = receipt.changedEntityIds[0];
  if (!id) throw new Error("Missing created marriage id");
  return id;
}

async function createExplicitParent(
  request: APIRequestContext,
  parentId: string,
  childId: string,
  parentRole: "father" | "mother"
): Promise<void> {
  await stageAndConfirm(request, [{
    type: "parentChild.add",
    draft: { parentId, childId, parentRole, sourceDescription: "父母补全 Web 验收明确关系" }
  }]);
}

async function createCompletedFamily(
  request: APIRequestContext,
  knownParentId: string,
  childId: string,
  parentRole: "father" | "mother"
): Promise<void> {
  await stageAndConfirm(request, [{
    type: "parentFamily.add",
    knownParentId,
    childId,
    parentRole,
    completionPolicy: "spouse-default",
    sourceDescription: "父母补全 Web 验收家庭关系"
  }]);
}

async function openPerson(page: Page, workspaceId: string, displayName: string): Promise<void> {
  await openArea(page, workspaceId, "people");
  await page.getByRole("button", { name: `查看${displayName}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: displayName, exact: true })).toBeVisible();
  await expect(page.getByText(`当前人物固定为：${displayName}`, { exact: true })).toBeVisible();
}

async function selectChildrenAndPreview(
  page: Page,
  childNames: string[],
  role: "father" | "mother"
): Promise<void> {
  for (const childName of childNames) await page.getByRole("checkbox", { name: `选择子女 ${childName}`, exact: true }).check();
  await page.getByRole("radio", { name: role === "father" ? "当前人物作为父亲" : "当前人物作为母亲", exact: true }).check();
  await page.getByRole("button", { name: "生成子女关系预览", exact: true }).click();
}

async function confirmDialog(page: Page): Promise<{ operationGroupId: string }> {
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog).toBeVisible();
  for (const warning of await dialog.getByLabel(/^我已阅读 /u).all()) await warning.check();
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/api/rpc/mutations/confirm"));
  await dialog.getByRole("button", { name: "确认写入", exact: true }).click();
  const body = await (await responsePromise).json() as Result<{ operationGroupId: string }>;
  if (!body.ok || !body.value) throw new Error(body.error?.message ?? "Unable to confirm staged mutation");
  await expect(dialog).toBeHidden();
  return body.value;
}

async function relatives(request: APIRequestContext, personId: string, kinds: Array<"parent" | "child" | "spouse">): Promise<RelativeRow[]> {
  return rpc<RelativeRow[]>(request, "query", "listRelatives", { personId, kinds });
}

async function undoMostRecentFromSettings(page: Page, workspaceId: string): Promise<void> {
  await openArea(page, workspaceId, "settings");
  await page.getByRole("button", { name: /^撤销 /u }).first().click();
  const dialog = page.getByRole("dialog", { name: "确认撤销操作" });
  await dialog.getByLabel(/我确认撤销以上/u).check();
  await dialog.getByRole("button", { name: "确认撤销", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function selectVisibleOption(page: Page, label: string, optionText: string): Promise<void> {
  const select = page.getByLabel(label, { exact: true });
  const value = await select.locator("option").filter({ hasText: optionText }).getAttribute("value");
  if (!value) throw new Error(`Missing ${optionText} option for ${label}`);
  await select.selectOption(value);
}

async function openTreeBranch(page: Page, workspaceId: string, centerName: string): Promise<void> {
  await openArea(page, workspaceId, "tree");
  await selectVisibleOption(page, "视图中心", centerName);
  await page.getByRole("button", { name: "支系", exact: true }).click();
  await expect(page.getByRole("button", { name: "支系", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: `人物：${centerName}`, exact: true })).toBeVisible();
}

test("普通夫妻新增一个孩子时预览人工与自动两行", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-普通夫妻");
  const father = await createPerson(request, "验收普通父亲", "male");
  const mother = await createPerson(request, "验收普通母亲", "female");
  await createMarriage(request, father, mother);
  await openPerson(page, workspace.id, "验收普通父亲");

  await page.getByRole("button", { name: "快速新建子女", exact: true }).click();
  await page.getByLabel("姓名", { exact: true }).fill("验收普通孩子");
  await page.getByLabel("性别", { exact: true }).selectOption("female");
  await page.getByRole("button", { name: "保存人物", exact: true }).click();
  await confirmDialog(page);
  await expect(page.getByRole("checkbox", { name: "选择子女 验收普通孩子", exact: true })).toBeChecked();

  await selectChildrenAndPreview(page, ["验收普通孩子"], "father");
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog.getByLabel(/选择 验收普通父亲 → 验收普通孩子：父亲/u)).toBeChecked();
  await expect(dialog.getByLabel(/选择 验收普通母亲 → 验收普通孩子：母亲/u)).toBeChecked();
  await expect(dialog.getByText("人工录入", { exact: true })).toBeVisible();
  await expect(dialog.getByText("系统自动补全", { exact: true })).toBeVisible();
  await confirmDialog(page);

  const childSearch = await rpc<Array<{ id: string }>>(request, "query", "searchPeople", { query: "验收普通孩子", limit: 10 });
  const childParents = await relatives(request, childSearch[0]!.id, ["parent"]);
  expect(childParents.map(({ originKind }) => originKind).sort()).toEqual(["explicit", "spouse_default"]);
});

test("管理员取消自动项后只保存明确亲子关系", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-取消自动项");
  const father = await createPerson(request, "验收取消父亲", "male");
  const mother = await createPerson(request, "验收取消母亲", "female");
  const child = await createPerson(request, "验收取消孩子", "unknown");
  await createMarriage(request, father, mother);
  await openPerson(page, workspace.id, "验收取消父亲");

  await selectChildrenAndPreview(page, ["验收取消孩子"], "father");
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await dialog.getByLabel(/选择 验收取消母亲 → 验收取消孩子：母亲/u).uncheck();
  await confirmDialog(page);

  expect(await relatives(request, child, ["parent"])).toEqual([
    expect.objectContaining({ person: expect.objectContaining({ displayName: "验收取消父亲" }), originKind: "explicit" })
  ]);
  await createExplicitParent(request, mother, child, "mother");
});

test("无配偶时说明另一位父母未确认且明确关系仍可保存", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-无配偶");
  const parent = await createPerson(request, "验收单身父亲", "male");
  const child = await createPerson(request, "验收无配偶孩子", "unknown");
  await openPerson(page, workspace.id, "验收单身父亲");

  await selectChildrenAndPreview(page, ["验收无配偶孩子"], "father");
  await expect(page.getByText("验收无配偶孩子：另一位父母尚未确认", { exact: true })).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog.getByRole("checkbox")).toHaveCount(1);
  await confirmDialog(page);

  expect(await relatives(request, child, ["parent"])).toEqual([
    expect.objectContaining({ person: expect.objectContaining({ id: parent }), parentRole: "father" })
  ]);
  const manuallyRecordedMother = await createPerson(request, "验收无配偶管理员补录母亲", "female");
  await createExplicitParent(request, manuallyRecordedMother, child, "mother");
});

test("离婚再婚按唯一出生区间选择前配偶", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-出生区间");
  const father = await createPerson(request, "验收区间父亲", "male");
  const former = await createPerson(request, "验收区间前配偶", "female");
  const current = await createPerson(request, "验收区间现配偶", "female");
  const child = await createPerson(request, "验收区间孩子", "unknown", solar(1995, 6, 15));
  const formerMarriage = await createMarriage(request, father, former, { status: "divorced", start: solar(1990, 1), end: solar(2000, 12) });
  await createMarriage(request, father, current, { status: "active", start: solar(2010, 1) });
  await openPerson(page, workspace.id, "验收区间父亲");

  await selectChildrenAndPreview(page, ["验收区间孩子"], "father");
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog.getByLabel(/选择 验收区间前配偶 → 验收区间孩子：母亲（依据：孩子出生时间与婚姻区间唯一匹配）/u)).toBeChecked();
  await expect(dialog.getByText(/验收区间现配偶/u)).toHaveCount(0);
  await confirmDialog(page);

  expect(await relatives(request, child, ["parent"])).toEqual(expect.arrayContaining([
    expect.objectContaining({ person: expect.objectContaining({ displayName: "验收区间前配偶" }), inferredFromMarriageId: formerMarriage })
  ]));
});

test("缺少出生日期的歧义允许一项选择候选另一项暂时跳过", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-歧义选择跳过");
  const father = await createPerson(request, "验收歧义父亲", "male");
  const former = await createPerson(request, "验收歧义前配偶", "female");
  const current = await createPerson(request, "验收歧义现配偶", "female");
  const chosenChild = await createPerson(request, "验收歧义选择孩子");
  const skippedChild = await createPerson(request, "验收歧义跳过孩子");
  await createMarriage(request, father, former, { status: "divorced", start: solar(1990, 1), end: solar(2000, 12) });
  await createMarriage(request, father, current, { status: "active", start: solar(2010, 1) });
  await openPerson(page, workspace.id, "验收歧义父亲");

  await selectChildrenAndPreview(page, ["验收歧义选择孩子", "验收歧义跳过孩子"], "father");
  await expect(page.getByRole("heading", { name: "请选择另一位父母，或暂时跳过", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "为验收歧义选择孩子选择验收歧义前配偶", exact: true }).check();
  await page.getByRole("radio", { name: "暂时跳过验收歧义跳过孩子的另一位父母", exact: true }).check();
  await page.getByRole("button", { name: "生成关系预览", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog.getByText("系统自动补全", { exact: true })).toHaveCount(1);
  await confirmDialog(page);

  expect(await relatives(request, chosenChild, ["parent"])).toHaveLength(2);
  expect(await relatives(request, skippedChild, ["parent"])).toEqual([
    expect.objectContaining({ person: expect.objectContaining({ id: father }), originKind: "explicit" })
  ]);
  await createExplicitParent(request, current, skippedChild, "mother");
});

test("互补父母角色已占用时阻断自动项但保留明确关系", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-角色占用");
  const father = await createPerson(request, "验收冲突父亲", "male");
  const suggested = await createPerson(request, "验收冲突婚姻母亲", "female");
  const recorded = await createPerson(request, "验收冲突现有母亲", "female");
  const child = await createPerson(request, "验收冲突孩子");
  await createMarriage(request, father, suggested);
  await createExplicitParent(request, recorded, child, "mother");
  await openPerson(page, workspace.id, "验收冲突父亲");

  await selectChildrenAndPreview(page, ["验收冲突孩子"], "father");
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog.getByText(/孩子验收冲突孩子的母亲已是验收冲突现有母亲，不能用建议候选验收冲突婚姻母亲覆盖/u)).toBeVisible();
  await expect(dialog.getByText("系统自动补全", { exact: true })).toBeVisible();
  await confirmDialog(page);

  const parents = await relatives(request, child, ["parent"]);
  expect(parents.map(({ person }) => person.displayName).sort()).toEqual(["验收冲突父亲", "验收冲突现有母亲"]);
});

test("一次选择多个子女会为每人生成明确与自动两条预览", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-多个子女");
  const father = await createPerson(request, "验收多子女父亲", "male");
  const mother = await createPerson(request, "验收多子女母亲", "female");
  const childA = await createPerson(request, "验收多子女甲");
  const childB = await createPerson(request, "验收多子女乙");
  await createMarriage(request, father, mother);
  await openPerson(page, workspace.id, "验收多子女父亲");

  await selectChildrenAndPreview(page, ["验收多子女甲", "验收多子女乙"], "father");
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog.getByRole("checkbox")).toHaveCount(4);
  await expect(dialog.getByText("人工录入", { exact: true })).toHaveCount(2);
  await expect(dialog.getByText("系统自动补全", { exact: true })).toHaveCount(2);
  await confirmDialog(page);

  expect(await relatives(request, childA, ["parent"])).toHaveLength(2);
  expect(await relatives(request, childB, ["parent"])).toHaveLength(2);
});

test("自动关系可移除、更正并通过操作历史整体撤销", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-移除更正撤销");
  const father = await createPerson(request, "验收维护父亲", "male");
  const originalMother = await createPerson(request, "验收维护原母亲", "female");
  const replacementMother = await createPerson(request, "验收维护新母亲", "female");
  const child = await createPerson(request, "验收维护孩子");
  await createMarriage(request, father, originalMother);
  await createCompletedFamily(request, father, child, "father");
  await openPerson(page, workspace.id, "验收维护孩子");

  await page.getByRole("button", { name: "移除母亲 验收维护原母亲", exact: true }).click();
  await confirmDialog(page);
  expect((await relatives(request, child, ["parent"])).map(({ person }) => person.displayName)).toEqual(["验收维护父亲"]);
  expect(await relatives(request, father, ["spouse"])).toEqual([
    expect.objectContaining({ person: expect.objectContaining({ displayName: "验收维护原母亲" }) })
  ]);

  await undoMostRecentFromSettings(page, workspace.id);
  expect((await relatives(request, child, ["parent"])).map(({ person }) => person.displayName).sort()).toEqual(["验收维护原母亲", "验收维护父亲"]);

  await openPerson(page, workspace.id, "验收维护孩子");
  await page.getByRole("button", { name: "更正母亲 验收维护原母亲", exact: true }).click();
  await selectVisibleOption(page, "母亲更正为", "验收维护新母亲");
  await page.getByRole("button", { name: "预览母亲更正", exact: true }).click();
  await confirmDialog(page);
  expect((await relatives(request, child, ["parent"])).map(({ person }) => person.displayName).sort()).toEqual(["验收维护新母亲", "验收维护父亲"]);

  await undoMostRecentFromSettings(page, workspace.id);
  expect((await relatives(request, child, ["parent"])).map(({ person }) => person.displayName).sort()).toEqual(["验收维护原母亲", "验收维护父亲"]);
});

test("历史未完整父母关系只有确认批修复后才写入", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-历史批修复");
  const father = await createPerson(request, "验收修复父亲", "male");
  const mother = await createPerson(request, "验收修复母亲", "female");
  const child = await createPerson(request, "验收修复孩子");
  await createMarriage(request, father, mother);
  await createExplicitParent(request, father, child, "father");
  await openArea(page, workspace.id, "people");

  await page.getByRole("button", { name: "检查未完整父母关系", exact: true }).click();
  const panel = page.getByRole("region", { name: "检查未完整父母关系" });
  await expect(panel.getByText("可安全补全 1", { exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: "选择修复 验收修复孩子", exact: true })).toBeChecked();
  expect(await relatives(request, child, ["parent"])).toHaveLength(1);
  await panel.getByRole("button", { name: "生成修复预览", exact: true }).click();
  await confirmDialog(page);

  expect(await relatives(request, child, ["parent"])).toHaveLength(2);
});

test("批修复后家谱树不再把该家庭标为单亲", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-树完整度");
  const father = await createPerson(request, "验收树父亲", "male");
  const mother = await createPerson(request, "验收树母亲", "female");
  const child = await createPerson(request, "验收树孩子");
  await createMarriage(request, father, mother);
  await createExplicitParent(request, father, child, "father");

  await openTreeBranch(page, workspace.id, "验收树父亲");
  await expect(page.getByRole("group", { name: "家庭联合：单亲家庭" })).toHaveCount(1);
  await openArea(page, workspace.id, "people");
  await page.getByRole("button", { name: "检查未完整父母关系", exact: true }).click();
  const panel = page.getByRole("region", { name: "检查未完整父母关系" });
  await panel.getByRole("button", { name: "生成修复预览", exact: true }).click();
  await confirmDialog(page);

  await openTreeBranch(page, workspace.id, "验收树父亲");
  await expect(page.getByRole("group", { name: "家庭联合：单亲家庭" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "家庭联合：婚姻" })).toHaveCount(1);
});
