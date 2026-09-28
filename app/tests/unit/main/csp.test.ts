import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("desktop CSP", () => {
  it("allows app-media only for image and media sources", () => {
    const html = readFileSync(fileURLToPath(new URL("../../../src/renderer/index.html", import.meta.url)), "utf8");
    const policy = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
    expect(policy).toContain("img-src 'self' data: app: app-media:");
    expect(policy).toContain("media-src 'self' app: app-media:");
    expect(policy).not.toMatch(/default-src[^;]*app-media:|script-src[^;]*app-media:|connect-src[^;]*app-media:/);
  });
});
