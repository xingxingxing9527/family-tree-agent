import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, _electron as electron } from "@playwright/test";
import { addParentChild, addPerson, createWorkspace, openArea } from "./helpers/family-ui";

test("keeps local entry, import, tree and deterministic kinship usable when the model is unavailable", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "family-agent-model-outage-"));
  const csvPath = join(root, "offline-people.csv");
  await writeFile(csvPath, [
    "person_external_id,name,gender,birth_calendar,birth_year,birth_month,birth_day,birth_leap_month,notes",
    "offline-1,表格成员,female,solar,2000,4,,false,离线导入"
  ].join("\n"), "utf8");
  const app = await electron.launch({
    args: [resolve("out/main/index.js"), `--user-data-dir=${join(root, "profile")}`],
    env: { ...process.env, FAMILY_AGENT_E2E_IMPORT_PATH: csvPath }
  });

  try {
    const window = await app.firstWindow();
    await createWorkspace(window, "离线谱册");
    await addPerson(window, { name: "离线父亲", gender: "男", year: "1970", month: "1" });
    await addPerson(window, { name: "离线女儿", gender: "女", year: "1995", month: "2" });
    await addParentChild(window, "离线父亲", "离线女儿", "父亲");

    await openArea(window, "家谱树");
    await window.getByLabel("共享当前视角").selectOption({ label: "离线父亲" });
    await expect(window.locator(".tree-person-node").filter({ hasText: "离线女儿" })).toContainText("女儿");

    const chat = window.getByRole("complementary", { name: "家谱问答" });
    await chat.getByRole("button", { name: "成员统计" }).click();
    await chat.getByRole("button", { name: "发送" }).click();
    await window.getByRole("button", { name: "同意并发送" }).click();
    const outage = chat.getByRole("alert");
    await expect(outage).toHaveText("在线模型当前不可用，结构化浏览仍可使用。");
    expect(await outage.textContent()).not.toMatch(/api.?key|stack|\\|\.sqlite|select /iu);

    await openArea(window, "录入中心");
    await window.getByRole("button", { name: "表格导入" }).click();
    await window.getByRole("button", { name: "选择导入文件" }).click();
    await expect(window.getByLabel("已选导入文件")).toHaveText("offline-people.csv");
    await window.getByLabel("来源键").fill("offline-e2e");
    await window.getByRole("button", { name: "解析并预览" }).click();
    await expect(window.getByRole("region", { name: "导入预览" })).toContainText("新增 1");
    await window.getByLabel("我已核对变更和问题，并确认写入所选行").check();
    await window.getByRole("button", { name: "确认导入 1 行" }).click();
    await expect(window.getByRole("region", { name: "导入报告" })).toContainText("已写入 1 行");

    await openArea(window, "人物库");
    await expect(window.getByRole("button", { name: "查看表格成员" })).toBeVisible();
    await expect(window.getByRole("button", { name: "查看离线父亲" })).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
