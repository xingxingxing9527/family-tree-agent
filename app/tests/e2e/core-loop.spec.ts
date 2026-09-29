import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, _electron as electron } from "@playwright/test";
import { addMarriage, addParentChild, addPerson, chooseSearchResult, createWorkspace, openArea, type PersonFixture } from "./helpers/family-ui";

test("completes the confirmed genealogy core loop without a live model call", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "family-agent-core-loop-"));
  const userData = join(root, "profile");
  const backupPath = join(root, "verified-family.zip");
  const app = await electron.launch({
    args: [resolve("out/main/index.js"), `--user-data-dir=${userData}`],
    env: { ...process.env, FAMILY_AGENT_E2E_CHAT: "1", FAMILY_AGENT_E2E_BACKUP_PATH: backupPath }
  });

  try {
    const window = await app.firstWindow();
    await createWorkspace(window, "核心环谱册");
    const people: PersonFixture[] = [
      { name: "张国强", gender: "男", year: "1960", month: "1" },
      { name: "李秀兰", gender: "女", year: "1962", month: "2" },
      { name: "张敏", gender: "女", year: "1988", month: "5" },
      { name: "张伟", gender: "男", year: "1990", month: "7" },
      { name: "张宁", gender: "女", year: "1993", month: "9" }
    ];
    for (const person of people) await addPerson(window, person);
    await addMarriage(window, "张国强", "李秀兰");
    for (const child of ["张敏", "张伟", "张宁"]) {
      await addParentChild(window, "张国强", child, "父亲");
      await addParentChild(window, "李秀兰", child, "母亲");
    }

    await openArea(window, "家谱树");
    await window.getByLabel("共享当前视角").selectOption({ label: "张国强" });
    const childNode = window.locator(".tree-person-node").filter({ hasText: "张敏" });
    await expect(childNode).toContainText("女儿");
    await expect(window.getByLabel("家庭联合：婚姻")).toBeVisible();

    await chooseSearchResult(window, "张敏", "张敏");
    const chat = window.getByRole("complementary", { name: "家谱问答" });
    await chat.getByRole("button", { name: "关系查询" }).click();
    await chat.getByRole("button", { name: "发送" }).click();
    await window.getByRole("button", { name: "同意并发送" }).click();
    await expect(chat.getByText("女儿；关系路径已列出。")).toBeVisible();
    await expect(chat.getByText(/ → /u)).toBeVisible();
    expect(await chat.locator("section ul li").count()).toBeGreaterThan(0);

    await chooseSearchResult(window, "张国强", "张国强");
    await chat.getByRole("button", { name: "成员统计" }).click();
    await chat.getByRole("button", { name: "发送" }).click();
    await window.getByRole("button", { name: "同意并发送" }).click();
    await expect(chat.getByText("已确认的子女共有 3 人。")).toBeVisible();

    await window.getByRole("button", { name: "查看张敏" }).click();
    await window.getByRole("button", { name: "编辑人物" }).click();
    await window.getByLabel("出生月份").fill("6");
    await window.getByLabel("来源说明").fill("核对出生证明");
    await window.getByRole("button", { name: "保存人物" }).click();
    await expect(window.getByText("公历 1988年6月", { exact: true })).toBeVisible();

    await openArea(window, "设置与数据");
    await expect(window.getByText(/person\.update ·/u).first()).toBeVisible();
    await window.getByRole("button", { name: "创建备份" }).click();
    await expect(window.getByText("备份已创建并验证", { exact: true })).toBeVisible();
    expect((await stat(backupPath)).size).toBeGreaterThan(0);

    await window.reload();
    await openArea(window, "人物库");
    await window.getByRole("button", { name: "查看张敏" }).click();
    await expect(window.getByText("公历 1988年6月", { exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
