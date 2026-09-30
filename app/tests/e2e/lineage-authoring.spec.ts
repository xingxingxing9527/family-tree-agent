import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { addParentChild, addPerson, createWorkspace, openArea } from "./helpers/family-ui";

async function createLineage(page: Page, name: string, founder: string): Promise<void> {
  await page.getByLabel("支系名称").fill(name);
  await page.getByLabel("支系始祖").selectOption({ label: founder });
  await page.getByRole("button", { name: "创建支系" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function addMembership(page: Page, input: {
  lineage: string;
  person: string;
  role: "blood" | "associated";
  generation: string;
  marker: string;
  primary: boolean;
}): Promise<void> {
  await page.getByLabel("所属支系").selectOption({ label: input.lineage });
  await page.getByLabel("归属人物").selectOption({ label: input.person });
  await page.getByLabel("归属角色").selectOption(input.role);
  await page.getByLabel("声明世代").fill(input.generation);
  await page.getByLabel("字辈").fill(input.marker);
  if (input.primary) await page.getByLabel("设为主归属").check();
  await page.getByRole("button", { name: "添加归属" }).click();
  await expect(page.getByRole("listitem", { name: `${input.person}在${input.lineage}的归属` })).toBeVisible();
}

test("persists independent multi-lineage memberships and shows the primary marker in the tree", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "family-agent-lineages-"));
  const userData = join(root, "profile");
  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({ args: [resolve("out/main/index.js"), `--user-data-dir=${userData}`] });
    let window = await app.firstWindow();
    await createWorkspace(window, "支系验收谱册");
    await addPerson(window, { name: "林祖明", gender: "男", year: "1940", month: "1" });
    await addPerson(window, { name: "林子安", gender: "男", year: "1965", month: "2" });
    await addPerson(window, { name: "林旁支", gender: "女", year: "1968", month: "3" });
    await addParentChild(window, "林祖明", "林子安", "父亲");

    await openArea(window, "设置与数据");
    await createLineage(window, "长房", "林祖明");
    await createLineage(window, "二房", "林祖明");
    await addMembership(window, { lineage: "长房", person: "林子安", role: "blood", generation: "3", marker: "承", primary: true });
    await addMembership(window, { lineage: "二房", person: "林子安", role: "associated", generation: "5", marker: "世", primary: false });

    await app.close();
    app = await electron.launch({ args: [resolve("out/main/index.js"), `--user-data-dir=${userData}`] });
    window = await app.firstWindow();
    await window.getByRole("button", { name: /支系验收谱册/u }).click();
    await expect(window.locator(".workspace-identity strong")).toHaveText("支系验收谱册");
    await openArea(window, "设置与数据");

    const first = window.getByRole("listitem", { name: "林子安在长房的归属" });
    await expect(first).toContainText("主归属");
    await expect(first).toContainText("角色：血缘成员");
    await expect(first).toContainText("字辈：承");
    await expect(first).toContainText("世代冲突：声明第3代，计算第2代");

    const second = window.getByRole("listitem", { name: "林子安在二房的归属" });
    await expect(second).toContainText("角色：关联成员");
    await expect(second).toContainText("字辈：世");
    await expect(second).toContainText("世代：第5代（声明）");
    await expect(second).not.toContainText("主归属");

    await openArea(window, "家谱树");
    await expect(window.getByLabel("人物：林子安")).toContainText("字辈：承");
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
