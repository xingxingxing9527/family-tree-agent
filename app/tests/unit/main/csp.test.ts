import { describe, expect, it } from "vitest";
import { desktopContentSecurityPolicy } from "../../../src/main/security/content-security-policy";

describe("desktop CSP", () => {
  it("allows app-media only for image and media sources", () => {
    expect(desktopContentSecurityPolicy).toContain("img-src 'self' data: app: app-media:");
    expect(desktopContentSecurityPolicy).toContain("media-src 'self' app: app-media:");
    expect(desktopContentSecurityPolicy).not.toMatch(/default-src[^;]*app-media:|script-src[^;]*app-media:|connect-src[^;]*app-media:/);
  });
});
