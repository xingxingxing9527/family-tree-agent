import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows beta packaging configuration", () => {
  const yaml = readFileSync(resolve("electron-builder.yml"), "utf8");
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts: Record<string, string>; directories?: unknown };

  it("builds a current-user NSIS x64 installer with a deterministic artifact name", () => {
    expect(yaml).toContain("guid: d1a51a1d-1566-5e0e-9cfa-31a4c775b234");
    expect(yaml).toMatch(/target:\s*\r?\n\s+- target: nsis\s*\r?\n\s+arch:\s*\r?\n\s+- x64/u);
    expect(yaml).toContain("artifactName: family-agent-${version}-win-${arch}.${ext}");
    expect(yaml).toMatch(/nsis:\s*\r?\n(?:\s+.*\r?\n)*?\s+perMachine: false/u);
    expect(yaml).toMatch(/nsis:\s*\r?\n(?:\s+.*\r?\n)*?\s+oneClick: false/u);
    expect(yaml).toContain("allowToChangeInstallationDirectory: true");
    expect(yaml).toContain("createStartMenuShortcut: false");
    expect(yaml).toContain("deleteAppDataOnUninstall: false");
  });

  it("includes production output, rebuilds/unpacks native SQLite, and excludes release-only hazards", () => {
    expect(yaml).toContain("npmRebuild: false");
    expect(yaml).toMatch(/files:\s*\r?\n\s+- out\/\*\*/u);
    expect(yaml).toMatch(/asarUnpack:\s*\r?\n\s+- node_modules\/better-sqlite3\/\*\*/u);
    for (const exclusion of [
      "tests/**",
      "node_modules/**/test/**",
      "node_modules/**/tests/**",
      "node_modules/**/__tests__/**",
      "**/*.map",
      "**/.env*",
      "**/*.sqlite*",
      "coverage/**",
      "release/**"
    ]) {
      expect(yaml).toContain(`- \"!${exclusion}\"`);
    }
    expect(packageJson.scripts["postinstall"]).toBe("electron-builder install-app-deps");
    expect(packageJson.scripts["performance"]).toBe("tsx scripts/run-performance-gates.ts");
    expect(packageJson.scripts["smoke:packaged"]).toBe("tsx scripts/smoke-packaged-app.ts");
    expect(packageJson.directories).toBeUndefined();
  });
});
