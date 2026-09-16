import { test, expect, _electron as electron } from "@playwright/test";
import { resolve } from "node:path";

test("launches with an isolated desktop API", async () => {
  const app = await electron.launch({ args: [resolve("out/main/index.js")] });

  try {
    const window = await app.firstWindow();
    const heading = window.getByRole("heading", { name: "家谱智能体" });
    const bodyCopy = window.getByText("欢迎使用家谱智能体。");

    await expect(window).toHaveTitle("家谱智能体");
    await expect(heading).toBeVisible();
    await expect(bodyCopy).toBeVisible();
    expect(await window.evaluate(() => {
      const element = document.querySelector("p")!;
      const parseColor = (value: string): [number, number, number, number] => {
        const values = value.match(/[\d.]+/g)!.map(Number);
        return [values[0], values[1], values[2], values[3] ?? 1];
      };
      const composite = (
        foreground: [number, number, number, number],
        background: [number, number, number, number]
      ): [number, number, number, number] => {
        const alpha = foreground[3] + background[3] * (1 - foreground[3]);
        return [
          (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
          (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
          (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
          alpha
        ];
      };
      const luminance = ([red, green, blue]: [number, number, number, number]): number => {
        const channel = (value: number) => {
          const normalized = value / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
      };

      const layers: [number, number, number, number][] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        layers.unshift(parseColor(getComputedStyle(node).backgroundColor));
      }
      let background: [number, number, number, number] = [255, 255, 255, 1];
      for (const layer of layers) {
        background = composite(layer, background);
      }

      const foreground = composite(parseColor(getComputedStyle(element).color), background);
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    })).toBeGreaterThanOrEqual(4.5);
    expect(await window.evaluate(() => typeof window.desktopApi.app.getVersion)).toBe("function");
    expect(await window.evaluate(() => typeof window.require)).toBe("undefined");
    expect(await window.evaluate(() => typeof window.process)).toBe("undefined");
  } finally {
    await app.close();
  }
});
