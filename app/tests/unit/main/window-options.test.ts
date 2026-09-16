import { describe, expect, it } from "vitest";
import { createSecureWebPreferences } from "../../../src/main/security/window-options";

describe("createSecureWebPreferences", () => {
  it("isolates and sandboxes every renderer", () => {
    expect(createSecureWebPreferences("C:/app/preload.js")).toMatchObject({
      preload: "C:/app/preload.js",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    });
  });
});
