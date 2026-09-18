import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect, _electron as electron, type Page } from "@playwright/test";

interface PersonFixture {
  name: string;
  gender: "男" | "女";
  year: string;
  month: string;
}

async function addPerson(window: Page, person: PersonFixture): Promise<void> {
  await window.getByRole("button", { name: "新增人物" }).click();
  await window.getByLabel("姓名").fill(person.name);
  await window.getByLabel("性别").selectOption({ label: person.gender });
  await window.getByLabel("出生日期历法").selectOption("solar");
  await window.getByLabel("出生年份").fill(person.year);
  await window.getByLabel("出生月份").fill(person.month);
  await window.getByLabel("来源说明").fill("五人家庭测试录入");
  await window.getByRole("button", { name: "保存人物" }).click();
  await expect(window.getByRole("heading", { name: person.name })).toBeVisible();
}

async function addParentChild(window: Page, parent: string, child: string, role: "父亲" | "母亲"): Promise<void> {
  await window.getByLabel("父母人物").selectOption({ label: parent });
  await window.getByLabel("子女人物").selectOption({ label: child });
  await window.getByLabel("父母角色").selectOption({ label: role });
  await window.getByLabel("亲子关系来源").fill("五人家庭测试录入");
  await window.getByRole("button", { name: "保存亲子关系" }).click();
  await expect(window.getByRole("status")).toContainText("亲子关系已保存");
}

async function expectCardAndFieldTextReadable(window: Page): Promise<void> {
  const result = await window.locator([
    ".person-card strong",
    ".person-card span",
    ".detail-card h2",
    ".detail-card h3",
    ".detail-card dt",
    ".detail-card dd",
    ".relationship-card h2",
    ".relationship-card h3",
    ".relationship-card label span",
    ".field-control"
  ].join(",")).evaluateAll((elements) => {
    type Color = [number, number, number, number];
    const parse = (value: string): Color => {
      const values = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1];
    };
    const composite = (front: Color, back: Color): Color => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      return [
        (front[0] * front[3] + back[0] * back[3] * (1 - front[3])) / alpha,
        (front[1] * front[3] + back[1] * back[3] * (1 - front[3])) / alpha,
        (front[2] * front[3] + back[2] * back[3] * (1 - front[3])) / alpha,
        alpha
      ];
    };
    const luminance = ([red, green, blue]: Color): number => {
      const channel = (value: number): number => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
    };
    const visible = elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const ratios = visible.map((element) => {
      const layers: Color[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) layers.unshift(parse(getComputedStyle(node).backgroundColor));
      let background: Color = [255, 255, 255, 1];
      for (const layer of layers) background = composite(layer, background);
      const foreground = composite(parse(getComputedStyle(element).color), background);
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    });
    return { count: ratios.length, minimum: Math.min(...ratios) };
  });
  expect(result.count).toBeGreaterThan(20);
  expect(result.minimum).toBeGreaterThanOrEqual(4.5);
}

test("persists a five-person household, correction, and divorce", async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), "family-agent-five-person-"));
  const app = await electron.launch({
    args: [resolve("out/main/index.js"), `--user-data-dir=${userData}`]
  });

  try {
    const window = await app.firstWindow();
    await window.getByLabel("谱册名称").fill("示例谱册");
    await window.getByRole("button", { name: "新建并打开谱册" }).click();
    await expect(window.getByRole("heading", { name: "示例谱册" })).toBeVisible();

    const people: PersonFixture[] = [
      { name: "张国强", gender: "男", year: "1960", month: "1" },
      { name: "李秀兰", gender: "女", year: "1962", month: "2" },
      { name: "张敏", gender: "女", year: "1988", month: "5" },
      { name: "张伟", gender: "男", year: "1990", month: "7" },
      { name: "张宁", gender: "女", year: "1993", month: "9" }
    ];
    for (const person of people) await addPerson(window, person);

    await window.getByLabel("配偶一").selectOption({ label: "张国强" });
    await window.getByLabel("配偶二").selectOption({ label: "李秀兰" });
    await window.getByLabel("结婚日期历法").selectOption("lunar");
    await window.getByLabel("结婚年份").fill("1986");
    await window.getByLabel("结婚月份").fill("8");
    await window.getByLabel("婚姻来源").fill("结婚证");
    await window.getByRole("button", { name: "保存婚姻" }).click();
    await expect(window.getByRole("status")).toContainText("婚姻已保存");

    for (const child of ["张敏", "张伟", "张宁"]) {
      await addParentChild(window, "张国强", child, "父亲");
      await addParentChild(window, "李秀兰", child, "母亲");
    }

    await window.reload();
    await expect(window.getByRole("heading", { name: "示例谱册" })).toBeVisible();
    for (const person of people) await expect(window.getByRole("button", { name: `查看${person.name}` })).toBeVisible();

    await window.getByRole("button", { name: "查看张敏" }).click();
    await expectCardAndFieldTextReadable(window);
    await window.getByRole("button", { name: "编辑人物" }).click();
    await window.getByLabel("出生月份").fill("6");
    await window.getByLabel("来源说明").fill("核对出生证");
    await window.getByRole("button", { name: "保存人物" }).click();
    await expect(window.getByText("公历 1988年6月", { exact: true })).toBeVisible();

    await window.getByRole("button", { name: "查看张国强" }).click();
    await expect(window.getByText("农历 1986年8月", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "登记离婚" }).click();
    await window.getByLabel("离婚日期历法").selectOption("solar");
    await window.getByLabel("离婚年份").fill("2001");
    await window.getByLabel("离婚月份").fill("3");
    await window.getByRole("button", { name: "确认离婚" }).click();

    await expect(window.getByText("已离婚", { exact: true })).toBeVisible();
    await expect(window.getByText("公历 2001年3月", { exact: true })).toBeVisible();

    await window.reload();
    await window.getByRole("button", { name: "查看张敏" }).click();
    await expect(window.getByText("公历 1988年6月", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "查看张国强" }).click();
    await expect(window.getByText("已离婚", { exact: true })).toBeVisible();
    await expect(window.getByText("公历 2001年3月", { exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
